import { createHash } from 'node:crypto'
import { SCENE_FORMAT_VERSION } from '../../functions/lib/scene-codec.js'

const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const payload = (key) => JSON.stringify([{ key, kind: 'extra', value: { stable: true } }])

function baseFixture(now = Date.UTC(2026, 0, 1)) {
  const committedPayload = payload('committed')
  const orphanPayload = payload('abandoned-upload')
  const committedDigest = hash('committed-manifest')
  const orphanDigest = hash('abandoned-manifest')
  return {
    now,
    input: {
      censusComplete: true,
      ownershipVerified: true,
      head: {
        headRevisionId: 'r1', generation: 1, sceneFormatVersion: SCENE_FORMAT_VERSION,
        ownerId: 'owner-1', projectId: null,
      },
      revisions: [{
        id: 'r1',
        data: { generation: 1, sceneFormatVersion: SCENE_FORMAT_VERSION, pageCount: 1, chunkCount: 1, candidateDigest: committedDigest },
        pages: [{ id: '000000', data: { references: [{ chunkId: 'c1', digest: hash(committedPayload) }] } }],
      }],
      versions: [],
      readerPins: [],
      uploads: [
        { id: 'r1', data: {
          uploaderUid: 'owner-1', expectedHeadRevisionId: 'r1', generation: 1, sceneFormatVersion: SCENE_FORMAT_VERSION,
          pageCount: 1, chunkCount: 1, newChunkCount: 1, candidateDigest: committedDigest,
          createdAt: new Date(now - 100_000), expiresAt: new Date(now + 60_000), status: 'committed',
          receipt: { revisionId: 'r1', generation: 1, candidateDigest: committedDigest },
        } },
        { id: 'u2', data: {
          uploaderUid: 'owner-1', expectedHeadRevisionId: 'r1', generation: 1, sceneFormatVersion: SCENE_FORMAT_VERSION,
          pageCount: 1, chunkCount: 1, newChunkCount: 1, candidateDigest: orphanDigest,
          createdAt: new Date(now - 80 * 60 * 60_000), expiresAt: new Date(now - 50 * 60 * 60_000),
        } },
      ],
      maintenanceJobs: [],
      chunks: [
        { id: 'c1', data: { payload: committedPayload, digest: hash(committedPayload), uploadId: 'r1', slot: 0,
          uploaderUid: 'owner-1', generation: 1, kind: 'records' } },
        { id: 'c2', data: { payload: orphanPayload, digest: hash(orphanPayload), uploadId: 'u2', slot: 0,
          uploaderUid: 'owner-1', generation: 1, kind: 'records' } },
      ],
    },
  }
}

function cloneFixture() {
  return structuredClone(baseFixture())
}

export const classifiedSceneMaintenanceFixtures = [
  {
    classification: 'valid committed revision',
    make() {
      const fixture = cloneFixture()
      fixture.input.chunks = fixture.input.chunks.filter(({ id }) => id === 'c1')
      fixture.input.uploads = fixture.input.uploads.filter(({ id }) => id === 'r1')
      return fixture
    },
    expected: { safeToCollect: true, candidates: [], preserved: ['c1'], diagnostic: null },
  },
  {
    classification: 'legacy chunk with unverified provenance',
    make() {
      const fixture = cloneFixture()
      fixture.input.chunks.push({ id: 'legacy1', data: {
        payload: payload('legacy'), digest: hash(payload('legacy')), slot: 0, generation: 1, kind: 'records',
      } })
      return fixture
    },
    expected: { safeToCollect: false, candidates: [], preserved: ['c1', 'c2'], diagnostic: 'unknown-chunk-provenance' },
  },
  {
    classification: 'unsupported scene format',
    make() {
      const fixture = cloneFixture()
      fixture.input.head.sceneFormatVersion += 1
      fixture.input.revisions[0].data.sceneFormatVersion += 1
      return fixture
    },
    expected: { safeToCollect: false, candidates: [], preserved: ['c1', 'c2'], diagnostic: 'invalid-head' },
  },
  {
    classification: 'malformed or missing revision link',
    make() {
      const fixture = cloneFixture()
      fixture.input.chunks = fixture.input.chunks.filter(({ id }) => id !== 'c1')
      return fixture
    },
    expected: { safeToCollect: false, candidates: [], preserved: ['c2'], diagnostic: 'missing-referenced-chunk' },
  },
  {
    classification: 'active upload lease and bounded reader pin',
    make() {
      const fixture = cloneFixture()
      const upload = fixture.input.uploads.find(({ id }) => id === 'u2')
      upload.data.leaseId = 'lease-1'
      upload.data.leaseUntil = new Date(fixture.now + 60_000)
      const createdAt = new Date(fixture.now - 60_000)
      fixture.input.readerPins.push({ id: 'pin-1', data: {
        uid: 'reader-1', ownerId: 'owner-1', generation: 1, revisionIds: ['r1'],
        createdAt, expiresAt: new Date(fixture.now + 60_000), maxExpiresAt: new Date(createdAt.getTime() + 30 * 60_000),
      } })
      return fixture
    },
    expected: { safeToCollect: true, candidates: [], preserved: ['c1', 'c2'], diagnostic: null, pinReason: 'reader-pin:pin-1' },
  },
  {
    classification: 'expired upload-owned orphan candidate',
    make: cloneFixture,
    expected: { safeToCollect: true, candidates: ['c2'], preserved: ['c1'], diagnostic: null },
  },
]
