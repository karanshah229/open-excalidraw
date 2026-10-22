import { boardHistoryStore, type CommittedBoardContent, type HistoryOutboxEntry, type HistoryReceipt } from '@agentic-whiteboard/storage'
import { doc, getDocFromServer, serverTimestamp, setDoc, Timestamp, type DocumentReference } from 'firebase/firestore'
import { getFirebaseAuth, getFirestoreDb } from '../../lib/firebase'
import { restoreSceneAssets, storeSceneAssets } from '../assets/scene-assets'
import { readHistorySnapshot } from '../history/history-service'
import { assertHistoryMutationAllowed, historyEditingState } from '../history/history-editing-gate'
import { projectCall } from '../sharing/project-service'
import { sceneService, SceneGenerationError, type LoadedScene, type SceneHead } from '../scenes/scene-service'
import {
  canonicalStringify, chunkDocumentBytes, digestString, manifestDigest, packScene, paginateReferences, SCENE_FORMAT_VERSION,
} from '../../../../../functions/src/scene-codec'

type SyncOptions = {
  boardId: string
  projectId?: string
  assetRoot: string
  /** Workspace caller supplies the usual scene ACK path; shared editors use the default. */
  applyHead?: (snapshot: CommittedBoardContent, entry: HistoryOutboxEntry) => Promise<LoadedScene>
  /** Legacy name writes use owned metadata rather than unavailable history CAS. */
  applyLegacyName?: (snapshot: CommittedBoardContent) => Promise<void>
}
const active = new Map<string, Promise<LoadedScene | null>>()
const pageId = (slot: number) => String(slot).padStart(6, '0')

/** Aborted restore advances its fence but leaves committed drafts and captures intact. */
export async function refreshHistoryFence(boardId: string, generation: number, fence: number): Promise<void> {
  const current = await boardHistoryStore.getCommittedContent(boardId)
  if (!current) return
  if ((current.document.cloudGeneration ?? current.version.generation) !== generation) throw new SceneGenerationError()
  await boardHistoryStore.setRestoreFence(boardId, fence, false)
  for (const entry of await boardHistoryStore.listOutbox(boardId)) {
    if (entry.retryState === 'blocked') continue
    if (entry.generation !== generation || entry.expectedFence === fence) continue
    const accepted = await projectCall<{ receipt: (HistoryReceipt & { generation: number }) | null }>('boardHistory', {
      boardId, operation: 'receipt', captureMutationId: entry.captureMutationId,
    })
    if (accepted.receipt) {
      if (accepted.receipt.generation !== generation) throw new SceneGenerationError()
      await boardHistoryStore.acknowledge(boardId, entry.localVersionId, {
        localSnapshotVersionId: accepted.receipt.localSnapshotVersionId,
        canonicalVersionId: accepted.receipt.canonicalVersionId ?? undefined,
        acceptedAt: accepted.receipt.acceptedAt, expiresAt: accepted.receipt.expiresAt,
      })
    }
    const pending = (await boardHistoryStore.listOutbox(boardId)).find((item) => item.localVersionId === entry.localVersionId)
    if (pending) await boardHistoryStore.reauthorizeOutbox(boardId, pending.localVersionId, {
      expectedFence: fence, resolvedHeadMutationId: pending.headMutationId,
    })
  }
}

async function existingStage(ref: DocumentReference) {
  try { return await getDocFromServer(ref) } catch (error) {
    // Missing private staging documents have no resource owner for read rules.
    // The subsequent create still verifies access and cannot overwrite an owner.
    if ((error as { code?: string }).code === 'permission-denied') return null
    throw error
  }
}

function checkedIdentity(uid: string, boardId: string, epoch: number) {
  if (getFirebaseAuth()?.currentUser?.uid !== uid) throw new Error('Account changed during history sync.')
  assertHistoryMutationAllowed(boardId, epoch)
}

/** Normalize local bytes to the same complete cloud tuple, including image locators. */
function sameTuple(local: CommittedBoardContent, scene: LoadedScene['scene'], name: string, notes: Record<string, string>) {
  // Callers first pass local files through storeSceneAssets, which strips their
  // bytes while preserving the exact persisted descriptor shape. Do not
  // normalize missing dataURL fields to empty strings here: the server's
  // canonical alias check compares the immutable snapshots byte-for-byte, and
  // masking that distinction can turn a valid branch capture into a rejected
  // alias.
  return canonicalStringify({ scene: local.document.scene, name: local.document.name, notes: local.notes }) ===
    canonicalStringify({ scene, name, notes })
}

function historicalUnavailable(error: unknown) {
  const code = (error as { code?: string } | null)?.code ?? ''
  return ['functions/not-found', 'functions/failed-precondition', 'functions/resource-exhausted'].includes(code) ||
    (error instanceof Error && /no validated cloud history base|local parent before/.test(error.message))
}

async function blockHistoricalCapture(boardId: string, localVersionId: string, error: unknown) {
  await boardHistoryStore.markOutboxBlocked(boardId, localVersionId,
    error instanceof Error ? error.message : 'Historical snapshot upload is blocked.')
  window.dispatchEvent(new CustomEvent('board-history-sync-status', { detail: { boardId, localVersionId, status: 'blocked' } }))
}

async function importSnapshot(options: SyncOptions, snapshot: CommittedBoardContent, entry: HistoryOutboxEntry,
  uid: string, epoch: number, canonicalVersionId?: string): Promise<void> {
  const db = getFirestoreDb()
  if (!db) throw new Error('Cloud history is not configured.')
  checkedIdentity(uid, options.boardId, epoch)
  const accepted = await projectCall<{ receipt: (HistoryReceipt & { generation: number }) | null }>('boardHistory', {
    boardId: options.boardId, operation: 'receipt', captureMutationId: entry.captureMutationId,
  })
  if (accepted.receipt) {
    checkedIdentity(uid, options.boardId, epoch)
    if (accepted.receipt.generation !== entry.generation) throw new SceneGenerationError()
    await boardHistoryStore.acknowledge(options.boardId, entry.localVersionId, {
      localSnapshotVersionId: accepted.receipt.localSnapshotVersionId,
      canonicalVersionId: accepted.receipt.canonicalVersionId ?? undefined,
      acceptedAt: accepted.receipt.acceptedAt, expiresAt: accepted.receipt.expiresAt,
    })
    return
  }
  let publication = entry.importPublication
  if (!publication) {
    const parent = snapshot.version.parentLocalVersionId
      ? await boardHistoryStore.get(options.boardId, snapshot.version.parentLocalVersionId) : null
    const parentPublication = parent?.version.receipt && !parent.version.receipt.canonicalVersionId
      ? await boardHistoryStore.getImportPublication(options.boardId, parent.version.localVersionId) : undefined
    const sourceBaseVersionId = canonicalVersionId ?? parentPublication?.sourceBaseVersionId ?? parent?.version.receipt?.canonicalVersionId ?? entry.sourceBaseVersionId
    if (!sourceBaseVersionId) throw new Error('The local save has no validated cloud history base.')
    if (!canonicalVersionId && parent && parent.version.uploadStatus === 'pending')
      throw new Error('Upload the local parent before its history descendant.')
    publication = {
      sourceBaseVersionId,
      parentVersionId: !canonicalVersionId && parentPublication ? parent!.version.receipt!.localSnapshotVersionId : sourceBaseVersionId,
      localBranchId: !canonicalVersionId && parentPublication ? parentPublication.localBranchId : snapshot.version.localVersionId,
      branchSequence: !canonicalVersionId && parentPublication ? parentPublication.branchSequence + 1 : 1,
      commitId: entry.captureMutationId,
    }
    await boardHistoryStore.prepareImport(options.boardId, entry.localVersionId, publication)
  }
  // A canonical alias authorizes bytes against its exact target even when an
  // earlier persisted import attempt retained now-expired provenance ancestry.
  const byteBaseVersionId = canonicalVersionId ?? publication.parentVersionId
  const currentParent = canonicalVersionId
    ? await readHistorySnapshot(options.boardId, undefined, false) : null
  const parent = currentParent?.entry.id === byteBaseVersionId ? currentParent
    : await readHistorySnapshot(options.boardId, byteBaseVersionId, false)
  if (parent.generation !== entry.generation) throw new SceneGenerationError()
  checkedIdentity(uid, options.boardId, epoch)
  const scene = await storeSceneAssets(snapshot.document.scene, options.assetRoot, options.projectId, {
    expectedGeneration: entry.generation, expectedFence: entry.expectedFence,
  })
  const packed = await packScene(scene, parent.chunks)
  const previousIds = new Set(parent.chunks.map((chunk) => chunk.chunkId))
  let slot = 0
  const chunks = packed.map((chunk) => previousIds.has(chunk.chunkId) ? chunk : {
    ...chunk, chunkId: `${publication!.commitId}_${pageId(slot++)}`,
  })
  const references = chunks.map(({ chunkId, digest }) => ({ chunkId, digest }))
  const pages = paginateReferences(references)
  if (pages.length > 6 || chunks.length > 512 ||
    chunks.reduce((total, chunk) => total + chunkDocumentBytes(chunk.payload), 0) > 64 * 1024 * 1024)
    throw new Error('The local history version exceeds the cloud scene budget.')
  const fresh = chunks.filter((chunk) => !previousIds.has(chunk.chunkId))
  const candidateDigest = await manifestDigest(references, entry.generation)
  const candidateRef = doc(db, 'boardScenes', options.boardId, 'uploads', publication.commitId)
  const existing = await existingStage(candidateRef)
  if (existing?.exists()) {
    if (existing.data().expiresAt?.toMillis?.() <= Date.now()) {
      await boardHistoryStore.reauthorizeOutbox(options.boardId, entry.localVersionId, {
        expectedFence: entry.expectedFence, resolvedHeadMutationId: entry.headMutationId,
      })
      const retry = (await boardHistoryStore.listOutbox(options.boardId)).find((item) => item.localVersionId === entry.localVersionId)
      if (!retry) return
      return importSnapshot(options, snapshot, retry, uid, epoch, canonicalVersionId)
    }
    if (existing.data().candidateDigest !== candidateDigest || existing.data().generation !== entry.generation ||
      existing.data().expectedFence !== entry.expectedFence)
      throw new Error('The original history upload requires receipt resolution before another attempt.')
  } else {
    const head = await sceneService.load(options.boardId)
    if (!head || head.generation !== entry.generation) throw new SceneGenerationError()
    const currentHead = await getDocFromServer(doc(db, 'boardScenes', options.boardId))
    if (!currentHead.exists()) throw new Error('Board scene head disappeared during history upload.')
    checkedIdentity(uid, options.boardId, epoch)
    await setDoc(candidateRef, {
      uploaderUid: uid, purpose: 'history-only', expectedFence: entry.expectedFence,
      maintenanceEpoch: currentHead.data().maintenanceEpoch ?? 1,
      sourceBaseVersionId: publication.sourceBaseVersionId,
      expectedHeadRevisionId: head.revisionId, generation: entry.generation, sceneFormatVersion: SCENE_FORMAT_VERSION,
      pageCount: pages.length, chunkCount: chunks.length, newChunkCount: fresh.length, candidateDigest,
      createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 23 * 60 * 60 * 1000),
    })
  }
  // Staging is bounded and resumable. Its identity is persisted before network
  // transfer, so reloads cannot create another accepted capture or extend expiry.
  for (let offset = 0; offset < fresh.length; offset += 4) {
    await Promise.all(fresh.slice(offset, offset + 4).map(async (chunk, index) => {
      checkedIdentity(uid, options.boardId, epoch)
      const ref = doc(db, 'boardScenes', options.boardId, 'chunks', chunk.chunkId)
      const existing = await existingStage(ref)
      if (existing?.exists()) {
        if (existing.data().digest !== chunk.digest || existing.data().uploadId !== publication!.commitId)
          throw new Error('History chunk upload identity conflict.')
        return
      }
      await setDoc(ref, { payload: chunk.payload, digest: chunk.digest, uploadId: publication!.commitId,
        slot: offset + index, uploaderUid: uid, generation: entry.generation, kind: 'records' })
    }))
  }
  for (let page = 0; page < pages.length; page++) {
    checkedIdentity(uid, options.boardId, epoch)
    const ref = doc(db, 'boardScenes', options.boardId, 'uploads', publication.commitId, 'pages', pageId(page))
    const existing = await getDocFromServer(ref)
    if (!existing.exists()) await setDoc(ref, { references: pages[page] })
    else if (canonicalStringify(existing.data().references) !== canonicalStringify(pages[page]))
      throw new Error('History page upload identity conflict.')
  }
  const result = await projectCall<HistoryReceipt>('importBoardVersion', {
    boardId: options.boardId, commitId: publication.commitId, captureMutationId: entry.captureMutationId,
    ...(canonicalVersionId ? { canonicalVersionId } : {}),
    sourceBaseVersionId: publication.sourceBaseVersionId, parentVersionId: publication.parentVersionId,
    localBranchId: publication.localBranchId, branchSequence: publication.branchSequence,
    boardName: snapshot.document.name, capturedAt: snapshot.version.capturedAt,
    notes: Object.fromEntries(Object.entries(snapshot.notes).map(([id, text]) => [id, { text, revision: 0 }])),
  })
  checkedIdentity(uid, options.boardId, epoch)
  await boardHistoryStore.acknowledge(options.boardId, entry.localVersionId, {
    localSnapshotVersionId: result.localSnapshotVersionId, canonicalVersionId: result.canonicalVersionId ?? undefined,
    acceptedAt: result.acceptedAt, expiresAt: result.expiresAt,
  })
}

async function applyFieldIntents(options: SyncOptions, snapshot: CommittedBoardContent, entries: HistoryOutboxEntry[], uid: string, epoch: number) {
  // A later explicit rename can carry a newly observed CAS base after a user
  // resolves a conflict. Earlier captures remain history, not vetoes on that choice.
  const name = [...entries].reverse().find((entry) => !entry.headAcknowledged && entry.changedFields.name)
  if (name) {
    const head = await sceneService.load(options.boardId)
    if (!head || head.generation !== name.generation) throw new SceneGenerationError()
    if (head.boardName !== snapshot.document.name) {
      if (!Number.isInteger(name.fieldBases.nameRevision))
        throw new Error('Refresh the name conflict before applying this offline rename.')
      checkedIdentity(uid, options.boardId, epoch)
      await projectCall('updateBoardContent', { boardId: options.boardId, mutationId: `${name.headMutationId}_name`,
        generation: name.generation, expectedFence: name.expectedFence,
        nameRevision: name.fieldBases.nameRevision, name: snapshot.document.name })
    }
  }
  const notes = new Map<string, HistoryOutboxEntry>()
  for (const entry of entries.filter((entry) => !entry.headAcknowledged))
    for (const slideId of entry.changedFields.notes ?? []) if (!notes.has(slideId)) notes.set(slideId, entry)
  if (!notes.size) return
  const cloud = await readHistorySnapshot(options.boardId, undefined, false)
  for (const [slideId, entry] of notes) {
    const text = snapshot.notes[slideId] ?? ''
    if ((cloud.notes[slideId] ?? '') === text) continue
    const revision = (entry.fieldBases.notes as Record<string, unknown> | undefined)?.[slideId]
    if (!Number.isInteger(revision)) throw new Error('Refresh the speaker-note conflict before applying this offline note.')
    checkedIdentity(uid, options.boardId, epoch)
    const result = await projectCall<{ conflict: boolean }>('slideNotes', { operation: 'write', boardId: options.boardId,
      ...(options.projectId ? { projectId: options.projectId } : {}), slideId, text, revision,
      mutationId: await digestString(`${entry.headMutationId}:${slideId}`),
      generation: entry.generation, expectedFence: entry.expectedFence })
    if (result.conflict) throw new Error(`Speaker note ${slideId} changed on another device. Resolve the note conflict.`)
  }
}

async function run(options: SyncOptions): Promise<LoadedScene | null> {
  const uid = getFirebaseAuth()?.currentUser?.uid
  if (!uid || !navigator.onLine) return null
  const epoch = historyEditingState(options.boardId).epoch
  checkedIdentity(uid, options.boardId, epoch)
  // A sync wake-up is only a hint to inspect local work. An empty outbox means
  // there is nothing to reconcile with Firebase; do not register the board,
  // read its head, or fetch the current scene just to prove that fact.
  const queued = (await boardHistoryStore.listOutbox(options.boardId))
    .filter((entry) => entry.retryState === 'pending')
  if (!queued.length) return null
  await boardHistoryStore.prune()
  const registered = options.applyHead ? undefined : await sceneService.ensure(options.boardId, options.projectId)
  // Workspace sync already registers before entering this worker. Shared-board
  // history sync still needs registration for legacy or newly created heads.
  const db = getFirestoreDb()
  const freshHead = db ? await getDocFromServer(doc(db, 'boardScenes', options.boardId)) : null
  // Older ensure callables return only scene fields. A partial server rollout
  // must not hide an already-fenced protocol-1 head behind that old response.
  const head = freshHead?.exists()
    ? { ...(registered ?? {}), ...(freshHead.data() as SceneHead) } as SceneHead
    : registered
  if (!head) throw new Error('Board scene could not be registered for history sync.')
  checkedIdentity(uid, options.boardId, epoch)
  if (head.historyProtocolVersion === 1 && !head.currentVersionId)
    throw new Error('Cloud history registration has not completed.')
  const current = await boardHistoryStore.getCommittedContent(options.boardId)
  checkedIdentity(uid, options.boardId, epoch)
  if (!current) return null
  if (head.historyProtocolVersion !== 1) {
    // A legacy server still has a generation barrier. Only a never-cloud-bound
    // local board can establish its first generation from registration.
    if (current.document.cloudGeneration !== undefined && current.document.cloudGeneration !== head.generation)
      throw new SceneGenerationError()
    const entries = await boardHistoryStore.listOutbox(options.boardId)
    const latest = entries.find((entry) => entry.publicationIntent === 'head')
    if (!latest) return sceneService.load(options.boardId)
    const snapshot = await boardHistoryStore.get(options.boardId, latest.localVersionId)
    if (!snapshot) throw new Error('The pending current-content snapshot is unavailable.')
    const scene = await storeSceneAssets(snapshot.document.scene, options.assetRoot, options.projectId)
    checkedIdentity(uid, options.boardId, epoch)
    const published = entries.some((entry) => !entry.headAcknowledged && entry.changedFields.scene)
      ? await sceneService.commit(options.boardId, scene, { expectedGeneration: current.document.cloudGeneration ?? head.generation })
      : await sceneService.load(options.boardId)
    if (!published) return null
    checkedIdentity(uid, options.boardId, epoch)
    const hasName = entries.some((entry) => !entry.headAcknowledged && entry.changedFields.name)
    if (hasName && options.applyLegacyName) await options.applyLegacyName(snapshot)
    const notes = new Map<string, HistoryOutboxEntry>()
    for (const entry of entries.filter((item) => !item.headAcknowledged))
      for (const id of entry.changedFields.notes ?? []) if (!notes.has(id)) notes.set(id, entry)
    for (const [slideId, entry] of notes) {
      const remote = await projectCall<{ text: string }>('slideNotes', { operation: 'read', boardId: options.boardId,
        ...(options.projectId ? { projectId: options.projectId } : {}), slideId })
      const text = snapshot.notes[slideId] ?? ''
      if (remote.text === text) continue
      const revision = (entry.fieldBases.notes as Record<string, unknown> | undefined)?.[slideId]
      if (!Number.isInteger(revision)) throw new Error('Refresh the speaker-note conflict before applying this offline note.')
      checkedIdentity(uid, options.boardId, epoch)
      const result = await projectCall<{ conflict: boolean }>('slideNotes', { operation: 'write', boardId: options.boardId,
        ...(options.projectId ? { projectId: options.projectId } : {}), slideId, text, revision,
        mutationId: await digestString(`${entry.headMutationId}:${slideId}`) })
      if (result.conflict) throw new Error(`Speaker note ${slideId} changed on another device. Resolve the note conflict.`)
    }
    checkedIdentity(uid, options.boardId, epoch)
    for (const entry of entries) await boardHistoryStore.acknowledgeLegacyFields(options.boardId, entry.localVersionId,
      { scene: true, name: hasName && Boolean(options.applyLegacyName), notes: [...notes.keys()] })
    const committed = await boardHistoryStore.getCommittedContent(options.boardId)
    if (committed) await boardHistoryStore.reconcileDocument({ ...committed.document,
      cloudRevisionId: published.revisionId, cloudGeneration: published.generation,
      syncStatus: committed.document.revision > snapshot.document.revision ? 'local-only' : 'synced',
      baseRevision: committed.document.revision > snapshot.document.revision ? committed.document.baseRevision : committed.document.revision })
    return published
  }
  if (!head.currentVersionId) throw new Error('Cloud history registration has not completed.')
  if (current.document.cloudGeneration !== undefined && current.document.cloudGeneration !== head.generation)
    throw new SceneGenerationError()
  // Resolve old attempts before repairing metadata-only hydration of a legacy
  // history base. Never move a capture across a successful restore generation.
  const beforeBinding = (await boardHistoryStore.listOutbox(options.boardId))
    .filter((entry) => entry.retryState === 'pending')
  if (current.document.cloudGeneration !== undefined &&
    beforeBinding.some((entry) => entry.expectedFence !== (head.restoreFence ?? 0)))
    await refreshHistoryFence(options.boardId, head.generation, head.restoreFence ?? 0)
  await boardHistoryStore.repairLegacyCloudLineage(options.boardId, { generation: head.generation,
    restoreFence: head.restoreFence ?? 0, currentVersionId: head.currentVersionId, cloudRevisionId: head.headRevisionId })
  const entries = (await boardHistoryStore.listOutbox(options.boardId))
    .filter((entry) => entry.retryState === 'pending')
  if (!entries.length) return sceneService.load(options.boardId)
  if (entries.some((entry) => entry.generation !== head.generation)) throw new SceneGenerationError()
  if (entries.some((entry) => entry.expectedFence !== (head.restoreFence ?? 0))) {
    await refreshHistoryFence(options.boardId, head.generation, head.restoreFence ?? 0)
    return run(options)
  }
  const snapshots = new Map<string, CommittedBoardContent>()
  for (const entry of entries) {
    const snapshot = await boardHistoryStore.get(options.boardId, entry.localVersionId)
    if (snapshot) snapshots.set(entry.localVersionId, snapshot)
  }
  const rank = (id: string): number => {
    const parent = snapshots.get(id)?.version.parentLocalVersionId
    return parent && snapshots.has(parent) ? rank(parent) + 1 : 0
  }
  entries.sort((a, b) => rank(a.localVersionId) - rank(b.localVersionId))
  const latest = entries.find((entry) => entry.publicationIntent === 'head')
  for (const entry of entries.filter((entry) => entry !== latest && !entry.receipt)) {
    const snapshot = snapshots.get(entry.localVersionId)
    if (!snapshot) continue
    try {
      const cloud = await readHistorySnapshot(options.boardId, undefined, false)
      const cloudScene = await storeSceneAssets(snapshot.document.scene, options.assetRoot, options.projectId,
        { expectedGeneration: entry.generation, expectedFence: entry.expectedFence })
      if (cloud.entry.id && sameTuple({ ...snapshot, document: { ...snapshot.document, scene: cloudScene } }, cloud.scene, cloud.entry.name, cloud.notes))
        await importSnapshot(options, snapshot, entry, uid, epoch, cloud.entry.id)
      else await importSnapshot(options, snapshot, entry, uid, epoch)
    } catch (error) {
      if (!historicalUnavailable(error)) throw error
      // An expired or unverifiable historical ancestry does not revoke permission
      // to synchronize current content. Preserve its capture and report separately.
      await blockHistoricalCapture(options.boardId, entry.localVersionId, error)
    }
  }
  if (!latest) return sceneService.load(options.boardId)
  const snapshot = snapshots.get(latest.localVersionId)
  if (!snapshot) throw new Error('The pending current-content snapshot is unavailable.')
  await applyFieldIntents(options, snapshot, entries, uid, epoch)
  checkedIdentity(uid, options.boardId, epoch)
  const scene = await storeSceneAssets(snapshot.document.scene, options.assetRoot, options.projectId,
    { expectedGeneration: latest.generation, expectedFence: latest.expectedFence })
  const published = options.applyHead
    ? await options.applyHead({ ...snapshot, document: { ...snapshot.document, scene } }, latest)
    : await sceneService.commit(options.boardId, scene, { expectedGeneration: latest.generation, expectedFence: latest.expectedFence })
  checkedIdentity(uid, options.boardId, epoch)
  const cloud = await readHistorySnapshot(options.boardId, undefined, false)
  if (!latest.receipt) {
    try {
      if (sameTuple({ ...snapshot, document: { ...snapshot.document, scene } }, cloud.scene, cloud.entry.name, cloud.notes))
        await importSnapshot(options, snapshot, latest, uid, epoch, cloud.entry.id)
      else await importSnapshot(options, snapshot, latest, uid, epoch)
    } catch (error) {
      if (!historicalUnavailable(error)) throw error
      await blockHistoricalCapture(options.boardId, latest.localVersionId, error)
    }
  }
  for (const entry of entries) await boardHistoryStore.acknowledgeHead(options.boardId, entry.localVersionId)
  const committed = await boardHistoryStore.getCommittedContent(options.boardId)
  if (committed) {
    const pending = (await boardHistoryStore.listOutbox(options.boardId)).filter((entry) => !entry.headAcknowledged)
    const laterEdits = committed.document.revision > snapshot.document.revision
    const currentScene = laterEdits ? committed.document.scene
      : await restoreSceneAssets(cloud.scene, committed.document.scene.files, cloud.readContextId)
    checkedIdentity(uid, options.boardId, epoch)
    await boardHistoryStore.reconcileDocument({ ...committed.document,
      scene: currentScene,
      name: pending.some((entry) => entry.changedFields.name) ? committed.document.name : cloud.entry.name,
      cloudRevisionId: cloud.revisionId, cloudGeneration: cloud.generation,
      cloudVersionId: cloud.entry.id, cloudRestoreFence: published.restoreFence ?? latest.expectedFence,
      cloudNameRevision: published.nameRevision,
      syncStatus: ['sync-blocked', 'conflict'].includes(committed.document.syncStatus)
        ? committed.document.syncStatus : pending.length ? 'local-only' : 'synced',
      baseRevision: pending.length ? committed.document.baseRevision : committed.document.revision,
    })
    await boardHistoryStore.reconcileCloudNotes(options.boardId, cloud.notes)
  }
  return published
}

/** One worker per board/tab; native capture and stable receipts also fence other tabs. */
export function syncBoardHistory(options: SyncOptions): Promise<LoadedScene | null> {
  const existing = active.get(options.boardId)
  if (existing) return existing
  const work = run(options).finally(() => {
    if (active.get(options.boardId) === work) active.delete(options.boardId)
    window.dispatchEvent(new CustomEvent('board-history-sync-status', { detail: { boardId: options.boardId, status: 'updated' } }))
  })
  active.set(options.boardId, work)
  return work
}
