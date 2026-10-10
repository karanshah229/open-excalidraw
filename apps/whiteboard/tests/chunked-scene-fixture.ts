/** Emulator-only adversarial protocol fixture; not bundled with the app. */
import { doc, getDocFromServer, setDoc, updateDoc, Timestamp, serverTimestamp } from 'firebase/firestore'
import { projectCall } from '../src/features/sharing/project-service'
import { getFirebaseApp, getFirebaseAuth, getFirestoreDb } from '../src/lib/firebase'
import { packScene, paginateReferences, manifestDigest } from '../../../functions/src/scene-codec'

function environment() {
  const app = getFirebaseApp()!
  if (
    import.meta.env.VITE_USE_FIREBASE_EMULATOR !== 'true' ||
    app.options.projectId !== 'demo-regression' ||
    !['localhost', '127.0.0.1'].includes(location.hostname)
  )
    throw new Error('Requires demo regression emulators.')
  return { app, db: getFirestoreDb()!, uid: getFirebaseAuth()!.currentUser?.uid ?? '' }
}
export async function stageScene(boardId: string, scene: any, base?: { headRevisionId: string; generation: number }) {
  await getFirebaseAuth()!.authStateReady()
  const { db, uid } = environment()
  const head = base ?? (await getDocFromServer(doc(db, 'boardScenes', boardId))).data()!
  const commitId = crypto.randomUUID()
  const chunks = await packScene(scene)
  const refs = chunks.map((chunk, slot) => ({
    chunkId: `${commitId}_${String(slot).padStart(6, '0')}`,
    digest: chunk.digest,
  }))
  const pages = paginateReferences(refs)
  try {
    await setDoc(doc(db, 'boardScenes', boardId, 'uploads', commitId), {
      uploaderUid: uid,
      expectedHeadRevisionId: head.headRevisionId,
      generation: head.generation,
      sceneFormatVersion: 1,
      pageCount: pages.length,
      chunkCount: refs.length,
      newChunkCount: refs.length,
      candidateDigest: await manifestDigest(refs, head.generation),
      createdAt: serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + 600000),
    })
  } catch (error) {
    const current = (await getDocFromServer(doc(db, 'boardScenes', boardId))).data()
    throw Object.assign(
      new Error(
        JSON.stringify({
          code: (error as any).code,
          uid,
          expected: head.headRevisionId,
          current: current?.headRevisionId,
          generation: head.generation,
          currentGeneration: current?.generation,
          now: Date.now(),
        }),
      ),
      { code: (error as any).code },
    )
  }
  for (let slot = 0; slot < chunks.length; slot++)
    await setDoc(doc(db, 'boardScenes', boardId, 'chunks', refs[slot].chunkId), {
      payload: chunks[slot].payload,
      digest: chunks[slot].digest,
      uploadId: commitId,
      slot,
      uploaderUid: uid,
      generation: head.generation,
      kind: 'records',
    })
  for (let index = 0; index < pages.length; index++)
    await setDoc(doc(db, 'boardScenes', boardId, 'uploads', commitId, 'pages', String(index).padStart(6, '0')), {
      references: pages[index],
    })
  return { boardId, commitId, refs }
}
export async function commitCandidate(candidate: { boardId: string; commitId: string }) {
  environment()
  return projectCall('commitBoardScene', { boardId: candidate.boardId, commitId: candidate.commitId })
}
export async function forbiddenHeadWrite(boardId: string) {
  const { db } = environment()
  await updateDoc(doc(db, 'boardScenes', boardId), { headRevisionId: 'unauthorized-head' })
}
export async function forbiddenChunkRewrite(boardId: string, chunkId: string) {
  const { db } = environment()
  await updateDoc(doc(db, 'boardScenes', boardId, 'chunks', chunkId), { payload: '[]' })
}
export async function readChunk(boardId: string, chunkId: string) {
  const { db } = environment()
  return (await getDocFromServer(doc(db, 'boardScenes', boardId, 'chunks', chunkId))).data()
}

export async function signInExistingOwner(email: string) {
  const { signInWithEmailAndPassword } = await import('firebase/auth')
  const { workspaceApi } = await import('../src/features/workspace/workspace-api')
  environment()
  const credential = await signInWithEmailAndPassword(getFirebaseAuth()!, email, 'fixture-password')
  await workspaceApi.activateCloudWorkspace(credential.user.uid)
}
export async function localBoard(boardId: string) {
  environment()
  const { workspaceStore } = await import('../src/features/workspace/workspace-api')
  return workspaceStore.loadBoard(boardId)
}

/** Deterministic interleavings at the local persistence boundary, no cloud writes. */
export async function storageRaceChecks() {
  environment()
  const { workspaceStore } = await import('../src/features/workspace/workspace-api')
  const id = `cas_${crypto.randomUUID()}`
  const timestamp = new Date().toISOString()
  const scene = (x: number, version: number) => ({
    elements: [{ id: 'shape', type: 'rectangle', x, version, versionNonce: 1 }],
    appState: { name: `state-${x}` },
  })
  const seed: any = {
    id,
    projectId: 'cas-project',
    name: 'CAS fixture',
    scene: scene(1, 1),
    active: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
    baseRevision: 1,
    syncStatus: 'synced',
    syncAttempts: 0,
    nextSyncAt: null,
    lastSyncError: null,
    cloudRevisionId: 'R0',
    cloudGeneration: 1,
  }
  const ensure = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message)
  }
  await workspaceStore.upsertProject({
    id: 'cas-project',
    name: 'Local CAS fixture',
    deletedAt: timestamp,
    ownerId: getFirebaseAuth()!.currentUser!.uid,
    members: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  await workspaceStore.upsertBoard(seed)
  await workspaceStore.acknowledgeBoardScene(id, 1, scene(2, 2), 'R2', 1, { expectedCloudRevisionId: 'R0' })
  await workspaceStore.applyCloudBoardScene(id, scene(1, 1), 'R1', 1, { expectedCloudRevisionId: 'R0' })
  let current = (await workspaceStore.loadBoard(id))!
  ensure(
    current.cloudRevisionId === 'R2' && current.scene.elements[0].x === 2,
    'Delayed hydration rolled back a newer ACK',
  )
  await workspaceStore.upsertBoardMetadata({ ...seed, name: 'Remote metadata', scene: { elements: [], appState: {} } })
  current = (await workspaceStore.loadBoard(id))!
  ensure(
    current.cloudRevisionId === 'R2' && current.scene.elements[0].x === 2,
    'Metadata delivery overwrote durable scene state',
  )
  await workspaceStore.upsertBoard({ ...current, cloudScenePending: true, scene: { elements: [], appState: {} } })
  await workspaceStore.applyCloudBoardScene(id, scene(2, 2), 'R2', 1, { expectedCloudRevisionId: 'R2' })
  current = (await workspaceStore.loadBoard(id))!
  ensure(
    !current.cloudScenePending && current.scene.elements[0]?.x === 2,
    'Equal-head metadata placeholder was never hydrated',
  )
  const revision = current.revision
  await workspaceStore.acknowledgeBoardScene(id, revision, scene(3, 3), 'R3', 1, { expectedCloudRevisionId: 'R2' })
  await workspaceStore.acknowledgeBoardScene(id, revision, scene(2, 2), 'R2', 1, { expectedCloudRevisionId: 'R2' })
  current = (await workspaceStore.loadBoard(id))!
  ensure(
    current.cloudRevisionId === 'R3' && current.scene.elements[0].x === 3 && current.scene.appState.name === 'state-3',
    'Late ACK rolled back a newer committed head',
  )
  await workspaceStore.upsertBoard({ ...current, revision: revision + 1, syncStatus: 'conflict', scene: scene(4, 4) })
  await workspaceStore.updateBoardSyncStatus(id, 'conflict')
  await workspaceStore.acknowledgeBoardScene(id, revision, scene(3, 3), 'R3', 1, { expectedCloudRevisionId: 'R3' })
  current = (await workspaceStore.loadBoard(id))!
  ensure(
    current.syncStatus === 'conflict' && current.scene.elements[0].x === 4,
    'Late ACK erased explicit recovery state',
  )
  await workspaceStore.upsertBoard(seed)
  await Promise.all([
    workspaceStore.saveBoard({
      ...seed,
      scene: {
        elements: [
          { ...scene(1, 1).elements[0], version: 10, isDeleted: true },
          { id: 'new-a', version: 1 },
        ],
        appState: {},
      },
    }),
    workspaceStore.saveBoard({
      ...seed,
      scene: { elements: [...scene(1, 1).elements, { id: 'new-b', version: 1 }], appState: {} },
    }),
  ])
  current = (await workspaceStore.loadBoard(id))!
  ensure(
    current.revision === 3 &&
      ['new-a', 'new-b'].every((id) => current.scene.elements.some((element) => element.id === id)),
    'Concurrent same-base local saves lost an element or revision',
  )
  ensure(
    current.scene.elements.find((element) => element.id === 'shape')?.isDeleted === true,
    'Concurrent stale local save resurrected a tombstone',
  )
  await workspaceStore.acknowledgeBoardScene(id, 2, scene(1, 1), 'R1', 1, { expectedCloudRevisionId: 'R0' })
  current = (await workspaceStore.loadBoard(id))!
  ensure(
    current.revision === 3 &&
      current.syncStatus === 'local-only' &&
      current.scene.elements.some((element) => element.id === 'new-b'),
    'Late upload ACK erased a newer local save',
  )
  await workspaceStore.updateBoardSyncStatus(id, 'conflict') // Keep this isolated fixture out of the cloud queue.
  return [
    'same-base local save union and tombstone',
    'late upload retains pending local revision',
    'stale hydration CAS',
    'metadata preserves scene',
    'equal-head placeholder hydration',
    'late ACK preserves newer head',
    'conflict retains draft',
  ]
}

/** Trace real subscription boundaries without changing data or callbacks. */
export async function traceSceneSubscriptions() {
  const { sceneService } = await import('../src/features/scenes/scene-service')
  const { sharingService } = await import('../src/features/sharing/sharing-service')
  const { workspaceApi } = await import('../src/features/workspace/workspace-api')
  const trace: any[] = []
  ;(window as any).__sceneTrace = trace
  const shape = (scene: any) => {
    const e = scene?.elements?.find((e: any) => e.id === 'large-0')
    return e ? { x: e.x, version: e.version, nonce: e.versionNonce } : null
  }
  const sharedLoad = sharingService.getSharedBoard.bind(sharingService)
  sharingService.getSharedBoard = async (...args) => {
    const result = await sharedLoad(...args)
    trace.push({
      type: 'shared-load',
      boardId: args[0],
      status: result.status,
      head: result.config?.sceneRevisionId,
      shape: shape(result.config?.scene),
    })
    return result
  }
  const headSubscribe = sceneService.subscribeHead.bind(sceneService)
  sceneService.subscribeHead = (boardId, callback, onError) => {
    trace.push({ type: 'head-attach', boardId })
    return headSubscribe(
      boardId,
      () => {
        trace.push({ type: 'head-event', boardId })
        callback()
      },
      (error) => {
        trace.push({ type: 'head-error', boardId, code: (error as any)?.code })
        onError?.(error)
      },
    )
  }
  const sharedSubscribe = sharingService.subscribeToSharedBoard.bind(sharingService)
  sharingService.subscribeToSharedBoard = (boardId, callback, ...rest) =>
    sharedSubscribe(
      boardId,
      (config) => {
        trace.push({ type: 'shared-callback', boardId, head: config.sceneRevisionId, shape: shape(config.scene) })
        callback(config)
      },
      ...rest,
    )
  const privateSubscribe = workspaceApi.subscribeToCloudScene.bind(workspaceApi)
  workspaceApi.subscribeToCloudScene = (boardId, callback, onError) =>
    privateSubscribe(
      boardId,
      (document) => {
        trace.push({ type: 'private-callback', boardId, head: document.cloudRevisionId, shape: shape(document.scene) })
        callback(document)
      },
      onError,
    )
}
