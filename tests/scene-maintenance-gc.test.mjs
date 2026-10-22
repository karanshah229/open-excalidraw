import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'

const requireFromFunctions = createRequire(new URL('../functions/package.json', import.meta.url))
const { getApps, initializeApp } = requireFromFunctions('firebase-admin/app')
const { Timestamp, getFirestore } = requireFromFunctions('firebase-admin/firestore')

test('fenced collector removes only a quarantined orphan chunk', async (t) => {
  assert.equal(process.env.GCLOUD_PROJECT, 'demo-regression', 'refuse non-demo Firebase projects')
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator must be running')

  if (getApps().length === 0) initializeApp({ projectId: 'demo-regression' })
  const db = getFirestore()
  const { quarantineSceneOrphanChunks, collectQuarantinedOrphanChunks } =
    await import('../functions/lib/scene-maintenance-gc.js')
  const boardId = `scene_maintenance_canary_${randomUUID().replaceAll('-', '')}`
  const ownerId = 'maintenance-test-owner'
  const root = `boardScenes/${boardId}`
  t.after(async () => {
    await db.recursiveDelete(db.doc(root))
    await db.doc(`boardShares/${boardId}`).delete()
  })

  const now = Date.now()
  const committedPayload = JSON.stringify([{ key: 'live', kind: 'extra', value: { text: 'keep' } }])
  const orphanPayload = JSON.stringify([{ key: 'orphan', kind: 'extra', value: { text: 'delete' } }])
  const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
  const candidateDigest = digest('revision-candidate')
  const committedDigest = digest(committedPayload)

  await db.doc(root).set({
    ownerId,
    projectId: null,
    headRevisionId: 'r1',
    generation: 1,
    sceneFormatVersion: 1,
    sceneMaintenanceCanary: true,
  })
  await db.doc(`boardShares/${boardId}`).set({ boardId, ownerId, projectId: null, pending: false })
  await db.doc(`${root}/revisions/r1`).set({
    generation: 1, sceneFormatVersion: 1, pageCount: 1, chunkCount: 1,
    candidateDigest, parentRevisionId: null, createdAt: new Date(now - 90 * 60 * 60_000).toISOString(),
  })
  await db.doc(`${root}/revisions/r1/pages/000000`).set({
    references: [{ chunkId: 'live_chunk', digest: committedDigest }],
  })
  await db.doc(`${root}/chunks/live_chunk`).set({
    payload: committedPayload, digest: committedDigest, uploadId: 'r1', slot: 0,
    uploaderUid: ownerId, generation: 1, kind: 'records',
  })
  await db.doc(`${root}/uploads/r1`).set({
    uploaderUid: ownerId, expectedHeadRevisionId: 'r1', generation: 1, sceneFormatVersion: 1,
    pageCount: 1, chunkCount: 1, newChunkCount: 1, candidateDigest,
    createdAt: Timestamp.fromMillis(now - 90 * 60 * 60_000), expiresAt: Timestamp.fromMillis(now - 89 * 60 * 60_000),
    status: 'committed', receipt: { revisionId: 'r1', generation: 1, candidateDigest },
  })
  const uploadCreatedAt = Timestamp.fromMillis(now - 100 * 60 * 60_000)
  const uploadExpiresAt = Timestamp.fromMillis(now - 90 * 60 * 60_000)
  await db.doc(`${root}/uploads/u_orphan`).set({
    uploaderUid: ownerId, expectedHeadRevisionId: 'r1', generation: 1, sceneFormatVersion: 1,
    pageCount: 1, chunkCount: 1, newChunkCount: 1, candidateDigest: digest('orphan-candidate'),
    createdAt: uploadCreatedAt, expiresAt: uploadExpiresAt,
  })
  await db.doc(`${root}/chunks/orphan_chunk`).set({
    payload: orphanPayload, digest: digest(orphanPayload), uploadId: 'u_orphan', slot: 0,
    uploaderUid: ownerId, generation: 1, kind: 'records',
  })

  const proposal = await quarantineSceneOrphanChunks(boardId)
  assert.equal(proposal.status, 'proposal-only')
  assert.equal(proposal.candidateCount, 1)

  const normalCollection = await collectQuarantinedOrphanChunks(boardId, proposal.jobId)
  assert.equal(normalCollection.status, 'blocked', 'ordinary collection must honor the durable quarantine delay')
  assert.equal((await db.doc(`${root}/chunks/orphan_chunk`).get()).exists, true)

  const collection = await collectQuarantinedOrphanChunks(boardId, proposal.jobId, { allowSyntheticCanaryFastTrack: true })
  assert.equal(collection.status, 'complete')
  assert.equal(collection.deletedChunkCount, 1)
  assert.equal((await db.doc(`${root}/chunks/live_chunk`).get()).exists, true)
  assert.equal((await db.doc(`${root}/chunks/orphan_chunk`).get()).exists, false)
  assert.equal((await db.doc(`${root}/maintenance/control`).get()).data().admission, 'open')
  assert.equal((await db.doc(`${root}/maintenanceJobs/${proposal.jobId}/collectionReceipts/orphan_chunk`).get()).exists, true)
})

test('collector preserves an orphan that became reachable after quarantine', async (t) => {
  assert.equal(process.env.GCLOUD_PROJECT, 'demo-regression', 'refuse non-demo Firebase projects')
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator must be running')
  if (getApps().length === 0) initializeApp({ projectId: 'demo-regression' })
  const db = getFirestore()
  const { quarantineSceneOrphanChunks, collectQuarantinedOrphanChunks } =
    await import('../functions/lib/scene-maintenance-gc.js')
  const boardId = `maintenance_race_${randomUUID().replaceAll('-', '')}`
  const ownerId = 'maintenance-test-owner'
  const root = `boardScenes/${boardId}`
  t.after(async () => {
    await db.recursiveDelete(db.doc(root))
    await db.doc(`boardShares/${boardId}`).delete()
  })

  const now = Date.now()
  const livePayload = JSON.stringify([{ key: 'live', kind: 'extra', value: { text: 'keep' } }])
  const orphanPayload = JSON.stringify([{ key: 'later-live', kind: 'extra', value: { text: 'keep too' } }])
  const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
  const revisionDigest = digest('revision-r1')
  const orphanDigest = digest(orphanPayload)
  await db.doc(root).set({ ownerId, projectId: null, headRevisionId: 'r1', generation: 1, sceneFormatVersion: 1 })
  await db.doc(`boardShares/${boardId}`).set({ boardId, ownerId, projectId: null, pending: false })
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
  await db.doc(`${root}/uploads/u_orphan`).set({
    uploaderUid: ownerId, expectedHeadRevisionId: 'r1', generation: 1, sceneFormatVersion: 1,
    pageCount: 1, chunkCount: 1, newChunkCount: 1, candidateDigest: digest('orphan-candidate'),
    createdAt: Timestamp.fromMillis(now - 100 * 60 * 60_000), expiresAt: Timestamp.fromMillis(now - 90 * 60 * 60_000),
  })
  await db.doc(`${root}/chunks/orphan_chunk`).set({
    payload: orphanPayload, digest: orphanDigest, uploadId: 'u_orphan', slot: 0,
    uploaderUid: ownerId, generation: 1, kind: 'records',
  })

  const proposal = await quarantineSceneOrphanChunks(boardId)
  assert.equal(proposal.status, 'proposal-only')
  assert.equal(proposal.candidateCount, 1)
  await assert.rejects(collectQuarantinedOrphanChunks(boardId, proposal.jobId, { allowSyntheticCanaryFastTrack: true }),
    /synthetic canary boards/i)
  assert.equal((await db.doc(`${root}/chunks/orphan_chunk`).get()).exists, true,
    'fast-track must fail before opening a gate or deleting data on an unmarked board')
  const proposalPage = db.doc(`${root}/maintenanceJobs/${proposal.jobId}/quarantinePages/000000`)
  const page = (await proposalPage.get()).data()
  const quarantineAt = Timestamp.fromMillis(now - 50 * 60 * 60_000)
  page.entries[0].quarantinedAt = quarantineAt
  page.entries[0].deleteNotBefore = Timestamp.fromMillis(quarantineAt.toMillis() + 48 * 60 * 60_000)
  await proposalPage.set(page)

  await db.doc(`${root}/revisions/r2`).set({
    generation: 1, sceneFormatVersion: 1, pageCount: 1, chunkCount: 1, candidateDigest: digest('revision-r2'),
  })
  await db.doc(`${root}/revisions/r2/pages/000000`).set({
    references: [{ chunkId: 'orphan_chunk', digest: orphanDigest }],
  })
  await db.doc(root).update({ headRevisionId: 'r2' })

  const collection = await collectQuarantinedOrphanChunks(boardId, proposal.jobId)
  assert.equal(collection.status, 'blocked')
  assert.equal(collection.deletedChunkCount, 0)
  assert.equal((await db.doc(`${root}/chunks/orphan_chunk`).get()).exists, true)
  assert.equal((await db.doc(`${root}/maintenance/control`).get()).data().admission, 'open')
})

test('expired collection recovery advances the fence before reopening admission', async (t) => {
  assert.equal(process.env.GCLOUD_PROJECT, 'demo-regression', 'refuse non-demo Firebase projects')
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator must be running')
  if (getApps().length === 0) initializeApp({ projectId: 'demo-regression' })
  const db = getFirestore()
  const { recoverAbandonedSceneChunkCollection } = await import('../functions/lib/scene-maintenance-gc.js')
  const boardId = `maintenance_recovery_${randomUUID().replaceAll('-', '')}`
  const ownerId = 'maintenance-test-owner'
  const root = `boardScenes/${boardId}`
  const jobId = `collect_${randomUUID()}`
  const token = randomUUID()
  t.after(async () => db.recursiveDelete(db.doc(root)))

  await db.doc(root).set({ ownerId, projectId: null, headRevisionId: 'r1', generation: 1, sceneFormatVersion: 1 })
  await db.doc(`${root}/maintenance/control`).set({
    admission: 'closed', epoch: 7, jobId, token,
    leaseUntil: Timestamp.fromMillis(Date.now() - 60_000), phase: 'fresh-census',
  })
  await db.doc(`${root}/maintenanceJobs/${jobId}`).set({
    kind: 'orphan-chunk-collection', status: 'lease-expired-awaiting-recovery', ownerId,
    epoch: 7, token, leaseUntil: Timestamp.fromMillis(Date.now() - 60_000), phase: 'fresh-census',
  })

  const result = await recoverAbandonedSceneChunkCollection(boardId, jobId, 7)
  const control = (await db.doc(`${root}/maintenance/control`).get()).data()
  const job = (await db.doc(`${root}/maintenanceJobs/${jobId}`).get()).data()
  assert.equal(result.recovered, true)
  assert.equal(result.newEpoch, 8)
  assert.equal(control.admission, 'open')
  assert.equal(control.epoch, 8)
  assert.equal(job.status, 'cancelled')
  assert.notEqual(job.token, token)
})
