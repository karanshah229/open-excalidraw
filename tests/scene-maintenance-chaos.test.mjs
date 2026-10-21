import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'

const requireFromFunctions = createRequire(new URL('../functions/package.json', import.meta.url))
const { getApps, initializeApp } = requireFromFunctions('firebase-admin/app')
const { Timestamp, getFirestore } = requireFromFunctions('firebase-admin/firestore')
const { SCENE_PROTOCOL_VERSION } = await import('../functions/lib/scene-codec.js')
const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

function assertEmulator() {
  assert.equal(process.env.GCLOUD_PROJECT, 'demo-regression', 'refuse non-demo Firebase projects')
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator must be running')
}

async function seedBoard(db, boardId, orphanCount = 0) {
  const now = Date.now()
  const ownerId = 'maintenance-chaos-owner'
  const root = `boardScenes/${boardId}`
  const livePayload = JSON.stringify([{ key: 'live', kind: 'extra', value: { text: 'keep' } }])
  const revisionDigest = digest(`revision-${boardId}`)
  await db.doc(root).set({ ownerId, projectId: null, headRevisionId: 'r1', generation: 1, sceneFormatVersion: 1 })
  await db.doc(`boardShares/${boardId}`).set({
    boardId, ownerId, projectId: null, generalAccess: 'restricted', generalRole: 'owner', pending: false,
  })
  await db.doc(`${root}/revisions/r1`).set({
    generation: 1, sceneFormatVersion: 1, pageCount: 1, chunkCount: 1, candidateDigest: revisionDigest,
  })
  await db.doc(`${root}/revisions/r1/pages/000000`).set({
    references: [{ chunkId: 'live_chunk', digest: digest(livePayload) }],
  })
  await db.doc(`${root}/chunks/live_chunk`).set({
    payload: livePayload, digest: digest(livePayload), uploadId: 'r1', slot: 0,
    uploaderUid: ownerId, generation: 1, kind: 'records',
  })
  await db.doc(`${root}/uploads/r1`).set({
    uploaderUid: ownerId, expectedHeadRevisionId: 'r1', generation: 1, sceneFormatVersion: 1,
    pageCount: 1, chunkCount: 1, newChunkCount: 1, candidateDigest: revisionDigest,
    createdAt: Timestamp.fromMillis(now - 90 * 60 * 60_000), expiresAt: Timestamp.fromMillis(now - 89 * 60 * 60_000),
    status: 'committed', receipt: { revisionId: 'r1', generation: 1, candidateDigest: revisionDigest },
  })
  for (let index = 0; index < orphanCount; index++) {
    const uploadId = `u_orphan_${index}`
    const chunkId = `orphan_chunk_${index}`
    const payload = JSON.stringify([{ key: `orphan-${index}`, kind: 'extra', value: { index } }])
    await db.doc(`${root}/uploads/${uploadId}`).set({
      uploaderUid: ownerId, expectedHeadRevisionId: 'r1', generation: 1, sceneFormatVersion: 1,
      pageCount: 1, chunkCount: 1, newChunkCount: 1, candidateDigest: digest(`orphan-candidate-${index}`),
      createdAt: Timestamp.fromMillis(now - 100 * 60 * 60_000), expiresAt: Timestamp.fromMillis(now - 90 * 60 * 60_000),
    })
    await db.doc(`${root}/chunks/${chunkId}`).set({
      payload, digest: digest(payload), uploadId, slot: 0, uploaderUid: ownerId, generation: 1, kind: 'records',
    })
  }
  return { ownerId, root, now }
}

test('closed admission rejects new writer uploads and reader pins', async (t) => {
  assertEmulator()
  if (getApps().length === 0) initializeApp({ projectId: 'demo-regression' })
  const db = getFirestore()
  const { beginBoardSceneUpload, acquireBoardSceneReadPin } = await import('../functions/lib/board-scenes.js')
  const boardId = `maintenance_gate_${randomUUID().replaceAll('-', '')}`
  const { ownerId, root } = await seedBoard(db, boardId)
  t.after(async () => {
    await db.recursiveDelete(db.doc(root))
    await db.doc(`boardShares/${boardId}`).delete()
  })
  await db.doc(`${root}/maintenance/control`).set({
    admission: 'closed', epoch: 3, jobId: 'job_gate', token: 'token_gate',
    leaseUntil: Timestamp.fromMillis(Date.now() + 60_000), phase: 'census',
  })
  const auth = { uid: ownerId, token: { email_verified: false } }
  const digestValue = digest('candidate')
  await assert.rejects(beginBoardSceneUpload.run({ data: {
    boardId, commitId: 'new_upload', expectedHeadRevisionId: 'r1', generation: 1, sceneFormatVersion: 1,
    sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
    pageCount: 1, chunkCount: 1, newChunkCount: 1, candidateDigest: digestValue,
  }, auth }), (error) => error.code === 'unavailable' && error.details?.reason === 'maintenance')
  await assert.rejects(acquireBoardSceneReadPin.run({ data: { boardId, sceneProtocolVersion: SCENE_PROTOCOL_VERSION }, auth }),
    (error) => error.code === 'unavailable' && error.details?.reason === 'maintenance')
  assert.equal((await db.doc(`${root}/uploads/new_upload`).get()).exists, false)
  assert.equal((await db.collection(`${root}/readerPins`).get()).size, 0)
})

test('durable quarantine survives worker crash; receipts and retry remain idempotent after recovery', async (t) => {
  assertEmulator()
  if (getApps().length === 0) initializeApp({ projectId: 'demo-regression' })
  const db = getFirestore()
  const {
    quarantineSceneOrphanChunks,
    collectQuarantinedOrphanChunks,
    recoverAbandonedSceneChunkCollection,
  } = await import('../functions/lib/scene-maintenance-gc.js')
  const boardId = `maintenance_crash_${randomUUID().replaceAll('-', '')}`
  const { ownerId, root, now } = await seedBoard(db, boardId, 2)
  t.after(async () => {
    await db.recursiveDelete(db.doc(root))
    await db.doc(`boardShares/${boardId}`).delete()
  })

  const proposal = await quarantineSceneOrphanChunks(boardId)
  assert.equal(proposal.status, 'proposal-only')
  assert.equal(proposal.candidateCount, 2)
  const proposalPageRef = db.doc(`${root}/maintenanceJobs/${proposal.jobId}/quarantinePages/000000`)
  const proposalPage = (await proposalPageRef.get()).data()
  const quarantineAt = Timestamp.fromMillis(now - 60 * 60 * 60_000)
  proposalPage.entries = proposalPage.entries.map((entry) => ({
    ...entry,
    quarantinedAt: quarantineAt,
    deleteNotBefore: Timestamp.fromMillis(quarantineAt.toMillis() + 48 * 60 * 60_000),
  }))
  await proposalPageRef.set(proposalPage)

  // Model a process crash after one committed delete transaction: its receipt and
  // delete are durable, while the board gate remains closed and the worker lease expires.
  const first = proposalPage.entries[0]
  const collectorJobId = `collect_crash_${randomUUID().replaceAll('-', '')}`
  const collectorToken = randomUUID()
  const epoch = proposal.epoch + 1
  const expired = Timestamp.fromMillis(Date.now() - 60_000)
  await db.doc(`${root}/chunks/${first.chunkId}`).delete()
  await db.doc(`${root}/maintenanceJobs/${proposal.jobId}/collectionReceipts/${first.chunkId}`).set({
    sourceJobId: proposal.jobId, chunkId: first.chunkId, uploadId: first.uploadId, digest: first.digest,
    slot: first.slot, generation: first.generation, uploaderUid: first.uploaderUid,
    deletedAt: Timestamp.now(), epoch, token: collectorToken,
  })
  await db.doc(`${root}/maintenance/control`).set({
    admission: 'closed', epoch, jobId: collectorJobId, token: collectorToken,
    leaseUntil: expired, phase: 'delete-ready',
  })
  await db.doc(`${root}/maintenanceJobs/${collectorJobId}`).set({
    kind: 'orphan-chunk-collection', status: 'lease-expired-awaiting-recovery', ownerId,
    epoch, token: collectorToken, leaseUntil: expired, phase: 'delete-ready', censusComplete: true,
    censusDigest: digest('census'), deleteEvidenceDigest: digest('delete-evidence'), candidateCount: 2,
    deletedChunkCount: 1,
  })

  const recovered = await recoverAbandonedSceneChunkCollection(boardId, collectorJobId, epoch)
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.newEpoch, epoch + 1)
  await assert.rejects(recoverAbandonedSceneChunkCollection(boardId, collectorJobId, epoch), /fence/i,
    'a stale worker/recovery epoch cannot take over a recovered gate')

  const retried = await collectQuarantinedOrphanChunks(boardId, proposal.jobId)
  assert.equal(retried.status, 'complete')
  assert.equal(retried.deletedChunkCount, 2)
  assert.equal(retried.deleteBatchCount, 1)
  assert.equal(retried.deleteTransactionRetryCount, 0, 'an uncontended one-batch retry should record no transaction retries')
  assert.ok(Number.isSafeInteger(retried.gateClosedDurationMs) && retried.gateClosedDurationMs >= 0)
  assert.ok(Number.isSafeInteger(retried.maxDeleteBatchDurationMs) && retried.maxDeleteBatchDurationMs >= 0)
  const completedJob = (await db.collection(`${root}/maintenanceJobs`).where('kind', '==', 'orphan-chunk-collection')
    .where('status', '==', 'complete').get()).docs[0].data()
  assert.equal(completedJob.deleteBatchCount, retried.deleteBatchCount)
  assert.equal(completedJob.deleteTransactionRetryCount, retried.deleteTransactionRetryCount)
  assert.ok(retried.gateClosedDurationMs >= completedJob.gateClosedDurationMs)
  for (const field of ['censusDurationMs', 'totalDeleteBatchDurationMs', 'maxDeleteBatchDurationMs', 'gateClosedDurationMs'])
    assert.ok(Number.isSafeInteger(completedJob[field]) && completedJob[field] >= 0, `${field} should be a nonnegative duration`)
  assert.ok(retried.maxDeleteBatchDurationMs >= completedJob.maxDeleteBatchDurationMs)
  for (const entry of proposalPage.entries) {
    assert.equal((await db.doc(`${root}/chunks/${entry.chunkId}`).get()).exists, false)
    assert.equal((await db.doc(`${root}/maintenanceJobs/${proposal.jobId}/collectionReceipts/${entry.chunkId}`).get()).exists, true)
  }
  assert.equal((await db.doc(`${root}/chunks/live_chunk`).get()).exists, true)
  assert.equal((await db.doc(`${root}/maintenance/control`).get()).data().admission, 'open')

  const duplicateRetry = await collectQuarantinedOrphanChunks(boardId, proposal.jobId)
  assert.equal(duplicateRetry.status, 'complete')
  assert.equal(duplicateRetry.deletedChunkCount, 2)
  assert.equal(duplicateRetry.deleteBatchCount, 0)
  assert.equal(duplicateRetry.deleteTransactionRetryCount, 0)
  assert.ok(Number.isSafeInteger(duplicateRetry.gateClosedDurationMs) && duplicateRetry.gateClosedDurationMs >= 0)
})
