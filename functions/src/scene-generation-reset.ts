import { randomUUID } from 'node:crypto'
import { getDatabase } from 'firebase-admin/database'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { defineBoolean, defineString } from 'firebase-functions/params'
import { authorizeScene, type SceneBinding } from './scene-access.js'
import {
  assembleScene, chunkDocumentBytes, digestString, manifestDigest, packScene, paginateReferences,
  SCENE_FORMAT_VERSION, SCENE_PROTOCOL_VERSION, type ChunkReference, type PackedChunk,
} from './scene-codec.js'

const region = defineString('SYNC_ACCESS_FUNCTION_REGION')
const appCheck = defineBoolean('ASSET_ENFORCE_APP_CHECK', { default: true })
const LEASE_MS = 150_000
const RTDB_LOCK_MS = 180_000
const MAX_CHUNKS = 512, MAX_PAGES = 6, MAX_BYTES = 64 * 1024 * 1024

function id(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
}

function maintenanceBusy() {
  return new HttpsError('unavailable', 'Board maintenance is in progress.', {
    reason: 'maintenance', retryAfterMs: 1000,
  })
}

/**
 * Closes both write paths and fences the old RTDB room for a prepared restore.
 * It advances only to `fenced`; publication is a separate resumable step.
 */
export const fenceBoardSceneGenerationReset = onCall({ region, enforceAppCheck: appCheck.value() }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to restore this board.')
  const boardId = request.data?.boardId, operationId = request.data?.operationId
  if (!id(boardId) || !id(operationId)) throw new HttpsError('invalid-argument', 'A board and reset operation are required.')
  if (request.data?.sceneProtocolVersion !== SCENE_PROTOCOL_VERSION)
    throw new HttpsError('failed-precondition', 'This client cannot safely restore this board version.')

  const db = getFirestore(), rtdb = getDatabase(), root = `boardScenes/${boardId}`
  const headRef = db.doc(root), controlRef = db.doc(`${root}/maintenance/control`),
    jobRef = db.doc(`${root}/maintenanceJobs/${operationId}`)
  const share = (await db.doc(`boardShares/${boardId}`).get()).data()
  if (!share) throw new HttpsError('not-found', 'Board does not exist.')
  const actor = {
    uid: request.auth.uid,
    email: request.auth.token.email_verified === true && typeof request.auth.token.email === 'string'
      ? request.auth.token.email.toLowerCase() : undefined,
  }
  await authorizeScene(boardId, share as SceneBinding, actor, undefined, true)
  if (request.auth.uid !== share.ownerId)
    throw new HttpsError('permission-denied', 'Only the board owner can restore a board version.')

  let jobSnapshot = await jobRef.get(), existingJob = jobSnapshot.data()
  if (!existingJob || existingJob.kind !== 'generation-reset' || existingJob.ownerId !== actor.uid)
    throw new HttpsError('not-found', 'Prepared generation reset does not exist.')
  if (existingJob.phase === 'fenced' && existingJob.status === 'running') {
    const [head, control, gate, roomGeneration] = await Promise.all([
      headRef.get(), controlRef.get(), rtdb.ref(`system/sceneMaintenance/${boardId}`).get(),
      rtdb.ref(`boards/${boardId}/generation`).get(),
    ])
    if (head.data()?.generation !== existingJob.sourceGeneration ||
        control.data()?.token !== existingJob.token || control.data()?.admission !== 'closed' ||
        gate.child('admissionOwner').val() !== existingJob.token || gate.child('admissionClosed').val() !== true ||
        roomGeneration.val() !== existingJob.targetGeneration)
      throw new HttpsError('failed-precondition', 'Fenced reset state is inconsistent; admission remains closed for recovery.')
    return { operationId, phase: 'fenced', sourceGeneration: existingJob.sourceGeneration,
      targetGeneration: existingJob.targetGeneration, status: 'fenced' }
  }

  const token = randomUUID(), lockRef = rtdb.ref(`system/compactionLocks/${boardId}`)
  const releaseLock = async () => {
    const current = await lockRef.get()
    if (current.child('token').val() === token) await lockRef.remove()
  }
  const lockResult = await lockRef.transaction((current) => {
    const leaseActive = current && Date.now() - Number(current.startedAt ?? 0) < RTDB_LOCK_MS
    if (leaseActive && current?.token !== token) return
    return { startedAt: Date.now(), token, operationId }
  })
  if (!lockResult.committed || lockResult.snapshot.val()?.token !== token)
    throw new HttpsError('unavailable', 'Another board maintenance operation is running.', { reason: 'maintenance', retryAfterMs: 1000 })

  let epoch = 0, firestoreClaimed = false
  try {
    const claim = await db.runTransaction(async (tx) => {
      const head = (await tx.get(headRef)).data(), control = (await tx.get(controlRef)).data(), job = (await tx.get(jobRef)).data()
      if (!head || !job || job.kind !== 'generation-reset' || job.ownerId !== actor.uid)
        throw new HttpsError('not-found', 'Prepared generation reset does not exist.')
      await authorizeScene(boardId, head as SceneBinding, actor, tx, true)
      if (actor.uid !== head.ownerId) throw new HttpsError('permission-denied', 'Only the board owner can restore a board version.')
      if (job.phase === 'fenced' && job.status === 'running') return { alreadyFenced: true, epoch: job.epoch, token: job.token }
      const admission = control?.admission ?? 'open'
      const samePrepared = job.status === 'generation-reset-prepared' && job.phase === 'prepared'
      const recoverable = job.status === 'running' && job.phase === 'closing-admission' &&
        job.leaseUntil instanceof Timestamp && job.leaseUntil.toMillis() <= Date.now()
      if (!samePrepared && !recoverable)
        throw maintenanceBusy()
      if (admission !== 'open' && !(recoverable && control?.jobId === operationId && control?.token === job.token))
        throw maintenanceBusy()
      if (head.headRevisionId !== job.sourceHeadRevisionId || head.generation !== job.sourceGeneration)
        throw new HttpsError('aborted', 'Board changed after restore preparation. Prepare the restore again.')
      const activeJobs = await tx.get(db.collection(`${root}/maintenanceJobs`).where('status', '==', 'running').limit(2))
      if (activeJobs.docs.some((item) => item.id !== operationId)) throw maintenanceBusy()
      const nextEpoch = Number.isSafeInteger(control?.epoch) ? Number(control?.epoch) + 1 : 2
      const now = Timestamp.now(), leaseUntil = Timestamp.fromMillis(now.toMillis() + LEASE_MS)
      tx.update(jobRef, { status: 'running', phase: 'closing-admission', token, epoch: nextEpoch,
        leaseUntil, fenceStartedAt: now, heartbeatAt: now })
      const nextControl = { admission: 'closed', epoch: nextEpoch, jobId: operationId, token,
        phase: 'generation-reset', leaseUntil, updatedAt: now }
      if (control) tx.update(controlRef, nextControl)
      else tx.create(controlRef, nextControl)
      return { alreadyFenced: false, epoch: nextEpoch, token }
    })
    epoch = claim.epoch
    firestoreClaimed = !claim.alreadyFenced
    if (claim.alreadyFenced) {
      await releaseLock()
      return { operationId, phase: 'fenced', sourceGeneration: existingJob.sourceGeneration,
        targetGeneration: existingJob.targetGeneration, status: 'fenced' }
    }

    const gateRef = rtdb.ref(`system/sceneMaintenance/${boardId}`)
    const gateResult = await gateRef.transaction((current) => {
      if (current?.admissionClosed === true && current?.admissionOwner !== token && current?.resetOperationId !== operationId)
        return
      return { ...(current ?? {}), admissionClosed: true, admissionOwner: token, resetOperationId: operationId }
    })
    if (!gateResult.committed || gateResult.snapshot.child('admissionOwner').val() !== token)
      throw new Error('Could not claim the RTDB admission gate for generation reset.')

    const [presence, activeSessions, deltas, roomGeneration] = await Promise.all([
      rtdb.ref(`presence/${boardId}`).get(), rtdb.ref(`activeSessions/${boardId}`).get(),
      rtdb.ref(`boards/${boardId}/elements`).get(), rtdb.ref(`boards/${boardId}/generation`).get(),
    ])
    const room = roomGeneration.val()
    const roomMatchesSource = room == null ? existingJob.sourceGeneration === 1 : room === existingJob.sourceGeneration
    let deferredReason: 'active-sessions' | 'uncheckpointed-deltas' | 'room-generation-mismatch' | undefined
    if (presence.exists() || activeSessions.exists()) deferredReason = 'active-sessions'
    else if (deltas.exists() && Object.keys(deltas.val() ?? {}).length > 0) deferredReason = 'uncheckpointed-deltas'
    else if (!roomMatchesSource && room !== existingJob.targetGeneration) deferredReason = 'room-generation-mismatch'

    if (deferredReason) {
      // The RTDB Admin SDK may invoke a transaction handler with an unknown
      // initial value; returning undefined aborts before it fetches server state.
      // This lease-holder is the only maintenance writer, so read/verify/update
      // the gate while holding the board lock, then verify the resulting value.
      const gateBeforeRollback = await gateRef.get()
      if (gateBeforeRollback.child('admissionOwner').val() !== token ||
          gateBeforeRollback.child('resetOperationId').val() !== operationId)
        throw new Error('RTDB reset gate ownership changed before deferred rollback.')
      await gateRef.update({ admissionClosed: false, admissionOwner: null, resetOperationId: null })
      const gateReopened = await gateRef.get()
      if (gateReopened.child('admissionClosed').val() === true || gateReopened.child('admissionOwner').val() === token)
        throw new Error('Could not reopen the RTDB gate after deferring the generation reset.')
      const reopenedFirestore = await db.runTransaction(async (tx) => {
        const control = (await tx.get(controlRef)).data(), job = (await tx.get(jobRef)).data()
        if (control?.admission !== 'closed' || control?.token !== token || control?.epoch !== epoch ||
            job?.token !== token || job?.phase !== 'closing-admission') return false
        const now = Timestamp.now()
        tx.update(controlRef, { admission: 'open', epoch: epoch + 1, jobId: null, token: null,
          leaseUntil: null, phase: null, updatedAt: now })
        tx.update(jobRef, { status: 'generation-reset-prepared', phase: 'prepared', token: null,
          epoch: null, leaseUntil: null, lastDeferredReason: deferredReason, lastDeferredAt: now })
        return true
      })
      if (!reopenedFirestore) throw new Error('Firestore reset gate ownership changed during deferred rollback.')
      await releaseLock()
      firestoreClaimed = false
      return { operationId, phase: 'prepared', status: 'deferred', reason: deferredReason }
    }

    if (room !== existingJob.targetGeneration) {
      const roomWrite = await rtdb.ref(`boards/${boardId}/generation`).transaction((current) => {
        if (current != null && current !== existingJob.sourceGeneration) return
        return existingJob.targetGeneration
      })
      if (!roomWrite.committed || roomWrite.snapshot.val() !== existingJob.targetGeneration)
        throw new Error('RTDB room generation changed while the gate was closed.')
    }
    const fencedAt = Timestamp.now()
    await db.runTransaction(async (tx) => {
      const head = (await tx.get(headRef)).data(), control = (await tx.get(controlRef)).data(), job = (await tx.get(jobRef)).data()
      if (!head || head.headRevisionId !== existingJob.sourceHeadRevisionId || head.generation !== existingJob.sourceGeneration ||
          control?.admission !== 'closed' || control?.token !== token || control?.epoch !== epoch ||
          job?.token !== token || job?.phase !== 'closing-admission')
        throw new HttpsError('aborted', 'Generation reset fence ownership changed; admission remains closed for recovery.')
      tx.update(jobRef, { status: 'running', phase: 'fenced', roomGeneration: existingJob.targetGeneration,
        fencedAt, leaseUntil: Timestamp.fromMillis(Date.now() + LEASE_MS), heartbeatAt: fencedAt })
      tx.update(controlRef, { phase: 'generation-reset-fenced', leaseUntil: Timestamp.fromMillis(Date.now() + LEASE_MS), updatedAt: fencedAt })
    })
    await releaseLock()
    return { operationId, phase: 'fenced', status: 'fenced', sourceGeneration: existingJob.sourceGeneration,
      targetGeneration: existingJob.targetGeneration }
  } catch (error) {
    // Leave a closed gate closed after ambiguous progress. A retry takes over only
    // after the Firestore lease expires and rotates the owner token.
    if (!firestoreClaimed) await releaseLock()
    throw error
  }
})

/** Build and publish the selected historical scene as a new immutable generation. */
export const publishBoardSceneGenerationReset = onCall({
  region, enforceAppCheck: appCheck.value(), timeoutSeconds: 540, memory: '1GiB',
}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to restore this board.')
  const boardId = request.data?.boardId, operationId = request.data?.operationId
  if (!id(boardId) || !id(operationId)) throw new HttpsError('invalid-argument', 'A board and reset operation are required.')
  if (request.data?.sceneProtocolVersion !== SCENE_PROTOCOL_VERSION)
    throw new HttpsError('failed-precondition', 'This client cannot safely restore this board version.')

  const db = getFirestore(), rtdb = getDatabase(), root = `boardScenes/${boardId}`
  const headRef = db.doc(root), controlRef = db.doc(`${root}/maintenance/control`),
    jobRef = db.doc(`${root}/maintenanceJobs/${operationId}`)
  const share = (await db.doc(`boardShares/${boardId}`).get()).data()
  if (!share) throw new HttpsError('not-found', 'Board does not exist.')
  const actor = { uid: request.auth.uid,
    email: request.auth.token.email_verified === true && typeof request.auth.token.email === 'string'
      ? request.auth.token.email.toLowerCase() : undefined }
  await authorizeScene(boardId, share as SceneBinding, actor, undefined, true)
  if (actor.uid !== share.ownerId) throw new HttpsError('permission-denied', 'Only the board owner can restore a board version.')

  const job = (await jobRef.get()).data()
  if (!job || job.kind !== 'generation-reset' || job.ownerId !== actor.uid)
    throw new HttpsError('not-found', 'Prepared generation reset does not exist.')
  const revisionId = `restore_${(await digestString(operationId)).slice(0, 48)}`
  if (job.phase === 'published' && job.status === 'running') {
    const head = (await headRef.get()).data()
    if (head?.generation !== job.targetGeneration || head?.headRevisionId !== revisionId || job.targetRevisionId !== revisionId)
      throw new HttpsError('failed-precondition', 'Published reset state is inconsistent; admission remains closed for recovery.')
    return { operationId, phase: 'published', status: 'published', revisionId,
      generation: job.targetGeneration, candidateDigest: job.targetCandidateDigest }
  }
  if (job.phase !== 'fenced' || job.status !== 'running' || typeof job.token !== 'string')
    throw maintenanceBusy()

  const lockToken = randomUUID(), lockRef = rtdb.ref(`system/compactionLocks/${boardId}`)
  const lock = await lockRef.transaction((current) => {
    if (current && Date.now() - Number(current.startedAt ?? 0) < RTDB_LOCK_MS) return
    return { startedAt: Date.now(), token: lockToken, operationId }
  })
  if (!lock.committed || lock.snapshot.val()?.token !== lockToken) throw maintenanceBusy()
  const releaseLock = async () => {
    const current = await lockRef.get()
    if (current.child('token').val() === lockToken) await lockRef.remove()
  }

  try {
    const [headSnapshot, controlSnapshot, gate, roomGeneration, presence, sessions, deltas] = await Promise.all([
      headRef.get(), controlRef.get(), rtdb.ref(`system/sceneMaintenance/${boardId}`).get(),
      rtdb.ref(`boards/${boardId}/generation`).get(), rtdb.ref(`presence/${boardId}`).get(),
      rtdb.ref(`activeSessions/${boardId}`).get(), rtdb.ref(`boards/${boardId}/elements`).get(),
    ])
    const head = headSnapshot.data(), control = controlSnapshot.data()
    if (!head || head.headRevisionId !== job.sourceHeadRevisionId || head.generation !== job.sourceGeneration ||
        control?.admission !== 'closed' || control?.token !== job.token || control?.jobId !== operationId ||
        gate.child('admissionClosed').val() !== true || gate.child('admissionOwner').val() !== job.token ||
        roomGeneration.val() !== job.targetGeneration || presence.exists() || sessions.exists() ||
        (deltas.exists() && Object.keys(deltas.val() ?? {}).length > 0))
      throw new HttpsError('failed-precondition', 'The old board generation is not safely fenced; admission remains closed.')

    const sourceRevisionRef = db.doc(`${root}/revisions/${job.targetSourceRevisionId}`)
    const sourceRevision = (await sourceRevisionRef.get()).data()
    if (!sourceRevision || sourceRevision.generation !== job.targetSourceGeneration ||
        sourceRevision.sceneFormatVersion !== SCENE_FORMAT_VERSION ||
        !Number.isSafeInteger(sourceRevision.pageCount) || sourceRevision.pageCount < 1 || sourceRevision.pageCount > MAX_PAGES ||
        !Number.isSafeInteger(sourceRevision.chunkCount) || sourceRevision.chunkCount < 1 || sourceRevision.chunkCount > MAX_CHUNKS ||
        typeof sourceRevision.candidateDigest !== 'string')
      throw new HttpsError('failed-precondition', 'The selected version is unavailable or invalid.')
    const sourcePages = await Promise.all(Array.from({ length: sourceRevision.pageCount }, (_, page) =>
      db.doc(`${root}/revisions/${job.targetSourceRevisionId}/pages/${String(page).padStart(6, '0')}`).get()))
    const references: ChunkReference[] = sourcePages.flatMap((page) => {
      const refs = page.data()?.references
      if (!page.exists || !Array.isArray(refs)) throw new HttpsError('failed-precondition', 'The selected version manifest is incomplete.')
      return refs
    })
    if (references.length !== sourceRevision.chunkCount || references.length > MAX_CHUNKS ||
        references.some((ref) => !ref || typeof ref !== 'object' || !id(ref.chunkId) ||
          typeof ref.digest !== 'string' || !/^[a-f0-9]{64}$/i.test(ref.digest)) ||
        new Set(references.map((ref) => ref.chunkId)).size !== references.length ||
        (await manifestDigest(references, sourceRevision.generation)) !== sourceRevision.candidateDigest)
      throw new HttpsError('failed-precondition', 'The selected version manifest failed validation.')
    const sourceChunks = await db.getAll(...references.map((ref) => db.doc(`${root}/chunks/${ref.chunkId}`)))
    let sourceBytes = 0
    const validatedChunks: PackedChunk[] = sourceChunks.map((snapshot, slot) => {
      const chunk = snapshot.data(), reference = references[slot]
      if (!chunk || snapshot.id !== reference.chunkId || chunk.digest !== reference.digest ||
          chunk.generation !== sourceRevision.generation || typeof chunk.payload !== 'string')
        throw new HttpsError('failed-precondition', 'The selected version payload is incomplete or inconsistent.')
      sourceBytes += chunkDocumentBytes(chunk.payload)
      return { chunkId: snapshot.id, digest: chunk.digest, payload: chunk.payload }
    })
    if (sourceBytes > MAX_BYTES) throw new HttpsError('failed-precondition', 'The selected version exceeds the scene size limit.')
    let scene
    try { scene = await assembleScene(validatedChunks) }
    catch { throw new HttpsError('failed-precondition', 'The selected version payload failed integrity validation.') }
    const cleanSnapshot = {
      ...scene,
      elements: scene.elements.filter((element) => element.isDeleted !== true),
      deletionLedger: [],
    }
    const packed = (await packScene(cleanSnapshot)).map((chunk, slot) => ({ ...chunk, chunkId: `${revisionId}_${slot}` }))
    const pages = paginateReferences(packed.map(({ chunkId, digest }) => ({ chunkId, digest })))
    const candidateDigest = await manifestDigest(packed.map(({ chunkId, digest }) => ({ chunkId, digest })), job.targetGeneration)
    const targetBytes = packed.reduce((total, chunk) => total + chunkDocumentBytes(chunk.payload), 0)
    if (!packed.length || packed.length > MAX_CHUNKS || pages.length > MAX_PAGES || targetBytes > MAX_BYTES)
      throw new HttpsError('failed-precondition', 'Restored board exceeds scene storage limits.')

    const targetRevisionRef = db.doc(`${root}/revisions/${revisionId}`)
    const reservation = await db.runTransaction(async (tx) => {
      const latestHead = (await tx.get(headRef)).data(), currentControl = (await tx.get(controlRef)).data(), currentJob = (await tx.get(jobRef)).data(),
        existingRevision = (await tx.get(targetRevisionRef)).data()
      if (!latestHead || latestHead.headRevisionId !== job.sourceHeadRevisionId || latestHead.generation !== job.sourceGeneration ||
          currentControl?.admission !== 'closed' || currentControl?.token !== job.token || currentControl?.jobId !== operationId ||
          currentJob?.status !== 'running' || currentJob.phase !== 'fenced' || currentJob.token !== job.token)
        throw new HttpsError('aborted', 'Generation reset ownership changed; admission remains closed for recovery.')
      if (existingRevision && (existingRevision.candidateDigest !== candidateDigest ||
          existingRevision.generation !== job.targetGeneration || existingRevision.parentRevisionId !== job.sourceHeadRevisionId))
        throw new HttpsError('already-exists', 'Restored revision identity is already in use.')
      const now = Timestamp.now(), leaseUntil = Timestamp.fromMillis(now.toMillis() + LEASE_MS)
      tx.update(jobRef, { targetRevisionId: revisionId, targetCandidateDigest: candidateDigest,
        protectedRevisionIds: Array.from(new Set([...(currentJob.protectedRevisionIds ?? []), revisionId])),
        protectedChunkIds: packed.map((chunk) => chunk.chunkId), leaseUntil, heartbeatAt: now })
      tx.update(controlRef, { phase: 'generation-reset-staging', leaseUntil, updatedAt: now })
      return { alreadyPublished: Boolean(existingRevision && latestHead.headRevisionId === revisionId), now }
    })
    if (reservation.alreadyPublished) {
      await releaseLock()
      return { operationId, phase: 'published', status: 'published', revisionId, generation: job.targetGeneration, candidateDigest }
    }

    const writer = db.bulkWriter()
    for (const [slot, chunk] of packed.entries()) writer.set(db.doc(`${root}/chunks/${chunk.chunkId}`), {
      payload: chunk.payload, digest: chunk.digest, uploadId: operationId, slot, uploaderUid: actor.uid,
      generation: job.targetGeneration, kind: 'records',
    })
    pages.forEach((page, slot) => writer.set(db.doc(`${root}/revisions/${revisionId}/pages/${String(slot).padStart(6, '0')}`), { references: page }))
    await writer.close()

    const publishedAt = Timestamp.now()
    const result = await db.runTransaction(async (tx) => {
      const latestHead = (await tx.get(headRef)).data(), currentControl = (await tx.get(controlRef)).data(),
        currentJob = (await tx.get(jobRef)).data(), existingRevision = (await tx.get(targetRevisionRef)).data()
      if (!latestHead || latestHead.headRevisionId !== job.sourceHeadRevisionId || latestHead.generation !== job.sourceGeneration ||
          currentControl?.admission !== 'closed' || currentControl?.token !== job.token || currentControl?.jobId !== operationId ||
          currentJob?.status !== 'running' || currentJob.phase !== 'fenced' || currentJob.token !== job.token ||
          currentJob.targetRevisionId !== revisionId || currentJob.targetCandidateDigest !== candidateDigest)
        throw new HttpsError('aborted', 'Generation reset ownership changed; admission remains closed for recovery.')
      if (existingRevision && (existingRevision.candidateDigest !== candidateDigest ||
          existingRevision.generation !== job.targetGeneration || existingRevision.parentRevisionId !== job.sourceHeadRevisionId))
        throw new HttpsError('already-exists', 'Restored revision identity is already in use.')
      if (!existingRevision) tx.create(targetRevisionRef, {
        generation: job.targetGeneration, sceneFormatVersion: SCENE_FORMAT_VERSION,
        sceneProtocolVersion: SCENE_PROTOCOL_VERSION, pageCount: pages.length, chunkCount: packed.length,
        candidateDigest, parentRevisionId: job.sourceHeadRevisionId, reason: 'version-restore',
        restoredFromRevisionId: job.targetSourceRevisionId, resetOperationId: operationId, createdAt: publishedAt.toDate().toISOString(),
      })
      tx.update(headRef, { headRevisionId: revisionId, generation: job.targetGeneration,
        sceneFormatVersion: SCENE_FORMAT_VERSION, updatedAt: publishedAt.toDate().toISOString() })
      tx.update(jobRef, { phase: 'published', targetRevisionId: revisionId, targetCandidateDigest: candidateDigest,
        status: 'running', publishedAt, leaseUntil: Timestamp.fromMillis(Date.now() + LEASE_MS), heartbeatAt: publishedAt })
      tx.update(controlRef, { phase: 'generation-reset-published', leaseUntil: Timestamp.fromMillis(Date.now() + LEASE_MS), updatedAt: publishedAt })
      return { revisionId, generation: job.targetGeneration, candidateDigest }
    })
    await releaseLock()
    return { operationId, phase: 'published', status: 'published', ...result }
  } catch (error) {
    await releaseLock()
    throw error
  }
})

/** Complete a published reset: durably activate G+1, then reopen RTDB and Firestore admission. */
export const activateBoardSceneGenerationReset = onCall({ region, enforceAppCheck: appCheck.value() }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to restore this board.')
  const boardId = request.data?.boardId, operationId = request.data?.operationId
  if (!id(boardId) || !id(operationId)) throw new HttpsError('invalid-argument', 'A board and reset operation are required.')
  if (request.data?.sceneProtocolVersion !== SCENE_PROTOCOL_VERSION)
    throw new HttpsError('failed-precondition', 'This client cannot safely restore this board version.')

  const db = getFirestore(), rtdb = getDatabase(), root = `boardScenes/${boardId}`
  const headRef = db.doc(root), controlRef = db.doc(`${root}/maintenance/control`),
    jobRef = db.doc(`${root}/maintenanceJobs/${operationId}`)
  const share = (await db.doc(`boardShares/${boardId}`).get()).data()
  if (!share) throw new HttpsError('not-found', 'Board does not exist.')
  const actor = { uid: request.auth.uid,
    email: request.auth.token.email_verified === true && typeof request.auth.token.email === 'string'
      ? request.auth.token.email.toLowerCase() : undefined }
  await authorizeScene(boardId, share as SceneBinding, actor, undefined, true)
  if (actor.uid !== share.ownerId) throw new HttpsError('permission-denied', 'Only the board owner can restore a board version.')

  const job = (await jobRef.get()).data()
  if (!job || job.kind !== 'generation-reset' || job.ownerId !== actor.uid)
    throw new HttpsError('not-found', 'Prepared generation reset does not exist.')
  if (job.phase === 'activated' && job.status === 'complete') {
    const [head, control, gate, room] = await Promise.all([headRef.get(), controlRef.get(),
      rtdb.ref(`system/sceneMaintenance/${boardId}`).get(), rtdb.ref(`boards/${boardId}/generation`).get()])
    if (head.data()?.generation !== job.targetGeneration || head.data()?.headRevisionId !== job.targetRevisionId ||
        control.data()?.admission !== 'open' || gate.child('admissionClosed').val() === true ||
        room.val() !== job.targetGeneration)
      throw new HttpsError('failed-precondition', 'Activated reset state is inconsistent.')
    return { operationId, phase: 'activated', status: 'complete', generation: job.targetGeneration,
      revisionId: job.targetRevisionId }
  }
  if (job.status !== 'running' || !['published', 'activated'].includes(job.phase) || typeof job.token !== 'string')
    throw maintenanceBusy()

  const lockToken = randomUUID(), lockRef = rtdb.ref(`system/compactionLocks/${boardId}`)
  const lock = await lockRef.transaction((current) => {
    if (current && Date.now() - Number(current.startedAt ?? 0) < RTDB_LOCK_MS) return
    return { startedAt: Date.now(), token: lockToken, operationId }
  })
  if (!lock.committed || lock.snapshot.val()?.token !== lockToken) throw maintenanceBusy()
  const releaseLock = async () => {
    const current = await lockRef.get()
    if (current.child('token').val() === lockToken) await lockRef.remove()
  }
  try {
    const gateRef = rtdb.ref(`system/sceneMaintenance/${boardId}`)
    const [headSnapshot, controlSnapshot, gate, room, presence, sessions, deltas] = await Promise.all([
      headRef.get(), controlRef.get(), gateRef.get(), rtdb.ref(`boards/${boardId}/generation`).get(),
      rtdb.ref(`presence/${boardId}`).get(), rtdb.ref(`activeSessions/${boardId}`).get(),
      rtdb.ref(`boards/${boardId}/elements`).get(),
    ])
    const head = headSnapshot.data(), control = controlSnapshot.data(), closedByOperation =
      gate.child('admissionClosed').val() === true && gate.child('admissionOwner').val() === job.token &&
      gate.child('resetOperationId').val() === operationId,
      firestoreFenceOwned = control?.admission === 'closed' && control?.token === job.token && control?.jobId === operationId,
      firestoreAlreadyOpen = control?.admission === 'open' && control?.jobId == null && control?.token == null,
      rtdbAlreadyOpen = gate.child('admissionClosed').val() !== true
    if (!head || head.generation !== job.targetGeneration || head.headRevisionId !== job.targetRevisionId ||
        room.val() !== job.targetGeneration ||
        (job.phase === 'published' && (!firestoreFenceOwned || !closedByOperation || presence.exists() || sessions.exists() ||
          (deltas.exists() && Object.keys(deltas.val() ?? {}).length > 0))) ||
        (job.phase === 'activated' && (!firestoreFenceOwned && !firestoreAlreadyOpen ||
          (!closedByOperation && !rtdbAlreadyOpen) || (gate.child('admissionClosed').val() === true && !closedByOperation))))
      throw new HttpsError('failed-precondition', 'The published generation is not safe to activate; admission remains closed.')

    await db.runTransaction(async (tx) => {
      const currentHead = (await tx.get(headRef)).data(), currentControl = (await tx.get(controlRef)).data(), currentJob = (await tx.get(jobRef)).data()
      const ownsClosedControl = currentControl?.admission === 'closed' && currentControl?.token === job.token && currentControl?.jobId === operationId
      const controlAlreadyOpen = currentControl?.admission === 'open' && currentControl?.jobId == null && currentControl?.token == null
      if (!currentHead || currentHead.headRevisionId !== job.targetRevisionId || currentHead.generation !== job.targetGeneration ||
          (!ownsClosedControl && !(currentJob?.phase === 'activated' && controlAlreadyOpen)) ||
          currentJob?.status !== 'running' || currentJob.token !== job.token ||
          !['published', 'activated'].includes(currentJob.phase))
        throw new HttpsError('aborted', 'Generation reset ownership changed; admission remains closed for recovery.')
      if (currentJob.phase === 'published') {
        const now = Timestamp.now()
        tx.update(jobRef, { phase: 'activated', activatedAt: now,
          leaseUntil: Timestamp.fromMillis(now.toMillis() + LEASE_MS), heartbeatAt: now })
        tx.update(controlRef, { phase: 'generation-reset-activated', leaseUntil: Timestamp.fromMillis(now.toMillis() + LEASE_MS), updatedAt: now })
      }
    })

    // Remove tokens from the retired room before opening admission. RTDB rules
    // also compare each token's sceneGeneration against the live room generation.
    if (closedByOperation) await rtdb.ref(`system/sceneConnectionEpochs/${boardId}`).remove()

    // Open Firestore first. Until RTDB opens, no collaboration token can be
    // minted; if the worker crashes here, a retry can safely finish RTDB.
    await db.runTransaction(async (tx) => {
      const currentHead = (await tx.get(headRef)).data(), currentControl = (await tx.get(controlRef)).data(), currentJob = (await tx.get(jobRef)).data()
      if (!currentHead || currentHead.headRevisionId !== job.targetRevisionId || currentHead.generation !== job.targetGeneration ||
          currentJob?.status !== 'running' || currentJob.phase !== 'activated' || currentJob.token !== job.token)
        throw new HttpsError('aborted', 'Generation reset activation ownership changed; retry to finish reopening.')
      if (currentControl?.admission === 'closed' && currentControl.token === job.token && currentControl.jobId === operationId) {
        const now = Timestamp.now()
        tx.update(controlRef, { admission: 'open', epoch: currentControl.epoch + 1, jobId: null,
          token: null, leaseUntil: null, phase: null, updatedAt: now })
      } else if (currentControl?.admission !== 'open' || currentControl.jobId != null || currentControl.token != null) {
        throw new HttpsError('aborted', 'Firestore reset gate ownership changed; retry to finish reopening.')
      }
    })

    const gateNow = await gateRef.get()
    if (gateNow.child('admissionClosed').val() === true) {
      if (gateNow.child('admissionOwner').val() !== job.token || gateNow.child('resetOperationId').val() !== operationId)
        throw new HttpsError('aborted', 'RTDB generation reset gate ownership changed; admission remains closed for recovery.')
      await gateRef.update({ admissionClosed: false, admissionOwner: null, resetOperationId: null })
    }
    const gateAfter = await gateRef.get()
    if (gateAfter.child('admissionClosed').val() === true)
      throw new Error('RTDB gate did not reopen after generation activation.')

    await db.runTransaction(async (tx) => {
      const currentHead = (await tx.get(headRef)).data(), currentControl = (await tx.get(controlRef)).data(), currentJob = (await tx.get(jobRef)).data()
      if (!currentHead || currentHead.headRevisionId !== job.targetRevisionId || currentHead.generation !== job.targetGeneration ||
          currentControl?.admission !== 'open' || currentControl?.jobId != null || currentControl?.token != null ||
          currentJob?.status !== 'running' || currentJob.phase !== 'activated' || currentJob.token !== job.token)
        throw new HttpsError('aborted', 'Generation reset activation ownership changed; retry to finish reopening.')
      const now = Timestamp.now()
      tx.update(jobRef, { status: 'complete', phase: 'activated', leaseUntil: null, completedAt: now, heartbeatAt: now })
    })
    await releaseLock()
    return { operationId, phase: 'activated', status: 'complete', generation: job.targetGeneration,
      revisionId: job.targetRevisionId }
  } catch (error) {
    await releaseLock()
    throw error
  }
})
