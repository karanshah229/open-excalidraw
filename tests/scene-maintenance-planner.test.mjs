import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { chunkDocumentBytes, SCENE_FORMAT_VERSION } from '../functions/lib/scene-codec.js'
import { planSceneMaintenance } from '../functions/lib/scene-maintenance-planner.js'
import { classifiedSceneMaintenanceFixtures } from './fixtures/scene-maintenance-classified-fixtures.mjs'

const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const payload = (key) => JSON.stringify([{ key, kind: 'extra', value: { stable: true } }])

function fixture(now = Date.now()) {
  const committedPayload = payload('committed')
  const orphanPayload = payload('abandoned-upload')
  const revisionDigest = hash('revision-manifest')
  const head = {
    headRevisionId: 'r1',
    generation: 1,
    sceneFormatVersion: SCENE_FORMAT_VERSION,
    ownerId: 'owner-1',
    projectId: null,
  }
  const revisions = [{
    id: 'r1',
    data: {
      generation: 1,
      sceneFormatVersion: SCENE_FORMAT_VERSION,
      pageCount: 1,
      chunkCount: 1,
      candidateDigest: revisionDigest,
    },
    pages: [{
      id: '000000',
      data: { references: [{ chunkId: 'c1', digest: hash(committedPayload) }] },
    }],
  }]
  const uploads = [
    {
      id: 'r1',
      data: {
        uploaderUid: 'owner-1', expectedHeadRevisionId: 'r1', generation: 1,
        sceneFormatVersion: SCENE_FORMAT_VERSION, pageCount: 1, chunkCount: 1, newChunkCount: 1,
        candidateDigest: revisionDigest, createdAt: new Date(now - 100_000), expiresAt: new Date(now + 60_000),
        status: 'committed',
        receipt: { revisionId: 'r1', generation: 1, candidateDigest: revisionDigest },
      },
    },
    {
      id: 'u2',
      data: {
        uploaderUid: 'owner-1', expectedHeadRevisionId: 'r1', generation: 1,
        sceneFormatVersion: SCENE_FORMAT_VERSION, pageCount: 1, chunkCount: 1, newChunkCount: 1,
        candidateDigest: hash('abandoned-manifest'), createdAt: new Date(now - 80 * 60 * 60_000),
        expiresAt: new Date(now - 50 * 60 * 60_000),
      },
    },
  ]
  const chunks = [
    {
      id: 'c1',
      data: { payload: committedPayload, digest: hash(committedPayload), uploadId: 'r1', slot: 0,
        uploaderUid: 'owner-1', generation: 1, kind: 'records' },
    },
    {
      id: 'c2',
      data: { payload: orphanPayload, digest: hash(orphanPayload), uploadId: 'u2', slot: 0,
        uploaderUid: 'owner-1', generation: 1, kind: 'records' },
    },
  ]
  const input = {
    censusComplete: true,
    ownershipVerified: true,
    head,
    revisions,
    versions: [],
    readerPins: [],
    uploads,
    maintenanceJobs: [],
    chunks,
  }
  return { now, input, committedPayload, orphanPayload }
}

test('planner identifies only old, upload-owned unreferenced chunks', () => {
  const { now, input, orphanPayload } = fixture()
  const plan = planSceneMaintenance(input, now)

  assert.equal(plan.safeToCollect, true)
  assert.deepEqual(plan.candidateOrphans.map(({ id }) => id), ['c2'])
  assert.equal(plan.candidateBytes, chunkDocumentBytes(orphanPayload))
  assert.ok(plan.preservedChunkIds.includes('c1'))
})

test('planner fails closed when census or ownership is not verified', () => {
  const incomplete = fixture()
  incomplete.input.censusComplete = false
  const unowned = fixture()
  unowned.input.ownershipVerified = false

  for (const { input, now } of [incomplete, unowned]) {
    const plan = planSceneMaintenance(input, now)
    assert.equal(plan.safeToCollect, false)
    assert.deepEqual(plan.candidateOrphans, [])
  }
})

test('planner preserves chunks from active uploads', () => {
  const { now, input } = fixture()
  input.uploads[1].data.expiresAt = new Date(now + 60 * 60_000)

  const plan = planSceneMaintenance(input, now)

  assert.equal(plan.safeToCollect, true)
  assert.deepEqual(plan.candidateOrphans, [])
  assert.ok(plan.preservedChunkIds.includes('c2'))
})

test('planner validates generation-reset job roots before it can authorize collection', () => {
  const { now, input } = fixture()
  input.maintenanceJobs.push({
    id: 'restore-1',
    data: {
      status: 'generation-reset-prepared', ownerId: 'owner-1', kind: 'generation-reset',
      leaseUntil: new Date(now + 30 * 24 * 60 * 60_000), protectedRevisionIds: ['r1'], protectedChunkIds: [],
    },
  })
  const valid = planSceneMaintenance(input, now)
  assert.equal(valid.safeToCollect, true)
  assert.ok(valid.preservedChunkIds.includes('c1'))

  input.maintenanceJobs[0].data.protectedRevisionIds = ['missing-revision']
  const malformed = planSceneMaintenance(input, now)
  assert.equal(malformed.safeToCollect, false)
  assert.deepEqual(malformed.candidateOrphans, [])
  assert.ok(malformed.diagnostics.some(({ code }) => code === 'unknown-maintenance-job-roots'))
})

test('planner blocks malformed pin lifetimes instead of ignoring their roots', () => {
  const { now, input } = fixture()
  const createdAt = new Date(now - 60_000)
  input.readerPins.push({
    id: 'pin-1',
    data: {
      uid: 'owner-1', ownerId: 'owner-1', generation: 1, revisionIds: ['r1'],
      createdAt, expiresAt: new Date(now + 60_000), maxExpiresAt: new Date(createdAt.getTime() + 31 * 60_000),
    },
  })

  const plan = planSceneMaintenance(input, now)

  assert.equal(plan.safeToCollect, false)
  assert.deepEqual(plan.candidateOrphans, [])
  assert.ok(plan.diagnostics.some(({ code }) => code === 'unknown-reader-pin-root'))
})

test('planner blocks when a committed revision references a missing chunk', () => {
  const { now, input } = fixture()
  input.chunks = input.chunks.filter(({ id }) => id !== 'c1')

  const plan = planSceneMaintenance(input, now)

  assert.equal(plan.safeToCollect, false)
  assert.deepEqual(plan.candidateOrphans, [])
  assert.ok(plan.diagnostics.some(({ code }) => code === 'missing-referenced-chunk'))
})

test('classified fixture corpus exercises every Phase 0 maintenance classification', async (t) => {
  for (const fixtureCase of classifiedSceneMaintenanceFixtures) {
    await t.test(fixtureCase.classification, () => {
      const { input, now } = fixtureCase.make()
      const before = structuredClone(input)
      const plan = planSceneMaintenance(input, now)

      assert.deepEqual(input, before, 'planner must not mutate census fixture data')
      assert.equal(plan.safeToCollect, fixtureCase.expected.safeToCollect)
      assert.deepEqual(plan.candidateOrphans.map(({ id }) => id), fixtureCase.expected.candidates)
      for (const id of fixtureCase.expected.preserved)
        assert.ok(plan.preservedChunkIds.includes(id), `expected ${id} to be preserved`)
      if (fixtureCase.expected.diagnostic)
        assert.ok(plan.diagnostics.some(({ code }) => code === fixtureCase.expected.diagnostic))
      if (fixtureCase.expected.pinReason)
        assert.ok(plan.reachableChunks.find(({ id }) => id === 'c1')?.reasons.includes(fixtureCase.expected.pinReason))
    })
  }
})
