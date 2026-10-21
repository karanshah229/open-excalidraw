import { randomUUID } from 'node:crypto'
import {
  getFirestore,
  Timestamp,
  type DocumentData,
  type Transaction,
  type DocumentReference,
} from 'firebase-admin/firestore'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'
import { defineBoolean, defineString } from 'firebase-functions/params'
import { authorizeScene, type SceneActor, type SceneBinding } from './scene-access.js'
import {
  compactFencedTombstones,
  observeSceneTombstones,
  reconcileElementsAndDeletionLedger,
} from './scene-deletion-ledger.js'
import {
  packScene,
  assembleScene,
  canonicalStringify,
  digestString,
  manifestDigest,
  paginateReferences,
  SCENE_FORMAT_VERSION,
  SCENE_PROTOCOL_VERSION,
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
const LAYOUT_REPACK_COOLDOWN_MS = 24 * 60 * 60_000
const LEASE_MS = 120_000
const READ_PIN_MS = 5 * 60_000
const MAX_READ_PIN_LIFETIME_MS = 30 * 60_000
const MAX_ACTIVE_READ_PINS_PER_ACTOR = 5
// Callable responses are JSON encoded. Eight maximum-size chunks are about 4 MiB;
// leave ample room below the callable response ceiling for IDs and envelope fields.
const MAX_SCENE_READ_CHUNKS = 8
const MAX_SCENE_READ_BYTES = 4 * 1024 * 1024
type SceneControl = { admission: 'open' | 'closed'; epoch: number }
const controlRefFor = (boardId: string) => getFirestore().doc(`boardScenes/${boardId}/maintenance/control`)
const maintenanceError = () =>
  new HttpsError('unavailable', 'Board maintenance is in progress.', {
    reason: 'maintenance',
    retryAfterMs: 1000,
  })
function validateControl(data: DocumentData | undefined): SceneControl {
  if (!data) return { admission: 'open', epoch: 1 }
  if ((data.admission !== 'open' && data.admission !== 'closed') || !Number.isSafeInteger(data.epoch) || data.epoch < 1)
    throw new HttpsError('failed-precondition', 'Invalid scene maintenance control.')
  return data as SceneControl
}
function assertControlOpen(control: SceneControl) {
  if (control.admission !== 'open') throw maintenanceError()
}
function initializeControl(tx: Transaction, ref: DocumentReference, data: DocumentData | undefined) {
  if (!data)
    tx.create(ref, {
      admission: 'open',
      epoch: 1,
      jobId: null,
      token: null,
      leaseUntil: null,
      updatedAt: Timestamp.now(),
    })
}
function touchControl(tx: Transaction, ref: DocumentReference, data: DocumentData | undefined) {
  const now = Timestamp.now()
  if (!data)
    tx.create(ref, {
      admission: 'open',
      epoch: 1,
      jobId: null,
      token: null,
      leaseUntil: null,
      updatedAt: now,
      lastSceneWriterAt: now,
    })
  else tx.update(ref, { lastSceneWriterAt: now })
}
async function releaseInternalReadPin(boardId: string, pinRef: DocumentReference, actor: SceneActor) {
  const db = getFirestore(),
    controlRef = controlRefFor(boardId),
    headRef = db.doc(`boardScenes/${boardId}`)
  await db.runTransaction(async (tx) => {
    const controlData = (await tx.get(controlRef)).data(),
      head = (await tx.get(headRef)).data(),
      pin = (await tx.get(pinRef)).data()
    if (!head || !pin || pin.uid !== actor.uid) return
    await authorizeScene(boardId, head as SceneBinding, actor, tx, false)
    validateControl(controlData)
    initializeControl(tx, controlRef, controlData)
    tx.delete(pinRef)
  })
}
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
function requireSceneProtocol(value: unknown): void {
  if (value !== SCENE_PROTOCOL_VERSION)
    throw new HttpsError('failed-precondition', 'This board requires a newer client. Reload the app to continue.', {
      reason: 'client-upgrade-required',
      minimumSceneProtocolVersion: SCENE_PROTOCOL_VERSION,
    })
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
  const merged = reconcileElementsAndDeletionLedger(
    left?.elements ?? [],
    right?.elements ?? [],
    left?.deletionLedger ?? [],
    right?.deletionLedger ?? [],
  )
  return normalizeScene({
    ...left,
    ...right,
    elements: merged.elements,
    deletionLedger: merged.deletionLedger,
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
  if (existing) {
    if (requestedProjectId && existing.projectId !== requestedProjectId)
      throw new HttpsError('permission-denied', 'Scene project binding does not match the requested project.')
    await authorizeScene(boardId, existing as SceneBinding, actor, undefined, false)
    if (existing.headRevisionId) return existing
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
      const controlData = (await tx.get(controlRefFor(boardId))).data()
      const reserved = (await tx.get(ref)).data()
      const control = validateControl(controlData)
      assertControlOpen(control)
      await authorizeScene(boardId, binding, actor, tx, false)
      touchControl(tx, controlRefFor(boardId), controlData)
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
    const maintenanceJobId = `bootstrap_${revisionId}`
    const controlRef = controlRefFor(boardId),
      jobRef = db.doc(`${root}/maintenanceJobs/${maintenanceJobId}`)
    const bootstrapToken = randomUUID()
    const bootstrapEpoch = await db.runTransaction(async (tx) => {
      const controlData = (await tx.get(controlRef)).data(),
        current = (await tx.get(ref)).data(),
        existingJob = (await tx.get(jobRef)).data()
      const control = validateControl(controlData)
      assertControlOpen(control)
      if (!current || current.ownerId !== ownerId || current.projectId !== projectId || current.headRevisionId)
        throw new HttpsError('aborted', 'Board bootstrap reservation changed.')
      await authorizeScene(boardId, binding, actor, tx, false)
      touchControl(tx, controlRef, controlData)
      if (!existingJob)
        tx.create(jobRef, {
          status: 'running',
          ownerId,
          leaseUntil: Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000),
          protectedRevisionIds: [revisionId],
          protectedChunkIds: packed.map((chunk) => chunk.chunkId),
          epoch: control.epoch,
          token: bootstrapToken,
          createdAt: Timestamp.now(),
          kind: 'bootstrap',
        })
      else if (existingJob.token !== bootstrapToken)
        throw new HttpsError('already-exists', 'Bootstrap job ID is already in use.')
      return control.epoch
    })
    const retireBootstrapJob = async () =>
      db.runTransaction(async (tx) => {
        const controlData = (await tx.get(controlRef)).data(),
          job = await tx.get(jobRef)
        const currentControl = validateControl(controlData)
        if (
          job.exists &&
          job.data()?.status === 'running' &&
          job.data()?.token === bootstrapToken &&
          currentControl.epoch === bootstrapEpoch
        )
          tx.update(jobRef, { status: 'cancelled', leaseUntil: null, cancelledAt: Timestamp.now() })
      })
    try {
      // Reservation is durable before BulkWriter starts: GC must census maintenanceJobs and
      // preserve these complete output roots until this bootstrap publishes or is recovered.
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
        const controlData = (await tx.get(controlRef)).data(),
          current = await tx.get(ref),
          job = await tx.get(jobRef)
        const control = validateControl(controlData)
        assertControlOpen(control)
        await authorizeScene(boardId, binding, actor, tx, false)
        const privateNow = privateRef ? await tx.get(privateRef) : null,
          shareNow = await tx.get(shareSnapshot.ref),
          assetNow = await tx.get(location.ref)
        initializeControl(tx, controlRef, controlData)
        if (current.data()?.ownerId !== ownerId || current.data()?.projectId !== projectId)
          throw new HttpsError('permission-denied', 'Scene ownership changed.')
        if (
          control.epoch !== bootstrapEpoch ||
          !job.exists ||
          job.data()?.epoch !== control.epoch ||
          job.data()?.status !== 'running' ||
          job.data()?.token !== bootstrapToken
        )
          throw new HttpsError('aborted', 'Bootstrap maintenance fence changed.')
        if (current.data()?.headRevisionId) {
          if (
            job.exists &&
            job.data()?.status === 'running' &&
            job.data()?.token === bootstrapToken &&
            job.data()?.epoch === control.epoch
          )
            tx.update(jobRef, {
              status: 'cancelled',
              leaseUntil: null,
              cancelledAt: Timestamp.now(),
              outcome: 'head-already-published',
            })
          return current.data()!
        }
        if (assetNow.exists && (assetNow.data()?.ownerId !== ownerId || assetNow.data()?.projectId !== projectId))
          dataError('Scene and asset ownership disagree.')
        if (
          (privateRef && !privateNow?.updateTime?.isEqual(privateSnapshot!.updateTime!)) ||
          shareNow.exists !== shareSnapshot.exists ||
          (shareNow.exists && !shareNow.updateTime?.isEqual(shareSnapshot.updateTime!))
        )
          return null
        const head = {
          ...binding,
          headRevisionId: revisionId,
          generation,
          sceneFormatVersion: SCENE_FORMAT_VERSION,
          updatedAt: new Date().toISOString(),
        }
        tx.set(ref, head)
        tx.update(jobRef, { status: 'complete', leaseUntil: null, completedAt: Timestamp.now() })
        // Embedded payloads retained read-only for recovery. Rules disallow further scene updates after cutover.
        if (privateRef) tx.update(privateRef, { sceneId: boardId })
        if (shareNow.exists) tx.update(shareNow.ref, { sceneId: boardId })
        return head
      })
      if (result) return result
      await retireBootstrapJob()
    } catch (error) {
      // BulkWriter.close settles every queued write before this path retires the root.
      await retireBootstrapJob()
      throw error
    }
  }
  throw new HttpsError('aborted', 'The board changed during migration. Retry registration.')
}

export async function commitSceneCandidate(boardId: string, commitId: string, actor: SceneActor) {
  const db = getFirestore(),
    root = `boardScenes/${boardId}`,
    headRef = db.doc(root),
    candidateRef = db.doc(`${root}/uploads/${commitId}`),
    controlRef = controlRefFor(boardId),
    leaseId = randomUUID()
  const state = await db.runTransaction(async (tx) => {
    const controlData = (await tx.get(controlRef)).data(),
      head = (await tx.get(headRef)).data(),
      candidate = (await tx.get(candidateRef)).data()
    if (!head || !candidate) dataError('Restage required: missing scene or upload.')
    const control = validateControl(controlData)
    assertControlOpen(control)
    if (!head.headRevisionId)
      dataError('Initial scene migration is pending. Complete registration before staging a save.')
    await authorizeScene(boardId, head as SceneBinding, actor, tx)
    const maintenanceJob = candidate.maintenanceJobId
      ? (await tx.get(db.doc(`${root}/maintenanceJobs/${candidate.maintenanceJobId}`))).data()
      : undefined
    initializeControl(tx, controlRef, controlData)
    if (candidate.uploaderUid !== actor.uid)
      throw new HttpsError('permission-denied', 'Upload belongs to another actor.')
    if (candidate.receipt) return { head, candidate, receipt: candidate.receipt }
    if (
      candidate.maintenanceJobId &&
      (!maintenanceJob ||
        maintenanceJob.status !== 'running' ||
        maintenanceJob.token !== candidate.maintenanceJobToken ||
        maintenanceJob.epoch !== control.epoch)
    )
      throw new HttpsError('failed-precondition', 'Checkpoint maintenance job was fenced.')
    if (
      candidate.generation !== head.generation ||
      candidate.expectedHeadRevisionId !== head.headRevisionId ||
      candidate.maintenanceEpoch !== control.epoch
    )
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
      candidate.sceneFormatVersion !== SCENE_FORMAT_VERSION ||
      candidate.sceneProtocolVersion !== SCENE_PROTOCOL_VERSION
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
    const base = await loadSceneRevision(boardId, head),
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
    // Client commits may carry existing deletion metadata, but cannot invent or
    // rewrite its server-observed clock. Trusted checkpoints create observations.
    if (
      !candidate.maintenanceJobId &&
      canonicalStringify(scene.deletionLedger ?? []) !== canonicalStringify(base.scene.deletionLedger ?? [])
    )
      dataError('Deletion metadata is server managed; reload the board and retry.')
    validateAssets(boardId, head.ownerId, scene)
    const revisionId = commitId
    // Stage immutable server manifests once; retries preserve the original timestamp and bytes.
    const createdAt = await db.runTransaction(async (tx) => {
      const revisionRef = db.doc(`${root}/revisions/${revisionId}`),
        controlData = (await tx.get(controlRef)).data(),
        headNow = (await tx.get(headRef)).data(),
        uploadNow = (await tx.get(candidateRef)).data(),
        previous = (await tx.get(revisionRef)).data(),
        maintenanceJob = uploadNow?.maintenanceJobId
          ? (await tx.get(db.doc(`${root}/maintenanceJobs/${uploadNow.maintenanceJobId}`))).data()
          : undefined
      const control = validateControl(controlData)
      assertControlOpen(control)
      if (
        !headNow ||
        !uploadNow ||
        headNow.headRevisionId !== candidate.expectedHeadRevisionId ||
        headNow.generation !== candidate.generation ||
        uploadNow.maintenanceEpoch !== control.epoch
      )
        throw new HttpsError('aborted', 'Scene revision changed during validation.')
      if (
        uploadNow.maintenanceJobId &&
        (!maintenanceJob ||
          maintenanceJob.status !== 'running' ||
          maintenanceJob.token !== uploadNow.maintenanceJobToken ||
          maintenanceJob.epoch !== control.epoch)
      )
        throw new HttpsError('failed-precondition', 'Checkpoint maintenance job was fenced.')
      initializeControl(tx, controlRef, controlData)
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
        sceneProtocolVersion: candidate.sceneProtocolVersion,
        pageCount: candidate.pageCount,
        chunkCount: candidate.chunkCount,
        candidateDigest: candidate.candidateDigest,
        parentRevisionId: candidate.expectedHeadRevisionId,
        ...(candidate.maintenanceReason
          ? {
              reason: 'maintenance',
              maintenanceReason: candidate.maintenanceReason,
              ...(Number.isSafeInteger(candidate.compactedTombstoneCount)
                ? { compactedTombstoneCount: candidate.compactedTombstoneCount }
                : {}),
              ...(candidate.maintenanceReason === 'layout-repack'
                ? {
                    repackFromChunkCount: candidate.repackFromChunkCount,
                    repackToChunkCount: candidate.repackToChunkCount,
                    repackBytesBefore: candidate.repackBytesBefore,
                    repackBytesAfter: candidate.repackBytesAfter,
                  }
                : {}),
            }
          : {}),
        createdAt,
      })
      return createdAt
    })
    return await db.runTransaction(async (tx) => {
      const controlData = (await tx.get(controlRef)).data(),
        latest = (await tx.get(headRef)).data(),
        upload = (await tx.get(candidateRef)).data(),
        jobRef = upload?.maintenanceJobId ? db.doc(`${root}/maintenanceJobs/${upload.maintenanceJobId}`) : null,
        job = jobRef ? await tx.get(jobRef) : null
      if (!latest || !upload) dataError('Restage required.')
      const control = validateControl(controlData)
      assertControlOpen(control)
      await authorizeScene(boardId, latest as SceneBinding, actor, tx)
      initializeControl(tx, controlRef, controlData)
      if (upload.receipt) return upload.receipt
      if (
        upload.maintenanceEpoch !== control.epoch ||
        upload.leaseId !== leaseId ||
        milliseconds(upload.leaseUntil) <= Date.now()
      )
        dataError('Validation lease expired. Retry publication.')
      if (
        jobRef &&
        (!job?.exists ||
          job.data()?.status !== 'running' ||
          job.data()?.token !== upload.maintenanceJobToken ||
          job.data()?.epoch !== control.epoch)
      )
        throw new HttpsError('failed-precondition', 'Checkpoint maintenance job was fenced.')
      if (latest.headRevisionId !== candidate.expectedHeadRevisionId || latest.generation !== candidate.generation)
        throw new HttpsError('aborted', 'Scene revision changed.', {
          currentHeadRevisionId: latest.headRevisionId,
          generation: latest.generation,
        })
      const receipt = {
        revisionId,
        generation: latest.generation,
        candidateDigest: candidate.candidateDigest,
        committedAt: createdAt,
      }
      tx.update(headRef, {
        headRevisionId: revisionId,
        updatedAt: createdAt,
        ...(candidate.maintenanceReason === 'layout-repack' ? { lastLayoutRepackAt: Timestamp.now() } : {}),
      })
      tx.update(candidateRef, { receipt, status: 'committed', leaseId: null, leaseUntil: null })
      if (jobRef && job?.exists)
        tx.update(jobRef, { status: 'complete', leaseUntil: null, completedAt: Timestamp.now() })
      return receipt
    })
  } finally {
    await db.runTransaction(async (tx) => {
      validateControl((await tx.get(controlRef)).data())
      const upload = (await tx.get(candidateRef)).data()
      if (upload?.leaseId === leaseId) tx.update(candidateRef, { leaseId: null, leaseUntil: null })
    })
  }
}
function validateAssets(boardId: string, ownerId: string, scene: ScenePayload) {
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
  updateScene: (baseScene: ScenePayload) => ScenePayload,
  head: DocumentData,
  actor: SceneActor,
  options: { layoutRepack?: boolean; compactTombstones?: boolean } = {},
) {
  const db = getFirestore(),
    root = `boardScenes/${boardId}`,
    commitId = `checkpoint_${randomUUID()}`
  // Pin the exact base before the trusted Admin reader fetches pages and chunks.
  const controlRef = controlRefFor(boardId),
    headRef = db.doc(root),
    readPinId = randomUUID(),
    readPinRef = db.doc(`${root}/readerPins/${readPinId}`)
  await db.runTransaction(async (tx) => {
    const controlData = (await tx.get(controlRef)).data(),
      latest = (await tx.get(headRef)).data()
    if (!latest) throw new HttpsError('not-found', 'Board scene does not exist.')
    await authorizeScene(boardId, latest as SceneBinding, actor, tx, false)
    const control = validateControl(controlData)
    assertControlOpen(control)
    if (
      latest.headRevisionId !== head.headRevisionId ||
      latest.generation !== head.generation ||
      !latest.headRevisionId
    )
      throw new HttpsError('aborted', 'Scene revision changed before checkpoint read.')
    if (options.layoutRepack && milliseconds(latest.lastLayoutRepackAt) > Date.now() - LAYOUT_REPACK_COOLDOWN_MS)
      throw new HttpsError('failed-precondition', 'Scene layout repacking is cooling down.', {
        reason: 'repack-cooldown',
      })
    // The user-facing read quota must not prevent the trusted maintenance
    // checkpoint from preserving its own exact source revision. Maintenance
    // already holds the board write fence and its pin is released in `finally`.
    if (!options.layoutRepack && !options.compactTombstones) {
      const pinNow = Timestamp.now()
      const activePins = await tx.get(
        db
          .collection(`${root}/readerPins`)
          .where('uid', '==', actor.uid)
          .where('expiresAt', '>', pinNow)
          .limit(MAX_ACTIVE_READ_PINS_PER_ACTOR),
      )
      if (activePins.size >= MAX_ACTIVE_READ_PINS_PER_ACTOR)
        throw new HttpsError('resource-exhausted', 'Too many active board reads.')
    }
    initializeControl(tx, controlRef, controlData)
    const now = Timestamp.now(),
      expiresAt = Timestamp.fromMillis(now.toMillis() + 15 * 60_000)
    tx.create(readPinRef, {
      uid: actor.uid,
      ownerId: latest.ownerId,
      generation: latest.generation,
      sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
      revisionIds: [latest.headRevisionId],
      purpose: 'checkpoint-base',
      createdAt: now,
      expiresAt,
      maxExpiresAt: expiresAt,
    })
  })
  let base: Awaited<ReturnType<typeof loadSceneRevision>>
  let chunks: PackedChunk[]
  let compactedTombstoneCount = 0
  try {
    // This is the trusted reader's first payload read; the pin above protects it.
    base = await loadSceneRevision(boardId, head)
    const updated = updateScene(base.scene)
    const observed = observeSceneTombstones(
      base.scene.elements,
      updated.elements,
      base.scene.deletionLedger ?? [],
      Date.now(),
    )
    const compacted = options.compactTombstones
      ? compactFencedTombstones(
          observed.elements,
          observed.deletionLedger,
          observed.deletionLedger.filter((record) => !record.compacted).map((record) => record.id),
        )
      : null
    compactedTombstoneCount = compacted?.compactedIds.length ?? 0
    const scene = {
      ...updated,
      elements: compacted?.elements ?? observed.elements,
      deletionLedger: compacted?.deletionLedger ?? observed.deletionLedger,
    }
    if (!options.layoutRepack && canonicalStringify(scene) === canonicalStringify(base.scene)) {
      await releaseInternalReadPin(boardId, readPinRef, actor)
      return { status: 'no-op', reason: 'scene-unchanged', compactedTombstoneCount: 0 }
    }
    const priorIds = new Set(base.references.map((ref) => ref.chunkId))
    let freshSlot = 0
    if (options.layoutRepack) {
      const repacked = await packScene(scene)
      const beforeCount = base.references.length,
        afterCount = repacked.length
      if (beforeCount - afterCount < 2 || afterCount > Math.floor(beforeCount * 0.75)) {
        await releaseInternalReadPin(boardId, readPinRef, actor)
        return {
          status: 'no-op',
          reason: 'below-savings-threshold',
          beforeChunkCount: beforeCount,
          afterChunkCount: afterCount,
        }
      }
      const reusable = new Map(base.chunks.map((chunk) => [`${chunk.digest}:${chunk.payload}`, chunk.chunkId]))
      chunks = repacked.map((chunk) => {
        const existingId = reusable.get(`${chunk.digest}:${chunk.payload}`)
        return existingId
          ? { ...chunk, chunkId: existingId }
          : { ...chunk, chunkId: `${commitId}_${scenePageId(freshSlot++)}` }
      })
      const totalBytes = chunks.reduce((sum, chunk) => sum + chunkDocumentBytes(chunk.payload), 0)
      if (chunks.length > MAX_CHUNKS || totalBytes > MAX_BYTES) {
        await releaseInternalReadPin(boardId, readPinRef, actor)
        throw new HttpsError('resource-exhausted', 'Repacked scene exceeds the scene storage budget.')
      }
    } else {
      chunks = (await packScene(scene, base.chunks)).map((chunk) =>
        priorIds.has(chunk.chunkId) ? chunk : { ...chunk, chunkId: `${commitId}_${scenePageId(freshSlot++)}` },
      )
    }
  } catch (error) {
    try {
      await releaseInternalReadPin(boardId, readPinRef, actor)
    } catch {
      /* Lease expiry is the fallback. */
    }
    throw error
  }
  const references = chunks.map(({ chunkId, digest }) => ({ chunkId, digest })),
    pages = paginateReferences(references)
  const oldIds = new Set(base.references.map((ref) => ref.chunkId)),
    newChunks = chunks.filter((chunk) => !oldIds.has(chunk.chunkId)),
    writer = db.bulkWriter(),
    now = Timestamp.now()
  const uploadRef = db.doc(`${root}/uploads/${commitId}`)
  const maintenanceJobId = `checkpoint_${commitId}`,
    maintenanceJobToken = randomUUID(),
    jobRef = db.doc(`${root}/maintenanceJobs/${maintenanceJobId}`)
  try {
    await db.runTransaction(async (tx) => {
      const controlData = (await tx.get(controlRef)).data(),
        latest = (await tx.get(headRef)).data(),
        existingUpload = (await tx.get(uploadRef)).data(),
        pin = await tx.get(readPinRef)
      const control = validateControl(controlData)
      assertControlOpen(control)
      if (!latest || latest.headRevisionId !== head.headRevisionId || latest.generation !== head.generation)
        throw new HttpsError('aborted', 'Scene revision changed before checkpoint staging.')
      await authorizeScene(boardId, latest as SceneBinding, actor, tx)
      if (
        !pin.exists ||
        pin.data()?.uid !== actor.uid ||
        pin.data()?.generation !== head.generation ||
        !Array.isArray(pin.data()?.revisionIds) ||
        !pin.data()!.revisionIds.includes(head.headRevisionId) ||
        milliseconds(pin.data()?.expiresAt) <= Date.now()
      )
        throw new HttpsError('failed-precondition', 'Checkpoint base read pin expired.')
      touchControl(tx, controlRef, controlData)
      if (existingUpload) throw new HttpsError('already-exists', 'Checkpoint ID is already in use.')
      tx.create(jobRef, {
        status: 'running',
        ownerId: head.ownerId,
        leaseUntil: Timestamp.fromMillis(now.toMillis() + 24 * 60 * 60_000),
        protectedRevisionIds: [head.headRevisionId],
        protectedChunkIds: newChunks.map((chunk) => chunk.chunkId),
        epoch: control.epoch,
        token: maintenanceJobToken,
        createdAt: now,
        kind: options.layoutRepack
          ? 'layout-repack'
          : options.compactTombstones
            ? 'tombstone-compaction'
            : 'checkpoint',
      })
      tx.create(uploadRef, {
        uploaderUid: actor.uid,
        expectedHeadRevisionId: head.headRevisionId,
        generation: head.generation,
        sceneFormatVersion: SCENE_FORMAT_VERSION,
        sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
        pageCount: pages.length,
        chunkCount: chunks.length,
        newChunkCount: newChunks.length,
        candidateDigest: await manifestDigest(references, head.generation),
        maintenanceEpoch: control.epoch,
        maintenanceJobId,
        maintenanceJobToken,
        ...(options.layoutRepack || options.compactTombstones
          ? {
              maintenanceReason: options.layoutRepack ? 'layout-repack' : 'tombstone-compaction',
              ...(options.compactTombstones ? { compactedTombstoneCount } : {}),
            }
          : {}),
        ...(options.layoutRepack
          ? {
              repackFromChunkCount: base.references.length,
              repackToChunkCount: chunks.length,
              repackBytesBefore: base.chunks.reduce((sum, chunk) => sum + chunkDocumentBytes(chunk.payload), 0),
              repackBytesAfter: chunks.reduce((sum, chunk) => sum + chunkDocumentBytes(chunk.payload), 0),
            }
          : {}),
        createdAt: now,
        expiresAt: Timestamp.fromMillis(now.toMillis() + 60 * 60 * 1000),
      })
      tx.delete(readPinRef)
    })
  } catch (error) {
    // Admission may have closed after the pinned base read. Pin release remains safe
    // during closure because this transaction reads the shared fence before deleting.
    try {
      await releaseInternalReadPin(boardId, readPinRef, actor)
    } catch {
      /* Lease expiry is the fallback. */
    }
    throw error
  }
  let writerSettled = false
  try {
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
    writerSettled = true
    return await commitSceneCandidate(boardId, commitId, actor)
  } catch (error) {
    if (!writerSettled) {
      try {
        await writer.close()
      } catch {
        /* close settles queued writes before the job root is retired */
      }
    }
    // Once BulkWriter has settled, an open unchanged epoch can safely retire this root;
    // if maintenance closed admission, preserve it for the maintenance recovery pass.
    await db.runTransaction(async (tx) => {
      const controlData = (await tx.get(controlRef)).data(),
        job = await tx.get(jobRef)
      const control = validateControl(controlData)
      if (job.exists && job.data()?.status === 'running' && control.epoch === job.data()?.epoch)
        tx.update(jobRef, { status: 'cancelled', leaseUntil: null, cancelledAt: Timestamp.now() })
    })
    throw error
  }
}

/** Owner-triggered deterministic layout rewrite; the ordinary save path never changes membership. */
export async function repackBoardSceneNow(boardId: string, actor: SceneActor) {
  const head = (await getFirestore().doc(`boardScenes/${boardId}`).get()).data()
  if (!head) throw new HttpsError('not-found', 'Board scene does not exist.')
  if (head.ownerId !== actor.uid)
    throw new HttpsError('permission-denied', 'Only the board owner can repack its scene.')
  return checkpointScene(boardId, (scene) => scene, head, actor, { layoutRepack: true })
}

/** Client writes are admitted only through these fenced callables; every write transaction reads control. */
export const beginBoardSceneUpload = onCall({ region, enforceAppCheck: appCheck.value() }, async (request) => {
  const boardId = id(request.data?.boardId),
    commitId = id(request.data?.commitId),
    actor = actorOf(request)
  const expectedHeadRevisionId = id(request.data?.expectedHeadRevisionId)
  const { generation, sceneFormatVersion, pageCount, chunkCount, newChunkCount, candidateDigest } = request.data ?? {}
  requireSceneProtocol(request.data?.sceneProtocolVersion)
  if (
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    sceneFormatVersion !== SCENE_FORMAT_VERSION ||
    !Number.isSafeInteger(pageCount) ||
    pageCount < 1 ||
    pageCount > MAX_PAGES ||
    !Number.isSafeInteger(chunkCount) ||
    chunkCount < 1 ||
    chunkCount > MAX_CHUNKS ||
    !Number.isSafeInteger(newChunkCount) ||
    newChunkCount < 0 ||
    newChunkCount > chunkCount ||
    typeof candidateDigest !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(candidateDigest)
  )
    throw new HttpsError('invalid-argument', 'Invalid scene upload metadata.')
  const db = getFirestore(),
    root = `boardScenes/${boardId}`
  const uploadRef = db.doc(`${root}/uploads/${commitId}`),
    headRef = db.doc(root),
    controlRef = controlRefFor(boardId)
  const now = Timestamp.now(),
    expiresAt = Timestamp.fromMillis(now.toMillis() + 23 * 60 * 60_000)
  return db.runTransaction(async (tx) => {
    const controlData = (await tx.get(controlRef)).data(),
      head = (await tx.get(headRef)).data(),
      old = (await tx.get(uploadRef)).data()
    if (!head) throw new HttpsError('not-found', 'Board scene is not initialized.')
    await authorizeScene(boardId, head as SceneBinding, actor, tx)
    const control = validateControl(controlData)
    assertControlOpen(control)
    initializeControl(tx, controlRef, controlData)
    if (!head.headRevisionId || head.headRevisionId !== expectedHeadRevisionId || head.generation !== generation)
      throw new HttpsError('aborted', 'Scene revision changed.', {
        currentHeadRevisionId: head.headRevisionId ?? null,
        generation: head.generation,
      })
    if (old) {
      if (
        old.uploaderUid === actor.uid &&
        old.candidateDigest === candidateDigest &&
        old.expectedHeadRevisionId === expectedHeadRevisionId &&
        old.generation === generation &&
        old.maintenanceEpoch === control.epoch &&
        milliseconds(old.expiresAt) > now.toMillis()
      )
        return {
          epoch: control.epoch,
          createdAt: old.createdAt.toDate?.().toISOString?.() ?? old.createdAt,
          expiresAt: old.expiresAt.toDate?.().toISOString?.() ?? old.expiresAt,
        }
      throw new HttpsError('already-exists', 'Upload ID is already in use.')
    }
    tx.create(uploadRef, {
      uploaderUid: actor.uid,
      expectedHeadRevisionId,
      generation,
      sceneFormatVersion,
      pageCount,
      chunkCount,
      newChunkCount,
      candidateDigest,
      sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
      maintenanceEpoch: control.epoch,
      createdAt: now,
      expiresAt,
    })
    return { epoch: control.epoch, createdAt: now.toDate().toISOString(), expiresAt: expiresAt.toDate().toISOString() }
  })
})

export const stageBoardSceneChunk = onCall({ region, enforceAppCheck: appCheck.value() }, async (request) => {
  const boardId = id(request.data?.boardId),
    commitId = id(request.data?.commitId),
    actor = actorOf(request)
  const { slot, payload, digest } = request.data ?? {}
  requireSceneProtocol(request.data?.sceneProtocolVersion)
  if (
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    typeof payload !== 'string' ||
    chunkDocumentBytes(payload) > CHUNK_BUDGET_BYTES ||
    typeof digest !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(digest) ||
    (await digestString(payload)) !== digest
  )
    throw new HttpsError('invalid-argument', 'Invalid scene chunk.')
  const db = getFirestore(),
    root = `boardScenes/${boardId}`,
    controlRef = controlRefFor(boardId)
  const headRef = db.doc(root),
    uploadRef = db.doc(`${root}/uploads/${commitId}`),
    chunkRef = db.doc(`${root}/chunks/${commitId}_${scenePageId(slot)}`)
  return db.runTransaction(async (tx) => {
    const controlData = (await tx.get(controlRef)).data(),
      head = (await tx.get(headRef)).data(),
      upload = (await tx.get(uploadRef)).data(),
      old = (await tx.get(chunkRef)).data()
    if (!head || !upload) throw new HttpsError('not-found', 'Upload does not exist.')
    await authorizeScene(boardId, head as SceneBinding, actor, tx)
    const control = validateControl(controlData)
    assertControlOpen(control)
    initializeControl(tx, controlRef, controlData)
    if (
      upload.uploaderUid !== actor.uid ||
      upload.maintenanceEpoch !== control.epoch ||
      milliseconds(upload.expiresAt) <= Date.now() ||
      upload.generation !== head.generation ||
      upload.sceneProtocolVersion !== SCENE_PROTOCOL_VERSION ||
      !head.headRevisionId ||
      upload.expectedHeadRevisionId !== head.headRevisionId ||
      slot >= upload.newChunkCount ||
      upload.status === 'committed'
    )
      throw new HttpsError('failed-precondition', 'Upload is no longer writable.')
    if (old) {
      if (
        old.uploadId === commitId &&
        old.slot === slot &&
        old.digest === digest &&
        old.payload === payload &&
        old.uploaderUid === actor.uid
      )
        return { staged: true }
      throw new HttpsError('already-exists', 'Chunk slot is already staged.')
    }
    tx.create(chunkRef, {
      payload,
      digest,
      uploadId: commitId,
      slot,
      uploaderUid: actor.uid,
      generation: head.generation,
      kind: 'records',
    })
    return { staged: true }
  })
})

export const stageBoardScenePage = onCall({ region, enforceAppCheck: appCheck.value() }, async (request) => {
  const boardId = id(request.data?.boardId),
    commitId = id(request.data?.commitId),
    actor = actorOf(request)
  const { pageIndex, references } = request.data ?? {}
  requireSceneProtocol(request.data?.sceneProtocolVersion)
  if (
    !Number.isSafeInteger(pageIndex) ||
    pageIndex < 0 ||
    !Array.isArray(references) ||
    references.length < 1 ||
    references.length > 100 ||
    references.some(
      (ref: any) =>
        !ref ||
        typeof ref.chunkId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,160}$/.test(ref.chunkId) ||
        typeof ref.digest !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(ref.digest),
    )
  )
    throw new HttpsError('invalid-argument', 'Invalid scene manifest page.')
  const db = getFirestore(),
    root = `boardScenes/${boardId}`,
    controlRef = controlRefFor(boardId),
    headRef = db.doc(root)
  const uploadRef = db.doc(`${root}/uploads/${commitId}`),
    pageRef = db.doc(`${root}/uploads/${commitId}/pages/${scenePageId(pageIndex)}`)
  return db.runTransaction(async (tx) => {
    const controlData = (await tx.get(controlRef)).data(),
      head = (await tx.get(headRef)).data(),
      upload = (await tx.get(uploadRef)).data(),
      old = (await tx.get(pageRef)).data()
    if (!head || !upload) throw new HttpsError('not-found', 'Upload does not exist.')
    await authorizeScene(boardId, head as SceneBinding, actor, tx)
    const control = validateControl(controlData)
    assertControlOpen(control)
    initializeControl(tx, controlRef, controlData)
    if (
      upload.uploaderUid !== actor.uid ||
      upload.maintenanceEpoch !== control.epoch ||
      milliseconds(upload.expiresAt) <= Date.now() ||
      upload.generation !== head.generation ||
      upload.sceneProtocolVersion !== SCENE_PROTOCOL_VERSION ||
      !head.headRevisionId ||
      upload.expectedHeadRevisionId !== head.headRevisionId ||
      pageIndex >= upload.pageCount ||
      upload.status === 'committed'
    )
      throw new HttpsError('failed-precondition', 'Upload is no longer writable.')
    if (old) {
      if (JSON.stringify(old.references) === JSON.stringify(references)) return { staged: true }
      throw new HttpsError('already-exists', 'Manifest page is already staged.')
    }
    tx.create(pageRef, { references })
    return { staged: true }
  })
})

/** Pins immutable revision roots for a short board-load window so maintenance can preserve them. */
export const acquireBoardSceneReadPin = onCall({ region, enforceAppCheck: appCheck.value() }, async (request) => {
  requireSceneProtocol(request.data?.sceneProtocolVersion)
  const boardId = id(request.data?.boardId),
    actor = actorOf(request),
    db = getFirestore(),
    root = `boardScenes/${boardId}`
  const headRef = db.doc(root),
    controlRef = controlRefFor(boardId),
    pinId = randomUUID(),
    pinRef = db.doc(`${root}/readerPins/${pinId}`)
  const result = await db.runTransaction(async (tx) => {
    const headSnap = await tx.get(headRef)
    if (!headSnap.exists) return { kind: 'absent' as const }
    const head = headSnap.data()!,
      controlData = (await tx.get(controlRef)).data()
    await authorizeScene(boardId, head as SceneBinding, actor, tx, false)
    const control = validateControl(controlData)
    assertControlOpen(control)
    if (!head.headRevisionId) return { kind: 'pending' as const }
    const now = Timestamp.now(),
      expiresAt = Timestamp.fromMillis(now.toMillis() + READ_PIN_MS)
    const maxExpiresAt = Timestamp.fromMillis(now.toMillis() + MAX_READ_PIN_LIFETIME_MS)
    const activePins = await tx.get(
      db
        .collection(`${root}/readerPins`)
        .where('uid', '==', actor.uid)
        .where('expiresAt', '>', now)
        .limit(MAX_ACTIVE_READ_PINS_PER_ACTOR),
    )
    if (activePins.size >= MAX_ACTIVE_READ_PINS_PER_ACTOR)
      throw new HttpsError('resource-exhausted', 'Too many active board reads.')
    initializeControl(tx, controlRef, controlData)
    tx.create(pinRef, {
      uid: actor.uid,
      ownerId: head.ownerId,
      generation: head.generation,
      sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
      revisionIds: [head.headRevisionId],
      purpose: 'board-load',
      createdAt: now,
      expiresAt,
      maxExpiresAt,
    })
    return {
      kind: 'pinned' as const,
      revisionId: head.headRevisionId,
      generation: head.generation,
      sceneFormatVersion: head.sceneFormatVersion,
      expiresAt: expiresAt.toDate().toISOString(),
      maxExpiresAt: maxExpiresAt.toDate().toISOString(),
    }
  })
  if (result.kind === 'absent') return null
  if (result.kind === 'pending')
    throw new HttpsError('failed-precondition', 'Scene bootstrap is pending.', { reason: 'scene-bootstrap-pending' })
  let initialPage: {
    revision: {
      sceneFormatVersion: number
      generation: number
      pageCount: number
      chunkCount: number
      candidateDigest: string
    }
    references: ChunkReference[]
    chunks: Array<{ id: string; payload: string; digest: string }>
  }
  try {
    const context = await loadPinnedPageContext(boardId, pinId, result.revisionId, scenePageId(0), actor)
    initialPage = {
      revision: {
        sceneFormatVersion: context.revision.sceneFormatVersion,
        generation: context.revision.generation,
        pageCount: context.revision.pageCount,
        chunkCount: context.revision.chunkCount,
        candidateDigest: context.revision.candidateDigest,
      },
      references: context.references,
      chunks: await readPinnedSceneChunks(
        context,
        context.references.slice(0, MAX_SCENE_READ_CHUNKS).map(({ chunkId }) => chunkId),
        actor,
      ),
    }
  } catch (error) {
    // The caller has not received the pin ID yet, so release this exact lease
    // here if assembling its initial bounded page fails.
    await pinRef.delete().catch(() => {})
    throw error
  }
  return {
    pinId,
    revisionId: result.revisionId,
    generation: result.generation,
    sceneFormatVersion: result.sceneFormatVersion,
    expiresAt: result.expiresAt,
    maxExpiresAt: result.maxExpiresAt,
    initialPage,
  }
})

/** Register the current committed revision as a durable named history root. */
export const createNamedBoardSceneVersion = onCall({ region, enforceAppCheck: appCheck.value() }, async (request) => {
  requireSceneProtocol(request.data?.sceneProtocolVersion)
  const boardId = id(request.data?.boardId),
    name = typeof request.data?.name === 'string' ? request.data.name.trim() : ''
  if (!name || name.length > 120) throw new HttpsError('invalid-argument', 'Version name must be 1-120 characters.')
  const actor = actorOf(request),
    db = getFirestore(),
    root = `boardScenes/${boardId}`,
    versionId = randomUUID()
  const headRef = db.doc(root),
    controlRef = controlRefFor(boardId),
    versionRef = db.doc(`${root}/versions/${versionId}`)
  return db.runTransaction(async (tx) => {
    const head = (await tx.get(headRef)).data(),
      controlData = (await tx.get(controlRef)).data()
    if (!head) throw new HttpsError('not-found', 'Board scene does not exist.')
    await authorizeScene(boardId, head as SceneBinding, actor, tx, false)
    if (actor.uid !== head.ownerId)
      throw new HttpsError('permission-denied', 'Only the board owner can create named versions.')
    assertControlOpen(validateControl(controlData))
    if (
      !head.headRevisionId ||
      !Number.isSafeInteger(head.generation) ||
      head.generation < 1 ||
      head.generation >= Number.MAX_SAFE_INTEGER
    )
      throw new HttpsError('failed-precondition', 'Board has no valid committed generation.')
    const revision = (await tx.get(db.doc(`${root}/revisions/${head.headRevisionId}`))).data()
    if (!revision || revision.generation !== head.generation || revision.sceneFormatVersion !== SCENE_FORMAT_VERSION)
      throw new HttpsError('failed-precondition', 'Current board revision is invalid.')
    const now = Timestamp.now()
    initializeControl(tx, controlRef, controlData)
    tx.create(versionRef, {
      versionId,
      name,
      revisionId: head.headRevisionId,
      generation: head.generation,
      sceneFormatVersion: revision.sceneFormatVersion,
      createdBy: actor.uid,
      createdAt: now,
      kind: 'named',
    })
    return {
      versionId,
      name,
      revisionId: head.headRevisionId,
      generation: head.generation,
      sceneFormatVersion: revision.sceneFormatVersion,
      createdAt: now.toDate().toISOString(),
    }
  })
})

/**
 * Prepare a manual restore without changing the live head. The source head is
 * registered as a durable pre-restore version and both source revisions remain
 * protected by the maintenance job until the fenced reset worker completes.
 */
export const prepareBoardSceneGenerationReset = onCall(
  { region, enforceAppCheck: appCheck.value() },
  async (request) => {
    requireSceneProtocol(request.data?.sceneProtocolVersion)
    const boardId = id(request.data?.boardId),
      operationId = id(request.data?.operationId),
      versionId = id(request.data?.versionId),
      actor = actorOf(request),
      db = getFirestore(),
      root = `boardScenes/${boardId}`
    const headRef = db.doc(root),
      controlRef = controlRefFor(boardId),
      jobRef = db.doc(`${root}/maintenanceJobs/${operationId}`),
      recoveryVersionId = `pre_restore_${operationId}`,
      recoveryVersionRef = db.doc(`${root}/versions/${recoveryVersionId}`)
    return db.runTransaction(async (tx) => {
      const head = (await tx.get(headRef)).data(),
        controlData = (await tx.get(controlRef)).data(),
        existingJob = (await tx.get(jobRef)).data()
      if (!head) throw new HttpsError('not-found', 'Board scene does not exist.')
      await authorizeScene(boardId, head as SceneBinding, actor, tx, true)
      if (actor.uid !== head.ownerId)
        throw new HttpsError('permission-denied', 'Only the board owner can restore a board version.')
      assertControlOpen(validateControl(controlData))
      if (existingJob) {
        if (
          existingJob.kind !== 'generation-reset' ||
          existingJob.ownerId !== actor.uid ||
          existingJob.requestedVersionId !== versionId
        )
          throw new HttpsError('already-exists', 'Generation reset operation ID is already in use.')
        return {
          operationId,
          phase: existingJob.phase,
          sourceGeneration: existingJob.sourceGeneration,
          targetGeneration: existingJob.targetGeneration,
          sourceHeadRevisionId: existingJob.sourceHeadRevisionId,
          targetSourceRevisionId: existingJob.targetSourceRevisionId,
          recoveryVersionId: existingJob.recoveryVersionId,
        }
      }
      if (!head.headRevisionId) throw new HttpsError('failed-precondition', 'Board has no committed revision.')
      const currentRevision = (await tx.get(db.doc(`${root}/revisions/${head.headRevisionId}`))).data(),
        targetVersion = (await tx.get(db.doc(`${root}/versions/${versionId}`))).data()
      if (
        !currentRevision ||
        currentRevision.generation !== head.generation ||
        currentRevision.sceneFormatVersion !== SCENE_FORMAT_VERSION
      )
        throw new HttpsError('failed-precondition', 'Current board revision is invalid.')
      if (
        !targetVersion ||
        targetVersion.kind !== 'named' ||
        targetVersion.versionId !== versionId ||
        !Number.isSafeInteger(targetVersion.generation) ||
        targetVersion.generation < 1 ||
        typeof targetVersion.revisionId !== 'string'
      )
        throw new HttpsError('not-found', 'Named board version does not exist.')
      const targetRevision = (await tx.get(db.doc(`${root}/revisions/${targetVersion.revisionId}`))).data()
      if (
        !targetRevision ||
        targetRevision.generation !== targetVersion.generation ||
        targetRevision.sceneFormatVersion !== SCENE_FORMAT_VERSION ||
        targetVersion.sceneFormatVersion !== targetRevision.sceneFormatVersion
      )
        throw new HttpsError('failed-precondition', 'Named board version is unavailable.')

      const token = randomUUID(),
        now = Timestamp.now(),
        leaseUntil = Timestamp.fromMillis(now.toMillis() + 30 * 24 * 60 * 60_000)
      tx.create(recoveryVersionRef, {
        versionId: recoveryVersionId,
        name: `Pre-restore recovery (${now.toDate().toISOString()})`,
        revisionId: head.headRevisionId,
        generation: head.generation,
        sceneFormatVersion: currentRevision.sceneFormatVersion,
        createdBy: actor.uid,
        createdAt: now,
        kind: 'named',
        recoveryForOperationId: operationId,
      })
      tx.create(jobRef, {
        status: 'generation-reset-prepared',
        kind: 'generation-reset',
        phase: 'prepared',
        operationId,
        ownerId: actor.uid,
        token,
        sourceGeneration: head.generation,
        targetGeneration: head.generation + 1,
        sourceHeadRevisionId: head.headRevisionId,
        targetSourceRevisionId: targetVersion.revisionId,
        targetSourceGeneration: targetVersion.generation,
        requestedVersionId: versionId,
        recoveryVersionId,
        protectedRevisionIds: Array.from(new Set([head.headRevisionId, targetVersion.revisionId])),
        protectedChunkIds: [],
        leaseUntil,
        createdAt: now,
      })
      initializeControl(tx, controlRef, controlData)
      return {
        operationId,
        phase: 'prepared',
        sourceGeneration: head.generation,
        targetGeneration: head.generation + 1,
        sourceHeadRevisionId: head.headRevisionId,
        targetSourceRevisionId: targetVersion.revisionId,
        recoveryVersionId,
      }
    })
  },
)

export const listNamedBoardSceneVersions = onCall({ region, enforceAppCheck: appCheck.value() }, async (request) => {
  const boardId = id(request.data?.boardId),
    actor = actorOf(request),
    db = getFirestore(),
    root = `boardScenes/${boardId}`
  const head = (await db.doc(root).get()).data()
  if (!head) throw new HttpsError('not-found', 'Board scene does not exist.')
  await authorizeScene(boardId, head as SceneBinding, actor, undefined, false)
  const versions = await db.collection(`${root}/versions`).orderBy('createdAt', 'desc').limit(100).get()
  return {
    versions: versions.docs.map((doc) => {
      const data = doc.data()
      if (
        data.kind !== 'named' ||
        data.versionId !== doc.id ||
        typeof data.name !== 'string' ||
        typeof data.revisionId !== 'string' ||
        !Number.isSafeInteger(data.generation)
      )
        throw new HttpsError('failed-precondition', 'Board version metadata is invalid.')
      return {
        versionId: doc.id,
        name: data.name,
        revisionId: data.revisionId,
        generation: data.generation,
        sceneFormatVersion: data.sceneFormatVersion,
        createdAt: new Date(milliseconds(data.createdAt)).toISOString(),
      }
    }),
  }
})

export const acquireNamedBoardSceneVersionReadPin = onCall(
  { region, enforceAppCheck: appCheck.value() },
  async (request) => {
    requireSceneProtocol(request.data?.sceneProtocolVersion)
    const boardId = id(request.data?.boardId),
      versionId = id(request.data?.versionId),
      actor = actorOf(request)
    const db = getFirestore(),
      root = `boardScenes/${boardId}`,
      pinId = randomUUID()
    const headRef = db.doc(root),
      controlRef = controlRefFor(boardId),
      pinRef = db.doc(`${root}/readerPins/${pinId}`)
    const result = await db.runTransaction(async (tx) => {
      const head = (await tx.get(headRef)).data(),
        controlData = (await tx.get(controlRef)).data()
      if (!head) throw new HttpsError('not-found', 'Board scene does not exist.')
      await authorizeScene(boardId, head as SceneBinding, actor, tx, false)
      assertControlOpen(validateControl(controlData))
      const version = (await tx.get(db.doc(`${root}/versions/${versionId}`))).data()
      if (
        !version ||
        version.kind !== 'named' ||
        version.versionId !== versionId ||
        !Number.isSafeInteger(version.generation) ||
        typeof version.revisionId !== 'string'
      )
        throw new HttpsError('not-found', 'Named board version does not exist.')
      const revision = (await tx.get(db.doc(`${root}/revisions/${version.revisionId}`))).data()
      if (
        !revision ||
        revision.generation !== version.generation ||
        revision.sceneFormatVersion !== version.sceneFormatVersion
      )
        throw new HttpsError('failed-precondition', 'Named board version is unavailable.')
      const now = Timestamp.now(),
        expiresAt = Timestamp.fromMillis(now.toMillis() + READ_PIN_MS)
      const maxExpiresAt = Timestamp.fromMillis(now.toMillis() + MAX_READ_PIN_LIFETIME_MS)
      const activePins = await tx.get(
        db
          .collection(`${root}/readerPins`)
          .where('uid', '==', actor.uid)
          .where('expiresAt', '>', now)
          .limit(MAX_ACTIVE_READ_PINS_PER_ACTOR),
      )
      if (activePins.size >= MAX_ACTIVE_READ_PINS_PER_ACTOR)
        throw new HttpsError('resource-exhausted', 'Too many active board reads.')
      initializeControl(tx, controlRef, controlData)
      tx.create(pinRef, {
        uid: actor.uid,
        ownerId: head.ownerId,
        generation: version.generation,
        sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
        revisionIds: [version.revisionId],
        purpose: 'history-preview',
        versionId,
        createdAt: now,
        expiresAt,
        maxExpiresAt,
      })
      return {
        revisionId: version.revisionId,
        generation: version.generation,
        sceneFormatVersion: version.sceneFormatVersion,
        expiresAt: expiresAt.toDate().toISOString(),
        maxExpiresAt: maxExpiresAt.toDate().toISOString(),
      }
    })
    return { pinId, versionId, ...result }
  },
)

type PinnedPageContext = {
  boardId: string
  revisionId: string
  pageId: string
  actor: SceneActor
  head: DocumentData
  pinRef: DocumentReference
  pin: DocumentData
  revision: DocumentData
  references: ChunkReference[]
}

/** Resolve and revalidate a user pin around each server-side page/chunk read. */
async function loadPinnedPageContext(
  boardId: string,
  pinId: string,
  revisionId: string,
  pageId: string,
  actor: SceneActor,
): Promise<PinnedPageContext> {
  const db = getFirestore(),
    root = `boardScenes/${boardId}`
  const head = (await db.doc(root).get()).data()
  if (!head) throw new HttpsError('not-found', 'Board scene does not exist.')
  await authorizeScene(boardId, head as SceneBinding, actor, undefined, false)
  const pinRef = db.doc(`${root}/readerPins/${pinId}`),
    pin = (await pinRef.get()).data()
  const now = Date.now(),
    expiresAt = milliseconds(pin?.expiresAt)
  if (!pin || !Number.isFinite(expiresAt) || expiresAt <= now)
    throw new HttpsError('failed-precondition', 'Board read pin expired or does not exist.', {
      reason: 'scene-read-pin-expired',
    })
  if (pin.uid !== actor.uid) throw new HttpsError('permission-denied', 'Board read pin belongs to another user.')
  const historyPreview = pin.purpose === 'history-preview'
  if (
    pin.ownerId !== head.ownerId ||
    pin.sceneProtocolVersion !== SCENE_PROTOCOL_VERSION ||
    (pin.purpose !== 'board-load' && !historyPreview) ||
    !Number.isSafeInteger(pin.generation) ||
    !Array.isArray(pin.revisionIds) ||
    pin.revisionIds.length !== 1 ||
    pin.revisionIds[0] !== revisionId
  )
    throw new HttpsError('failed-precondition', 'Board read pin does not authorize this revision.', {
      reason: 'scene-read-pin-invalid',
    })
  if (historyPreview) {
    const version = (await db.doc(`${root}/versions/${pin.versionId}`).get()).data()
    if (
      !version ||
      version.kind !== 'named' ||
      version.revisionId !== revisionId ||
      version.generation !== pin.generation
    )
      throw new HttpsError('failed-precondition', 'Named board version is unavailable.')
  }
  const revision = (await db.doc(`${root}/revisions/${revisionId}`).get()).data()
  if (
    !revision ||
    revision.generation !== pin.generation ||
    revision.sceneFormatVersion !== SCENE_FORMAT_VERSION ||
    !Number.isSafeInteger(revision.pageCount) ||
    revision.pageCount < 1 ||
    revision.pageCount > MAX_PAGES ||
    !Number.isSafeInteger(revision.chunkCount) ||
    revision.chunkCount < 1 ||
    revision.chunkCount > MAX_CHUNKS ||
    typeof revision.candidateDigest !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(revision.candidateDigest)
  )
    throw new HttpsError('failed-precondition', 'Pinned board revision is invalid.')
  const pageIndex = Number(pageId)
  if (
    !Number.isSafeInteger(pageIndex) ||
    pageIndex < 0 ||
    pageIndex >= revision.pageCount ||
    scenePageId(pageIndex) !== pageId
  )
    throw new HttpsError('invalid-argument', 'Invalid scene page identifier.')
  const page = (await db.doc(`${root}/revisions/${revisionId}/pages/${pageId}`).get()).data()
  if (
    !page ||
    !Array.isArray(page.references) ||
    page.references.length < 1 ||
    page.references.length > 100 ||
    page.references.some(
      (reference: any) =>
        !reference ||
        typeof reference.chunkId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,160}$/.test(reference.chunkId) ||
        typeof reference.digest !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(reference.digest),
    )
  )
    throw new HttpsError('failed-precondition', 'Pinned board manifest page is invalid.')
  // Reject a pin that expired or was released while the immutable page was being read.
  const latestPin = (await pinRef.get()).data()
  if (
    !latestPin ||
    latestPin.uid !== actor.uid ||
    latestPin.ownerId !== head.ownerId ||
    latestPin.sceneProtocolVersion !== SCENE_PROTOCOL_VERSION ||
    latestPin.purpose !== pin.purpose ||
    latestPin.generation !== pin.generation ||
    latestPin.revisionIds?.[0] !== revisionId ||
    milliseconds(latestPin.expiresAt) <= Date.now()
  )
    throw new HttpsError('failed-precondition', 'Board read pin expired during the read.', {
      reason: 'scene-read-pin-expired',
    })
  await authorizeScene(boardId, head as SceneBinding, actor, undefined, false)
  return { boardId, revisionId, pageId, actor, head, pinRef, pin: latestPin, revision, references: page.references }
}

/** Read one bounded page from the exact revision protected by an active reader pin. */
export const readBoardScenePage = onCall({ region, enforceAppCheck: appCheck.value() }, async (request) => {
  requireSceneProtocol(request.data?.sceneProtocolVersion)
  const boardId = id(request.data?.boardId),
    pinId = id(request.data?.pinId)
  const revisionId = id(request.data?.revisionId),
    pageId = id(request.data?.pageId),
    actor = actorOf(request)
  const context = await loadPinnedPageContext(boardId, pinId, revisionId, pageId, actor)
  const firstBatch = context.references.slice(0, MAX_SCENE_READ_CHUNKS)
  const firstBatchChunks = await readPinnedSceneChunks(
    context,
    firstBatch.map(({ chunkId }) => chunkId),
    actor,
  )
  return {
    revision: {
      sceneFormatVersion: context.revision.sceneFormatVersion,
      generation: context.revision.generation,
      pageCount: context.revision.pageCount,
      chunkCount: context.revision.chunkCount,
      candidateDigest: context.revision.candidateDigest,
    },
    references: context.references,
    // Inline the first bounded batch so ordinary boards need one callable read
    // after pin acquisition instead of a serial manifest-then-payload pair.
    chunks: firstBatchChunks,
  }
})

async function readPinnedSceneChunks(
  context: PinnedPageContext,
  chunkIds: string[],
  actor: SceneActor,
): Promise<Array<{ id: string; payload: string; digest: string }>> {
  const references = new Map(context.references.map((reference) => [reference.chunkId, reference.digest]))
  if (chunkIds.some((chunkId) => !references.has(chunkId)))
    throw new HttpsError('failed-precondition', 'Requested chunk is not referenced by the pinned page.')
  if (chunkIds.length > MAX_SCENE_READ_CHUNKS)
    throw new HttpsError(
      'invalid-argument',
      `Scene chunk reads require at most ${MAX_SCENE_READ_CHUNKS} unique chunk IDs.`,
    )
  const root = `boardScenes/${context.boardId}`
  const snapshots = await getMany(chunkIds.map((chunkId) => `${root}/chunks/${chunkId}`))
  let responseBytes = 0
  const chunks = await Promise.all(
    snapshots.map(async (snapshot, index) => {
      const chunk = snapshot.data(),
        expectedDigest = references.get(chunkIds[index])
      if (
        !chunk ||
        typeof chunk.payload !== 'string' ||
        chunk.digest !== expectedDigest ||
        chunk.generation !== context.revision.generation ||
        chunkDocumentBytes(chunk.payload) > CHUNK_BUDGET_BYTES ||
        (await digestString(chunk.payload)) !== expectedDigest
      )
        throw new HttpsError('failed-precondition', 'Pinned board chunk is missing or invalid.')
      responseBytes += chunkDocumentBytes(chunk.payload)
      if (responseBytes > MAX_SCENE_READ_BYTES)
        throw new HttpsError('invalid-argument', `Scene chunk response exceeds ${MAX_SCENE_READ_BYTES} bytes.`)
      return { id: snapshot.id, payload: chunk.payload, digest: chunk.digest }
    }),
  )
  const latestPin = (await context.pinRef.get()).data()
  if (
    !latestPin ||
    latestPin.uid !== actor.uid ||
    latestPin.ownerId !== context.head.ownerId ||
    latestPin.revisionIds?.[0] !== context.revisionId ||
    latestPin.generation !== context.revision.generation ||
    latestPin.sceneProtocolVersion !== SCENE_PROTOCOL_VERSION ||
    latestPin.purpose !== context.pin.purpose ||
    milliseconds(latestPin.expiresAt) <= Date.now()
  )
    throw new HttpsError('failed-precondition', 'Board read pin expired during the read.', {
      reason: 'scene-read-pin-expired',
    })
  await authorizeScene(context.boardId, context.head as SceneBinding, actor, undefined, false)
  return chunks
}

/** Read <=8 referenced chunks / <=4 MiB per response from the exact pinned page. */
export const readBoardSceneChunks = onCall({ region, enforceAppCheck: appCheck.value() }, async (request) => {
  requireSceneProtocol(request.data?.sceneProtocolVersion)
  const boardId = id(request.data?.boardId),
    pinId = id(request.data?.pinId)
  const revisionId = id(request.data?.revisionId),
    pageId = id(request.data?.pageId),
    actor = actorOf(request)
  const chunkIds = request.data?.chunkIds
  if (
    !Array.isArray(chunkIds) ||
    chunkIds.length < 1 ||
    chunkIds.length > MAX_SCENE_READ_CHUNKS ||
    chunkIds.some((chunkId: unknown) => typeof chunkId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(chunkId)) ||
    new Set(chunkIds).size !== chunkIds.length
  )
    throw new HttpsError('invalid-argument', `Scene chunk reads require 1-${MAX_SCENE_READ_CHUNKS} unique chunk IDs.`)
  const context = await loadPinnedPageContext(boardId, pinId, revisionId, pageId, actor)
  // Reuse the same authorization, integrity, response-size, and pin rechecks
  // as the inline first batch returned by readBoardScenePage.
  return { chunks: await readPinnedSceneChunks(context, chunkIds, actor) }
})

/** Renew only an existing, live pin and preserve its exact revision roots; this is safe during a closed gate. */
export const renewBoardSceneReadPin = onCall({ region, enforceAppCheck: appCheck.value() }, async (request) => {
  requireSceneProtocol(request.data?.sceneProtocolVersion)
  const boardId = id(request.data?.boardId),
    pinId = id(request.data?.pinId),
    actor = actorOf(request)
  const db = getFirestore(),
    root = `boardScenes/${boardId}`,
    controlRef = controlRefFor(boardId)
  const headRef = db.doc(root),
    pinRef = db.doc(`${root}/readerPins/${pinId}`)
  return db.runTransaction(async (tx) => {
    const controlData = (await tx.get(controlRef)).data(),
      head = (await tx.get(headRef)).data(),
      pin = (await tx.get(pinRef)).data()
    if (!head) throw new HttpsError('not-found', 'Board scene does not exist.')
    await authorizeScene(boardId, head as SceneBinding, actor, tx, false)
    const control = validateControl(controlData)
    if (!pin || milliseconds(pin.expiresAt) <= Date.now())
      throw new HttpsError('failed-precondition', 'Board read pin expired.', { reason: 'scene-read-pin-expired' })
    const createdAt = milliseconds(pin.createdAt),
      maxExpiresAtMs = milliseconds(pin.maxExpiresAt),
      pinExpiresAt = milliseconds(pin.expiresAt)
    if (
      pin.uid !== actor.uid ||
      pin.ownerId !== head.ownerId ||
      pin.sceneProtocolVersion !== SCENE_PROTOCOL_VERSION ||
      (pin.purpose !== 'board-load' && pin.purpose !== 'history-preview') ||
      !Number.isSafeInteger(pin.generation) ||
      !Number.isFinite(createdAt) ||
      createdAt > Date.now() ||
      !Number.isFinite(maxExpiresAtMs) ||
      maxExpiresAtMs <= createdAt ||
      maxExpiresAtMs - createdAt > MAX_READ_PIN_LIFETIME_MS ||
      !Number.isFinite(pinExpiresAt) ||
      pinExpiresAt > maxExpiresAtMs ||
      !Array.isArray(pin.revisionIds) ||
      pin.revisionIds.length !== 1 ||
      typeof pin.revisionIds[0] !== 'string'
    )
      throw new HttpsError('failed-precondition', 'Board read pin is invalid.', { reason: 'scene-read-pin-invalid' })
    const revisionId = id(pin.revisionIds[0]),
      revisionRef = db.doc(`${root}/revisions/${revisionId}`),
      revision = (await tx.get(revisionRef)).data()
    if (!revision || revision.generation !== pin.generation || revision.sceneFormatVersion !== SCENE_FORMAT_VERSION)
      throw new HttpsError('failed-precondition', 'Board read pin is invalid.', { reason: 'scene-read-pin-invalid' })
    if (pin.purpose === 'history-preview') {
      const version = (await tx.get(db.doc(`${root}/versions/${pin.versionId}`))).data()
      if (
        !version ||
        version.kind !== 'named' ||
        version.revisionId !== revisionId ||
        version.generation !== pin.generation
      )
        throw new HttpsError('failed-precondition', 'Named board version is unavailable.')
    }
    // `control` is intentionally read and validated while closed; renewal never changes pin targets.
    void control
    const now = Date.now()
    if (now >= maxExpiresAtMs)
      throw new HttpsError('failed-precondition', 'Board read pin reached its maximum lifetime.', {
        reason: 'scene-read-pin-expired',
      })
    const expiresAt = Timestamp.fromMillis(Math.min(now + READ_PIN_MS, maxExpiresAtMs))
    tx.update(pinRef, { expiresAt, renewedAt: Timestamp.now() })
    return {
      pinId,
      revisionId,
      generation: pin.generation,
      sceneFormatVersion: revision.sceneFormatVersion,
      expiresAt: expiresAt.toDate().toISOString(),
      maxExpiresAt: new Date(maxExpiresAtMs).toISOString(),
    }
  })
})

export const releaseBoardSceneReadPin = onCall({ region, enforceAppCheck: appCheck.value() }, async (request) => {
  const boardId = id(request.data?.boardId),
    pinId = id(request.data?.pinId),
    actor = actorOf(request),
    db = getFirestore(),
    root = `boardScenes/${boardId}`
  const headRef = db.doc(root),
    controlRef = controlRefFor(boardId),
    pinRef = db.doc(`${root}/readerPins/${pinId}`)
  return db.runTransaction(async (tx) => {
    const controlData = (await tx.get(controlRef)).data(),
      head = (await tx.get(headRef)).data(),
      pin = (await tx.get(pinRef)).data()
    if (!head) throw new HttpsError('not-found', 'Board scene does not exist.')
    await authorizeScene(boardId, head as SceneBinding, actor, tx, false)
    const control = validateControl(controlData)
    initializeControl(tx, controlRef, controlData)
    if (!pin) return { released: true }
    if (pin.uid !== actor.uid) throw new HttpsError('permission-denied', 'Read pin belongs to another user.')
    tx.delete(pinRef)
    return { released: true }
  })
})

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
  async (request) => {
    requireSceneProtocol(request.data?.sceneProtocolVersion)
    return commitSceneCandidate(id(request.data?.boardId), id(request.data?.commitId), actorOf(request))
  },
)

export const repackBoardScene = onCall(
  { region, enforceAppCheck: appCheck.value(), timeoutSeconds: 120 },
  async (request) => {
    requireSceneProtocol(request.data?.sceneProtocolVersion)
    return repackBoardSceneNow(id(request.data?.boardId), actorOf(request))
  },
)
