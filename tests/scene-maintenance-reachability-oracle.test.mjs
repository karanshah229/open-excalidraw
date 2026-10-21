import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'

const requireFromFunctions = createRequire(new URL('../functions/package.json', import.meta.url))
const { getApps, initializeApp } = requireFromFunctions('firebase-admin/app')
const { Timestamp, getFirestore } = requireFromFunctions('firebase-admin/firestore')

const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

/** Independent persisted-data oracle: follows revision roots, durable versions/pins/jobs, then page refs. */
async function readOracleReachability(db, boardId, now = Date.now()) {
  const root = `boardScenes/${boardId}`
  const head = (await db.doc(root).get()).data()
  assert.ok(head, 'board head must exist')

  const revisions = new Map()
  const revisionDocs = await db.collection(`${root}/revisions`).get()
  for (const revisionDoc of revisionDocs.docs) {
    const pages = await db.collection(`${root}/revisions/${revisionDoc.id}/pages`).get()
    revisions.set(revisionDoc.id, pages.docs.flatMap((page) => page.data().references ?? []))
  }

  const roots = new Set([head.headRevisionId])
  // This rollout preserves every persisted revision, including ones no longer reachable from the head.
  for (const revisionId of revisions.keys()) roots.add(revisionId)
  for (const version of (await db.collection(`${root}/versions`).get()).docs)
    if (version.data().revisionId) roots.add(version.data().revisionId)
  for (const pin of (await db.collection(`${root}/readerPins`).get()).docs) {
    const data = pin.data()
    if (data.expiresAt?.toMillis?.() > now)
      for (const revisionId of data.revisionIds ?? []) roots.add(revisionId)
  }

  const protectedChunkIds = new Set()
  for (const job of (await db.collection(`${root}/maintenanceJobs`).get()).docs) {
    const data = job.data()
    if (data.status !== 'complete' && data.status !== 'cancelled') {
      for (const revisionId of data.protectedRevisionIds ?? []) roots.add(revisionId)
      for (const chunkId of data.protectedChunkIds ?? []) protectedChunkIds.add(chunkId)
    }
  }
  for (const upload of (await db.collection(`${root}/uploads`).get()).docs) {
    const receipt = upload.data().receipt
    if (receipt?.revisionId) roots.add(receipt.revisionId)
  }

  const reachableChunkIds = new Set(protectedChunkIds)
  for (const revisionId of roots) {
    assert.ok(revisions.has(revisionId), `oracle root revision ${revisionId} must exist`)
    for (const reference of revisions.get(revisionId)) reachableChunkIds.add(reference.chunkId)
  }
  return { roots, reachableChunkIds }
}

test('independent persisted-reachability oracle proves collection only reclaims eligible orphan chunks', async (t) => {
  assert.equal(process.env.GCLOUD_PROJECT, 'demo-regression', 'refuse non-demo Firebase projects')
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator must be running')
  if (getApps().length === 0) initializeApp({ projectId: 'demo-regression' })
  const db = getFirestore()
  const { quarantineSceneOrphanChunks, collectQuarantinedOrphanChunks } =
    await import('../functions/lib/scene-maintenance-gc.js')
  const boardId = `maintenance_oracle_${randomUUID().replaceAll('-', '')}`
  const ownerId = 'maintenance-oracle-owner'
  const root = `boardScenes/${boardId}`
  t.after(async () => {
    await db.recursiveDelete(db.doc(root))
    await db.doc(`boardShares/${boardId}`).delete()
  })

  const now = Date.now()
  const revisionId = 'r1'
  const livePayload = JSON.stringify([{ key: 'live', kind: 'extra', value: { text: 'head root' } }])
  const jobPayload = JSON.stringify([{ key: 'job-root', kind: 'extra', value: { text: 'protected job root' } }])
  const orphanPayload = JSON.stringify([{ key: 'orphan', kind: 'extra', value: { text: 'eligible for collection' } }])
  const revisionCandidateDigest = digest('revision-manifest')
  const orphanCandidateDigest = digest('orphan-manifest')
  const jobCandidateDigest = digest('job-manifest')

  await db.doc(root).set({ ownerId, projectId: null, headRevisionId: revisionId, generation: 1, sceneFormatVersion: 1 })
  await db.doc(`boardShares/${boardId}`).set({ boardId, ownerId, projectId: null, pending: false })
  await db.doc(`${root}/revisions/${revisionId}`).set({
    generation: 1, sceneFormatVersion: 1, pageCount: 1, chunkCount: 1,
    candidateDigest: revisionCandidateDigest, parentRevisionId: null,
  })
  await db.doc(`${root}/revisions/${revisionId}/pages/000000`).set({
    references: [{ chunkId: 'live_chunk', digest: digest(livePayload) }],
  })
  await db.doc(`${root}/chunks/live_chunk`).set({ payload: livePayload, digest: digest(livePayload), uploadId: revisionId,
    slot: 0, uploaderUid: ownerId, generation: 1, kind: 'records' })
  await db.doc(`${root}/uploads/${revisionId}`).set({
    uploaderUid: ownerId, expectedHeadRevisionId: revisionId, generation: 1, sceneFormatVersion: 1,
    pageCount: 1, chunkCount: 1, newChunkCount: 1, candidateDigest: revisionCandidateDigest,
    createdAt: Timestamp.fromMillis(now - 90 * 60 * 60_000), expiresAt: Timestamp.fromMillis(now - 89 * 60 * 60_000),
    status: 'committed', receipt: { revisionId, generation: 1, candidateDigest: revisionCandidateDigest },
  })

  // Independent root categories: version, unexpired reader pin, and active protected Admin job.
  await db.doc(`${root}/versions/v1`).set({ revisionId, createdAt: Timestamp.now() })
  await db.doc(`${root}/readerPins/p1`).set({
    uid: ownerId, ownerId, generation: 1, revisionIds: [revisionId], purpose: 'board-load',
    createdAt: Timestamp.fromMillis(now - 60_000), expiresAt: Timestamp.fromMillis(now + 60_000),
    maxExpiresAt: Timestamp.fromMillis(now + 10 * 60_000),
  })
  await db.doc(`${root}/uploads/u_job`).set({
    uploaderUid: ownerId, expectedHeadRevisionId: revisionId, generation: 1, sceneFormatVersion: 1,
    pageCount: 1, chunkCount: 1, newChunkCount: 1, candidateDigest: jobCandidateDigest,
    createdAt: Timestamp.fromMillis(now - 60_000), expiresAt: Timestamp.fromMillis(now + 60 * 60_000),
  })
  await db.doc(`${root}/chunks/job_root_chunk`).set({ payload: jobPayload, digest: digest(jobPayload), uploadId: 'u_job',
    slot: 0, uploaderUid: ownerId, generation: 1, kind: 'records' })
  await db.doc(`${root}/maintenanceJobs/abandoned_job`).set({
    status: 'abandoned-protected', ownerId, leaseUntil: Timestamp.fromMillis(now + 60 * 60_000),
    protectedRevisionIds: [], protectedChunkIds: ['job_root_chunk'],
  })

  // Expired upload-owned chunk, outside every independent root above.
  await db.doc(`${root}/uploads/u_orphan`).set({
    uploaderUid: ownerId, expectedHeadRevisionId: revisionId, generation: 1, sceneFormatVersion: 1,
    pageCount: 1, chunkCount: 1, newChunkCount: 1, candidateDigest: orphanCandidateDigest,
    createdAt: Timestamp.fromMillis(now - 100 * 60 * 60_000), expiresAt: Timestamp.fromMillis(now - 90 * 60 * 60_000),
  })
  await db.doc(`${root}/chunks/orphan_chunk`).set({ payload: orphanPayload, digest: digest(orphanPayload), uploadId: 'u_orphan',
    slot: 0, uploaderUid: ownerId, generation: 1, kind: 'records' })

  const proposal = await quarantineSceneOrphanChunks(boardId)
  assert.equal(proposal.status, 'proposal-only')
  assert.equal(proposal.candidateCount, 1)
  const quarantinePageRef = db.doc(`${root}/maintenanceJobs/${proposal.jobId}/quarantinePages/000000`)
  const quarantinePage = (await quarantinePageRef.get()).data()
  const quarantinedAt = Timestamp.fromMillis(now - 50 * 60 * 60_000)
  quarantinePage.entries[0].quarantinedAt = quarantinedAt
  quarantinePage.entries[0].deleteNotBefore = Timestamp.fromMillis(quarantinedAt.toMillis() + 48 * 60 * 60_000)
  await quarantinePageRef.set(quarantinePage)

  const collection = await collectQuarantinedOrphanChunks(boardId, proposal.jobId)
  assert.equal(collection.status, 'complete')
  assert.equal(collection.deletedChunkCount, 1)

  // Rebuild roots from persisted state, without calling the planner or collector helpers.
  const { roots, reachableChunkIds } = await readOracleReachability(db, boardId)
  assert.ok(roots.has(revisionId), 'head/version/pin/receipt should preserve the committed revision')
  assert.ok(reachableChunkIds.has('live_chunk'), 'revision page references remain reachable')
  assert.ok(reachableChunkIds.has('job_root_chunk'), 'active Admin job protects its declared chunk')
  for (const chunkId of reachableChunkIds) {
    assert.equal((await db.doc(`${root}/chunks/${chunkId}`).get()).exists, true,
      `oracle-reachable chunk ${chunkId} must survive collection`)
  }
  assert.equal((await db.doc(`${root}/chunks/orphan_chunk`).get()).exists, false,
    'the mature, upload-owned, unreachable orphan should be reclaimed')
  assert.equal((await db.doc(`${root}/maintenanceJobs/${proposal.jobId}/collectionReceipts/orphan_chunk`).get()).exists, true,
    'reclamation must have a durable idempotency receipt')
})
