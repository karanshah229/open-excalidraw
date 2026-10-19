import { randomUUID } from 'node:crypto'
import { getDatabase } from 'firebase-admin/database'
import { getFirestore, Timestamp, FieldValue, type DocumentData } from 'firebase-admin/firestore'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'
import { defineBoolean, defineString } from 'firebase-functions/params'
import { indexSceneAssets, validateSceneAssetResources } from './board-history-assets.js'
import { assertContentWritable, publishContentVersion } from './board-history-model.js'
import { loadNoteSnapshot, writeNoteSnapshot } from './board-history-notes.js'
import { authorizeScene, type SceneActor, type SceneBinding } from './scene-access.js'
import {
  packScene,
  assembleScene,
  digestString,
  manifestDigest,
  paginateReferences,
  SCENE_FORMAT_VERSION,
  CHUNK_BUDGET_BYTES,
  chunkDocumentBytes,
  type ScenePayload,
  type PackedChunk,
  type ChunkReference,
} from './scene-codec.js'

const region = defineString('SYNC_ACCESS_FUNCTION_REGION')
const appCheck = defineBoolean('ASSET_ENFORCE_APP_CHECK', { default: true })
const MAX_CHUNKS = 512,
  MAX_PAGES = 6,
  MAX_BYTES = 64 * 1024 * 1024
const LEASE_MS = 120_000
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value))
    throw new HttpsError('invalid-argument', 'Invalid scene identifier.')
  return value
}
export const scenePageId = (slot: number) => String(slot).padStart(6, '0')
const actorOf = (request: CallableRequest): SceneActor => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to persist this scene.')
  return {
    uid: request.auth.uid,
    email:
      request.auth.token.email_verified === true ? String(request.auth.token.email ?? '').toLowerCase() : undefined,
  }
}
function dataError(message: string): never {
  throw new HttpsError('failed-precondition', message)
}
const milliseconds = (value: any) =>
  typeof value?.toMillis === 'function' ? value.toMillis() : typeof value === 'string' ? Date.parse(value) : NaN
const normalizeScene = (value: any): ScenePayload => ({
  ...(value ?? {}),
  elements: value?.elements ?? [],
  appState: value?.appState ?? {},
  files: value?.files ?? {},
})
function mergeScene(left: any, right: any): ScenePayload {
  const elements = new Map<string, any>()
  for (const element of [...(left?.elements ?? []), ...(right?.elements ?? [])]) {
    const previous = elements.get(element.id)
    if (
      !previous ||
      Number(element.version ?? 0) > Number(previous.version ?? 0) ||
      (Number(element.version ?? 0) === Number(previous.version ?? 0) &&
        Number(element.versionNonce ?? 0) < Number(previous.versionNonce ?? 0))
    )
      elements.set(element.id, element)
  }
  return normalizeScene({
    ...left,
    ...right,
    elements: [...elements.values()],
    files: { ...left?.files, ...right?.files },
  })
}
async function getMany(paths: string[]) {
  const db = getFirestore(),
    results = []
  for (let start = 0; start < paths.length; start += 40)
    results.push(...(await db.getAll(...paths.slice(start, start + 40).map((path) => db.doc(path)))))
  return results
}
export async function loadSceneManifest(boardId: string, head: DocumentData) {
  if (!head.headRevisionId) dataError('The scene has no committed revision.')
  const root = `boardScenes/${boardId}`,
    revision = (await getFirestore().doc(`${root}/revisions/${head.headRevisionId}`).get()).data()
  if (
    !revision ||
    revision.generation !== head.generation ||
    revision.sceneFormatVersion !== SCENE_FORMAT_VERSION ||
    !Number.isSafeInteger(revision.pageCount) ||
    revision.pageCount < 1 ||
    revision.pageCount > MAX_PAGES ||
    !Number.isSafeInteger(revision.chunkCount) ||
    revision.chunkCount < 1 ||
    revision.chunkCount > MAX_CHUNKS
  )
    dataError('Invalid scene revision.')
  const pages = await getMany(
    Array.from(
      { length: revision.pageCount },
      (_, slot) => `${root}/revisions/${head.headRevisionId}/pages/${scenePageId(slot)}`,
    ),
  )
  const references: ChunkReference[] = pages.flatMap((page) => {
    if (!page.exists || !Array.isArray(page.data()?.references)) dataError('Missing manifest page.')
    return page.data()!.references
  })
  if (
    references.length !== revision.chunkCount ||
    references.length > MAX_CHUNKS ||
    new Set(references.map((reference) => reference.chunkId)).size !== references.length ||
    (await manifestDigest(references, head.generation)) !== revision.candidateDigest
  )
    dataError('Invalid manifest.')
  return { revision, references }
}
export async function loadSceneRevision(boardId: string, head: DocumentData) {
  const root = `boardScenes/${boardId}`,
    { references } = await loadSceneManifest(boardId, head)
  const snapshots = await getMany(references.map((ref) => `${root}/chunks/${id(ref.chunkId)}`))
  const chunks: PackedChunk[] = snapshots.map((snapshot, slot) => {
    const chunk = snapshot.data()
    if (!chunk || chunk.digest !== references[slot].digest || chunk.generation !== head.generation)
      dataError('Missing scene chunk.')
    return { chunkId: snapshot.id, digest: chunk.digest, payload: chunk.payload }
  })
  return { scene: await assembleScene(chunks), chunks, references }
}

/** Atomic legacy cutover; a concurrently changed legacy source retries packing, never loses edits. */
export async function ensureScene(boardId: string, actor: SceneActor, requestedProjectId?: string) {
  const db = getFirestore(),
    root = `boardScenes/${boardId}`,
    ref = db.doc(root)
  const existing = (await ref.get()).data()
  // A coordinated rollout closes this server-only gate before installing services/rules.
  // Already-started migrations and protocol-1 recovery must remain able to finish.
  if (
    existing?.historyProtocolVersion !== 1 &&
    !existing?.restoreOperationId &&
    (await db.doc('system/boardHistoryRollout').get()).data()?.migrationEnabled === false
  )
    throw new HttpsError('unavailable', 'Board history deployment is in progress. Retry shortly.')
  if (existing) {
    if (requestedProjectId && existing.projectId !== requestedProjectId)
      throw new HttpsError('permission-denied', 'Scene project binding does not match the requested project.')
    await authorizeScene(boardId, existing as SceneBinding, actor, undefined, false)
    if (existing.headRevisionId) return initializeBoardHistory(boardId, actor)
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const shareSnapshot = await db.doc(`boardShares/${boardId}`).get(),
      share = shareSnapshot.data()
    const ownerId = share?.ownerId ?? existing?.ownerId ?? actor.uid,
      projectId = share?.projectId ?? existing?.projectId ?? requestedProjectId ?? null
    if (requestedProjectId && projectId !== requestedProjectId)
      throw new HttpsError('permission-denied', 'Scene project binding does not match the requested project.')
    if (!projectId && !share) dataError('A standalone scene requires existing trusted sharing metadata.')
    id(ownerId)
    if (projectId) id(projectId)
    const privateRef = projectId ? db.doc(`users/${ownerId}/projects/${projectId}/boards/${boardId}`) : null
    const privateSnapshot = privateRef ? await privateRef.get() : null
    const privateBoard = privateSnapshot?.data()
    if (projectId && !privateBoard)
      throw new HttpsError('not-found', 'Create the board metadata before registering its scene.')
    const binding = { ownerId, projectId }
    await authorizeScene(boardId, binding, actor, undefined, false)
    const location = await db.doc(`boardAssetLocations/${boardId}`).get()
    if (location.exists && (location.data()?.ownerId !== ownerId || location.data()?.projectId !== projectId))
      dataError('Scene and asset ownership disagree.')
    // Reserve the immutable ownership binding BEFORE staging Admin payloads. A board-ID
    // collision must never leak a losing private owner's orphan chunks to the winner.
    await db.runTransaction(async (tx) => {
      const reserved = (await tx.get(ref)).data()
      await authorizeScene(boardId, binding, actor, tx, false)
      if (reserved && (reserved.ownerId !== ownerId || reserved.projectId !== projectId))
        throw new HttpsError('permission-denied', 'This board ID is bound to another owner or project.')
      if (!reserved)
        tx.create(ref, {
          ...binding,
          headRevisionId: null,
          generation: 1,
          sceneFormatVersion: SCENE_FORMAT_VERSION,
          updatedAt: new Date().toISOString(),
        })
    })
    const scene = mergeScene(privateBoard?.scene, share?.scene),
      revisionId = `initial_${randomUUID()}`
    const packed = (await packScene(scene)).map((chunk, slot) => ({
        ...chunk,
        chunkId: `${revisionId}_${scenePageId(slot)}`,
      })),
      pages = paginateReferences(packed.map(({ chunkId, digest }) => ({ chunkId, digest }))),
      generation = 1
    if (
      packed.length > MAX_CHUNKS ||
      pages.length > MAX_PAGES ||
      packed.reduce((bytes, chunk) => bytes + chunkDocumentBytes(chunk.payload), 0) > MAX_BYTES
    )
      dataError('Legacy board exceeds the initial scene budget.')
    const candidateDigest = await manifestDigest(
      packed.map(({ chunkId, digest }) => ({ chunkId, digest })),
      generation,
    )
    const staged = db.bulkWriter()
    packed.forEach((chunk, slot) =>
      staged.create(db.doc(`${root}/chunks/${chunk.chunkId}`), {
        payload: chunk.payload,
        digest: chunk.digest,
        uploadId: revisionId,
        slot,
        uploaderUid: actor.uid,
        generation,
        kind: 'records',
      }),
    )
    pages.forEach((page, slot) =>
      staged.create(db.doc(`${root}/revisions/${revisionId}/pages/${scenePageId(slot)}`), { references: page }),
    )
    packed.forEach((chunk) =>
      staged.set(db.doc(`${root}/chunkReferences/${chunk.chunkId}/revisions/${revisionId}`), {
        createdAt: new Date().toISOString(),
      }),
    )
    staged.create(db.doc(`${root}/revisions/${revisionId}`), {
      generation,
      sceneFormatVersion: SCENE_FORMAT_VERSION,
      pageCount: pages.length,
      chunkCount: packed.length,
      candidateDigest,
      parentRevisionId: null,
      createdAt: new Date().toISOString(),
      reason: 'legacy-migration',
    })
    await staged.close()
    const result = await db.runTransaction(async (tx) => {
      const current = await tx.get(ref)
      await authorizeScene(boardId, binding, actor, tx, false)
      const privateNow = privateRef ? await tx.get(privateRef) : null,
        shareNow = await tx.get(shareSnapshot.ref),
        assetNow = await tx.get(location.ref)
      if (current.data()?.ownerId !== ownerId || current.data()?.projectId !== projectId)
        throw new HttpsError('permission-denied', 'Scene ownership changed.')
      if (current.data()?.headRevisionId) return current.data()!
      if (assetNow.exists && (assetNow.data()?.ownerId !== ownerId || assetNow.data()?.projectId !== projectId))
        dataError('Scene and asset ownership disagree.')
      if (
        (privateRef && !privateNow?.updateTime?.isEqual(privateSnapshot!.updateTime!)) ||
        shareNow.exists !== shareSnapshot.exists ||
        (shareNow.exists && !shareNow.updateTime?.isEqual(shareSnapshot.updateTime!))
      )
        return null
      const notes = await loadNoteSnapshot(boardId, null, tx)
      const head = {
        ...binding,
        headRevisionId: revisionId,
        generation,
        sceneFormatVersion: SCENE_FORMAT_VERSION,
        updatedAt: new Date().toISOString(),
      }
      tx.set(ref, head)
      const history = publishContentVersion(
        tx,
        boardId,
        head,
        actor,
        revisionId,
        {
          boardName:
            privateNow?.data()?.name ?? shareNow.data()?.boardName ?? shareNow.data()?.name ?? 'Untitled board',
          notesRevisionId: writeNoteSnapshot(tx, boardId, notes),
          nameRevision: 0,
        },
        'initial',
      )
      // Embedded payloads retained read-only for recovery. Rules disallow further scene updates after cutover.
      if (privateRef) tx.update(privateRef, { sceneId: boardId })
      if (shareNow.exists) tx.update(shareNow.ref, { sceneId: boardId })
      return {
        ...head,
        ...history,
        currentVersionId: history.versionId,
        currentBranchId: history.branchId,
        restoreFence: 0,
      }
    })
    if (result) return initializeBoardHistory(boardId, actor)
  }
  throw new HttpsError('aborted', 'The board changed during migration. Retry registration.')
}

export async function commitSceneCandidate(
  boardId: string,
  commitId: string,
  actor: SceneActor,
  restoreOperationId?: string,
) {
  const db = getFirestore(),
    root = `boardScenes/${boardId}`,
    headRef = db.doc(root),
    candidateRef = db.doc(`${root}/uploads/${commitId}`),
    leaseId = randomUUID()
  const state = await db.runTransaction(async (tx) => {
    const head = (await tx.get(headRef)).data(),
      candidate = (await tx.get(candidateRef)).data()
    if (!head || !candidate) dataError('Restage required: missing scene or upload.')
    if (!head.headRevisionId)
      dataError('Initial scene migration is pending. Complete registration before staging a save.')
    await authorizeScene(boardId, head as SceneBinding, actor, tx)
    assertContentWritable(
      actor.trusted && restoreOperationId === head.restoreOperationId ? { ...head, restoreOperationId: null } : head,
      candidate.generation,
      candidate.expectedFence ?? 0,
    )
    if (head.historyProtocolVersion === 1 && !Number.isInteger(candidate.expectedFence))
      throw new HttpsError('failed-precondition', 'Update this tab before saving; restore fence is required.')
    if (candidate.purpose === 'history-only') dataError('Use importBoardVersion for historical candidates.')
    if (candidate.uploaderUid !== actor.uid)
      throw new HttpsError('permission-denied', 'Upload belongs to another actor.')
    if (candidate.receipt) return { head, candidate, receipt: candidate.receipt }
    if (candidate.generation !== head.generation || candidate.expectedHeadRevisionId !== head.headRevisionId)
      throw new HttpsError('aborted', 'Scene revision changed.', {
        currentHeadRevisionId: head.headRevisionId,
        generation: head.generation,
      })
    if (
      !Number.isSafeInteger(candidate.pageCount) ||
      candidate.pageCount < 1 ||
      candidate.pageCount > MAX_PAGES ||
      !Number.isSafeInteger(candidate.chunkCount) ||
      candidate.chunkCount < 1 ||
      candidate.chunkCount > MAX_CHUNKS ||
      !Number.isSafeInteger(candidate.newChunkCount) ||
      candidate.newChunkCount < 0 ||
      candidate.newChunkCount > candidate.chunkCount ||
      candidate.sceneFormatVersion !== SCENE_FORMAT_VERSION
    )
      dataError('Invalid candidate bounds or format.')
    if (
      !Number.isFinite(milliseconds(candidate.expiresAt)) ||
      milliseconds(candidate.expiresAt) <= Date.now() ||
      !Number.isFinite(milliseconds(candidate.createdAt)) ||
      milliseconds(candidate.expiresAt) - milliseconds(candidate.createdAt) > 24 * 60 * 60 * 1000
    )
      dataError('Restage required: expired upload.')
    if (candidate.leaseUntil && milliseconds(candidate.leaseUntil) > Date.now())
      throw new HttpsError('unavailable', 'Another worker is validating this upload. Retry shortly.')
    tx.update(candidateRef, { leaseId, leaseUntil: Timestamp.fromMillis(Date.now() + LEASE_MS) })
    return { head, candidate, receipt: undefined }
  })
  if (state.receipt) return state.receipt
  try {
    const { head, candidate } = state
    const pages = await getMany(
      Array.from(
        { length: candidate.pageCount },
        (_, slot) => `${root}/uploads/${commitId}/pages/${scenePageId(slot)}`,
      ),
    )
    const references: ChunkReference[] = pages.flatMap((page) => {
      const data = page.data()
      if (
        !data ||
        Object.keys(data).length !== 1 ||
        !Array.isArray(data.references) ||
        !data.references.length ||
        data.references.length > 100
      )
        dataError('Incomplete candidate manifest.')
      return data.references
    })
    if (
      references.length !== candidate.chunkCount ||
      new Set(references.map((ref) => ref.chunkId)).size !== references.length ||
      (await manifestDigest(references, head.generation)) !== candidate.candidateDigest
    )
      dataError('Candidate manifest digest/count mismatch.')
    const base = await loadSceneManifest(boardId, head),
      allowed = new Map(base.references.map((ref) => [ref.chunkId, ref.digest]))
    const snapshots = await getMany(references.map((ref) => `${root}/chunks/${id(ref.chunkId)}`))
    let bytes = 0,
      newlyStaged = 0
    const chunks: PackedChunk[] = []
    for (let slot = 0; slot < snapshots.length; slot++) {
      const chunk = snapshots[slot].data(),
        reference = references[slot]
      if (
        !chunk ||
        typeof chunk.payload !== 'string' ||
        chunk.kind !== 'records' ||
        chunk.generation !== head.generation ||
        chunk.digest !== reference.digest ||
        (await digestString(chunk.payload)) !== chunk.digest
      )
        dataError('Invalid chunk content or digest.')
      bytes += chunkDocumentBytes(chunk.payload)
      if (chunkDocumentBytes(chunk.payload) > CHUNK_BUDGET_BYTES || bytes > MAX_BYTES)
        dataError('Scene exceeds payload budget.')
      if (allowed.get(reference.chunkId) !== reference.digest) {
        if (chunk.uploadId !== commitId || chunk.uploaderUid !== actor.uid || chunk.slot !== newlyStaged)
          dataError('Chunk does not belong to this candidate or its base.')
        newlyStaged++
      }
      chunks.push({ chunkId: reference.chunkId, digest: chunk.digest, payload: chunk.payload })
    }
    if (newlyStaged !== candidate.newChunkCount) dataError('New chunk count mismatch.')
    const scene = await assembleScene(chunks)
    validateAssets(boardId, head.ownerId, scene)
    const revisionId = commitId,
      assetResources = await indexSceneAssets(boardId, commitId, scene)
    const reverseWriter = db.bulkWriter()
    references.forEach((reference) =>
      reverseWriter.set(db.doc(`${root}/chunkReferences/${reference.chunkId}/revisions/${revisionId}`), {
        createdAt: new Date().toISOString(),
      }),
    )
    await reverseWriter.close()
    // Stage immutable server manifests once; retries preserve the original timestamp and bytes.
    const createdAt = await db.runTransaction(async (tx) => {
      const revisionRef = db.doc(`${root}/revisions/${revisionId}`),
        previous = (await tx.get(revisionRef)).data()
      if (previous) {
        if (
          previous.candidateDigest !== candidate.candidateDigest ||
          previous.parentRevisionId !== candidate.expectedHeadRevisionId ||
          previous.generation !== head.generation
        )
          dataError('Revision identity collision.')
        return previous.createdAt as string
      }
      const createdAt = new Date().toISOString()
      pages.forEach((page, slot) =>
        tx.create(db.doc(`${root}/revisions/${revisionId}/pages/${scenePageId(slot)}`), page.data()!),
      )
      tx.create(revisionRef, {
        generation: head.generation,
        sceneFormatVersion: SCENE_FORMAT_VERSION,
        pageCount: candidate.pageCount,
        chunkCount: candidate.chunkCount,
        candidateDigest: candidate.candidateDigest,
        parentRevisionId: candidate.expectedHeadRevisionId,
        assetResourceIds: assetResources.map((resource) => resource.id),
        createdAt,
      })
      return createdAt
    })
    return await db.runTransaction(async (tx) => {
      const latest = (await tx.get(headRef)).data(),
        upload = (await tx.get(candidateRef)).data()
      if (!latest || !upload) dataError('Restage required.')
      await authorizeScene(boardId, latest as SceneBinding, actor, tx)
      assertContentWritable(
        actor.trusted && restoreOperationId === latest.restoreOperationId
          ? { ...latest, restoreOperationId: null }
          : latest,
        candidate.generation,
        candidate.expectedFence ?? 0,
      )
      if (upload.receipt) return upload.receipt
      if (upload.leaseId !== leaseId || milliseconds(upload.leaseUntil) <= Date.now())
        dataError('Validation lease expired. Retry publication.')
      if (latest.headRevisionId !== candidate.expectedHeadRevisionId || latest.generation !== candidate.generation)
        throw new HttpsError('aborted', 'Scene revision changed.', {
          currentHeadRevisionId: latest.headRevisionId,
          generation: latest.generation,
        })
      const canonical = (await tx.get(db.doc(`${root}/revisions/${latest.headRevisionId}`))).data()
      if (canonical && canonical.candidateDigest === candidate.candidateDigest) {
        const receipt = {
          revisionId: latest.headRevisionId,
          generation: latest.generation,
          candidateDigest: canonical.candidateDigest,
          committedAt: canonical.createdAt,
          versionId: latest.currentVersionId,
          contentSequence: latest.contentSequence,
          branchId: latest.currentBranchId,
          branchSequence: latest.branchSequence,
        }
        tx.update(candidateRef, { receipt, status: 'committed', leaseId: null, leaseUntil: null })
        return receipt
      }
      const resources = await tx.getAll(
        ...references.map((reference) => db.doc(`${root}/chunks/${reference.chunkId}`)),
        { fieldMask: ['digest', 'generation', 'deletionFence'] },
      )
      resources.forEach((resource, slot) => {
        const chunk = resource.data()
        if (
          !chunk ||
          chunk.deletionFence ||
          chunk.digest !== references[slot].digest ||
          chunk.generation !== latest.generation
        )
          dataError('Chunk was collected during validation. Restage this save.')
      })
      await validateSceneAssetResources(tx, boardId, assetResources)
      const receipt = {
        revisionId,
        generation: latest.generation,
        candidateDigest: candidate.candidateDigest,
        committedAt: createdAt,
      }
      const history = publishContentVersion(
        tx,
        boardId,
        latest,
        actor,
        revisionId,
        { headRevisionId: revisionId },
        actor.trusted ? 'collaboration-checkpoint' : 'scene-save',
      )
      Object.assign(receipt, history)
      tx.update(candidateRef, { receipt, status: 'committed', leaseId: null, leaseUntil: null })
      return receipt
    })
  } finally {
    await db.runTransaction(async (tx) => {
      const upload = (await tx.get(candidateRef)).data()
      if (upload?.leaseId === leaseId) tx.update(candidateRef, { leaseId: null, leaseUntil: null })
    })
  }
}
export function validateAssets(boardId: string, ownerId: string, scene: ScenePayload) {
  for (const file of Object.values(scene.files ?? {}) as any[]) {
    if (!file || typeof file !== 'object') dataError('Invalid file descriptor.')
    if (file.dataURL || file.url || file.downloadURL)
      dataError('Persist storage descriptors, not image bytes or download URLs.')
    if (
      file.storagePath &&
      ![`users/${ownerId}/boards/${boardId}/assets/`, `boards/${boardId}/assets/`].some(
        (prefix) =>
          typeof file.storagePath === 'string' &&
          file.storagePath.startsWith(prefix) &&
          /^[A-Za-z0-9_-]+$/.test(file.storagePath.slice(prefix.length)),
      )
    )
      dataError('Asset belongs to another board.')
  }
}

export async function checkpointScene(
  boardId: string,
  scene: ScenePayload,
  head: DocumentData,
  actor: SceneActor,
  restoreOperationId?: string,
) {
  const db = getFirestore(),
    root = `boardScenes/${boardId}`,
    commitId = `checkpoint_${randomUUID()}`
  const base = await loadSceneRevision(boardId, head),
    priorIds = new Set(base.references.map((ref) => ref.chunkId))
  let freshSlot = 0
  const chunks = (await packScene(scene, base.chunks)).map((chunk) =>
      priorIds.has(chunk.chunkId) ? chunk : { ...chunk, chunkId: `${commitId}_${scenePageId(freshSlot++)}` },
    ),
    references = chunks.map(({ chunkId, digest }) => ({ chunkId, digest })),
    pages = paginateReferences(references)
  const candidateDigest = await manifestDigest(references, head.generation)
  if (candidateDigest === (await manifestDigest(base.references, head.generation))) {
    return db.runTransaction(async (tx) => {
      const latest = (await tx.get(db.doc(root))).data()!
      await authorizeScene(boardId, latest as SceneBinding, actor, tx)
      assertContentWritable(
        actor.trusted && restoreOperationId === latest.restoreOperationId
          ? { ...latest, restoreOperationId: null }
          : latest,
        head.generation,
        head.restoreFence ?? 0,
      )
      if (latest.headRevisionId !== head.headRevisionId) throw new HttpsError('aborted', 'Scene revision changed.')
      return {
        revisionId: latest.headRevisionId,
        generation: latest.generation,
        candidateDigest,
        committedAt: (await tx.get(db.doc(`${root}/revisions/${latest.headRevisionId}`))).data()!.createdAt,
        versionId: latest.currentVersionId,
        contentSequence: latest.contentSequence,
        branchId: latest.currentBranchId,
        branchSequence: latest.branchSequence,
      }
    })
  }
  const oldIds = new Set(base.references.map((ref) => ref.chunkId)),
    newChunks = chunks.filter((chunk) => !oldIds.has(chunk.chunkId)),
    writer = db.bulkWriter(),
    now = Timestamp.now()
  writer.create(db.doc(`${root}/uploads/${commitId}`), {
    uploaderUid: actor.uid,
    expectedHeadRevisionId: head.headRevisionId,
    generation: head.generation,
    expectedFence: head.restoreFence ?? 0,
    sceneFormatVersion: SCENE_FORMAT_VERSION,
    pageCount: pages.length,
    chunkCount: chunks.length,
    newChunkCount: newChunks.length,
    candidateDigest,
    createdAt: now,
    expiresAt: Timestamp.fromMillis(now.toMillis() + 60 * 60 * 1000),
  })
  newChunks.forEach((chunk, slot) =>
    writer.create(db.doc(`${root}/chunks/${chunk.chunkId}`), {
      payload: chunk.payload,
      digest: chunk.digest,
      uploadId: commitId,
      slot,
      uploaderUid: actor.uid,
      generation: head.generation,
      kind: 'records',
    }),
  )
  pages.forEach((page, slot) =>
    writer.create(db.doc(`${root}/uploads/${commitId}/pages/${scenePageId(slot)}`), { references: page }),
  )
  await writer.close()
  return commitSceneCandidate(boardId, commitId, actor, restoreOperationId)
}
export const ensureBoardScene = onCall(
  { region, enforceAppCheck: appCheck.value(), timeoutSeconds: 120, memory: '512MiB' },
  async (request) => {
    const head = await ensureScene(
      id(request.data?.boardId),
      actorOf(request),
      request.data?.projectId ? id(request.data.projectId) : undefined,
    )
    return {
      headRevisionId: head.headRevisionId,
      generation: head.generation,
      sceneFormatVersion: head.sceneFormatVersion,
      restoreFence: head.restoreFence ?? 0,
      currentVersionId: head.currentVersionId ?? null,
      boardName: head.boardName,
      nameRevision: head.nameRevision ?? 0,
      historyProtocolVersion: head.historyProtocolVersion ?? 0,
    }
  },
)
export const commitBoardScene = onCall(
  {
    region,
    enforceAppCheck: appCheck.value(),
    timeoutSeconds: 120,
    memory: '512MiB',
    concurrency: 4,
    maxInstances: 10,
  },
  async (request) => commitSceneCandidate(id(request.data?.boardId), id(request.data?.commitId), actorOf(request)),
)

/** Upgrade an existing canonical scene and fence legacy RTDB traffic before advertising history. */
export async function initializeBoardHistory(boardId: string, actor: SceneActor) {
  const db = getFirestore(),
    root = `boardScenes/${boardId}`,
    ref = db.doc(root),
    migrationId = `migration_${boardId}`,
    leaseId = randomUUID()
  let head = await db.runTransaction(async (tx) => {
    const head = (await tx.get(ref)).data()!
    await authorizeScene(boardId, head as SceneBinding, actor, tx, false)
    if (head.historyProtocolVersion === 1 && !head.restoreOperationId) return head
    if (
      !head.restoreOperationId &&
      (await tx.get(db.doc('system/boardHistoryRollout'))).data()?.migrationEnabled === false
    )
      throw new HttpsError('unavailable', 'Board history deployment is in progress. Retry shortly.')
    // Viewers may read legacy content, but cannot initiate a migration that checkpoints edits.
    await authorizeScene(boardId, head as SceneBinding, actor, tx)
    if (head.restoreOperationId && head.restoreOperationId !== migrationId)
      throw new HttpsError('unavailable', 'A restore is in progress.')
    if (head.migrationLeaseUntil?.toMillis?.() > Date.now())
      throw new HttpsError('unavailable', 'Board history migration is in progress.')
    const privateBoard = head.projectId
        ? (await tx.get(db.doc(`users/${head.ownerId}/projects/${head.projectId}/boards/${boardId}`))).data()
        : null,
      share = (await tx.get(db.doc(`boardShares/${boardId}`))).data(),
      notes = !head.currentVersionId ? await loadNoteSnapshot(boardId, null, tx) : null
    const patch = {
      restoreOperationId: migrationId,
      restoreFence: (head.restoreFence ?? 0) + 1,
      migrationLeaseId: leaseId,
      migrationLeaseUntil: Timestamp.fromMillis(Date.now() + 120_000),
    }
    if (!head.currentVersionId) {
      const history = publishContentVersion(
        tx,
        boardId,
        head,
        actor,
        `baseline_${randomUUID()}`,
        {
          ...patch,
          boardName: privateBoard?.name ?? share?.boardName ?? share?.name ?? 'Untitled board',
          nameRevision: 0,
          notesRevisionId: writeNoteSnapshot(tx, boardId, notes!),
        },
        'history-baseline',
      )
      return { ...head, ...patch, ...history, currentVersionId: history.versionId, currentBranchId: history.branchId }
    }
    tx.update(ref, patch)
    return { ...head, ...patch }
  })
  if (head.historyProtocolVersion === 1 && !head.restoreOperationId) return head
  head = (await ref.get()).data()!
  const reverseWriter = db.bulkWriter(),
    currentManifest = await loadSceneManifest(boardId, head)
  currentManifest.references.forEach((reference) =>
    reverseWriter.set(db.doc(`${root}/chunkReferences/${reference.chunkId}/revisions/${head.headRevisionId}`), {
      createdAt: new Date().toISOString(),
    }),
  )
  await reverseWriter.close()
  const currentScene = await loadSceneRevision(boardId, head)
  const initialAssetResources = await indexSceneAssets(boardId, head.headRevisionId, currentScene.scene)
  await db
    .doc(`${root}/revisions/${head.headRevisionId}`)
    .update({ assetResourceIds: initialAssetResources.map((resource) => resource.id) })
  const room = getDatabase().ref(`boards/${boardId}`),
    holdRoom = () => {}
  room.on('value', holdRoom)
  try {
    await room.once('value')
    const locked = await room.transaction((current) => {
      if ((current?.restoreFence ?? 0) > head.restoreFence) return
      return {
        ...current,
        generation: head.generation,
        restoreFence: head.restoreFence,
        restoreOperationId: migrationId,
      }
    })
    if (!locked.committed) throw new HttpsError('aborted', 'Migration transport fence was superseded.')
    const data = (await room.get()).val() ?? {},
      legacy = head.generation === 1 ? (data.elements ?? {}) : {},
      scoped = data.generations?.[head.generation]?.elements ?? {}
    if (head.historyProtocolVersion !== 1 && (Object.keys(legacy).length || Object.keys(scoped).length)) {
      const { scene } = await loadSceneRevision(boardId, head),
        elements = new Map(scene.elements.map((element: any) => [element.id, element]))
      for (const record of Object.values({ ...legacy, ...scoped }) as any[]) {
        let element: any
        try {
          element = typeof record.data === 'string' ? JSON.parse(record.data) : (record.element ?? record)
        } catch {
          continue
        }
        const previous: any = elements.get(element.id)
        if (
          element.id &&
          (!previous ||
            element.version > previous.version ||
            (element.version === previous.version && element.versionNonce < previous.versionNonce))
        )
          elements.set(element.id, element)
      }
      await checkpointScene(
        boardId,
        { ...scene, elements: [...elements.values()] },
        head,
        { uid: head.ownerId, trusted: true },
        migrationId,
      )
    }
    // Fence new transport before publishing the client-visible protocol switch.
    const switched = await room.transaction((current) => {
      if (current?.restoreOperationId !== migrationId || current.restoreFence !== head.restoreFence) return
      const generations = {
        ...current.generations,
        [head.generation]: { ...current.generations?.[head.generation], elements: { ...legacy, ...scoped } },
      }
      const next = { ...current, historyProtocolVersion: 1, generation: head.generation, generations }
      delete next.elements
      return next
    })
    if (!switched.committed) throw new HttpsError('aborted', 'Migration switch fence was superseded.')
    await db.runTransaction(async (tx) => {
      const latest = (await tx.get(ref)).data()!
      await authorizeScene(boardId, latest as SceneBinding, actor, tx)
      const privateRef = latest.projectId
          ? db.doc(`users/${latest.ownerId}/projects/${latest.projectId}/boards/${boardId}`)
          : null,
        privateDoc = privateRef ? await tx.get(privateRef) : null,
        shareDoc = await tx.get(db.doc(`boardShares/${boardId}`))
      if (
        latest.restoreOperationId !== migrationId ||
        latest.migrationLeaseId !== leaseId ||
        latest.migrationLeaseUntil.toMillis() <= Date.now()
      )
        throw new HttpsError('aborted', 'Migration lease was superseded.')
      if (privateDoc?.data()?.scene) {
        tx.set(db.doc(`${root}/legacyArchive/private`), {
          scene: privateDoc.data()!.scene,
          archivedAt: Timestamp.now(),
          expiresAt: Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000),
        })
        tx.update(privateRef!, { scene: FieldValue.delete() })
      }
      if (shareDoc.data()?.scene) {
        tx.set(db.doc(`${root}/legacyArchive/share`), {
          scene: shareDoc.data()!.scene,
          archivedAt: Timestamp.now(),
          expiresAt: Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000),
        })
        tx.update(shareDoc.ref, { scene: FieldValue.delete() })
      }
      tx.update(ref, { historyProtocolVersion: 1, chunkReferencesReady: true })
    })
    const unlocked = await room.transaction((current) => {
      if (current?.restoreOperationId !== migrationId || current.restoreFence !== head.restoreFence) return
      return { ...current, restoreOperationId: null }
    })
    if (!unlocked.committed) throw new HttpsError('aborted', 'Migration unlock fence was superseded.')
    await db.runTransaction(async (tx) => {
      const latest = (await tx.get(ref)).data()!
      if (
        latest.restoreOperationId !== migrationId ||
        latest.migrationLeaseId !== leaseId ||
        latest.migrationLeaseUntil.toMillis() <= Date.now()
      )
        throw new HttpsError('aborted', 'Migration unlock lease was superseded.')
      tx.update(ref, { restoreOperationId: null, migrationLeaseUntil: null })
    })
    return (await ref.get()).data()!
  } finally {
    room.off('value', holdRoom)
  }
}
