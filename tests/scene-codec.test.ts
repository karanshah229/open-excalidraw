import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  packScene,
  assembleScene,
  paginateReferences,
  manifestDigest,
  canonicalStringify,
  chunkDocumentBytes,
  CHUNK_ENVELOPE_RESERVE_BYTES,
  type ScenePayload,
  type PackedChunk,
} from '../functions/src/scene-codec'

const budget = 8192
const scene: ScenePayload = {
  elements: Array.from({ length: 60 }, (_, i) => ({
    id: `shape-${i}`,
    type: i === 0 ? 'image' : 'rectangle',
    version: 3,
    versionNonce: 1000 + i,
    index: `a${i}`,
    isDeleted: i === 7,
    frameId: i === 9 ? 'shape-8' : null,
    boundElements: i === 10 ? [{ id: 'shape-11', type: 'arrow' }] : null,
    groupIds: ['group-one'],
    customData: { text: '🌍'.repeat(110) },
  })),
  appState: { viewBackgroundColor: '#fefefe', gridSize: 20 },
  files: { image: { id: 'image', mimeType: 'image/png', storagePath: 'boards/board/assets/image', created: 123 } },
  semanticModel: { schemaVersion: 1, nodes: [{ id: 'shape-9', stereotype: 'class' }] },
}
const packed = await packScene(scene, [], budget)
assert(packed.length > 1)
for (const chunk of packed) {
  assert.equal(chunk.digest, createHash('sha256').update(chunk.payload).digest('hex'))
  assert(
    Buffer.byteLength(chunk.payload) + CHUNK_ENVELOPE_RESERVE_BYTES <= budget,
    'UTF8 bytes plus independently checked envelope headroom fit budget',
  )
}
assert.deepEqual(
  await assembleScene([...packed].reverse()),
  scene,
  'Manifest loading order does not change stacking order',
)
assert.deepEqual(await packScene(scene, packed, budget), packed, 'Unchanged scene reuses every immutable chunk')
const changed = structuredClone(scene)
changed.elements[0].x = 123
const repacked = await packScene(changed, packed, budget)
assert.equal(
  repacked.filter((chunk) => !packed.some((prior) => prior.chunkId === chunk.chunkId)).length,
  1,
  'An edit replaces its containing chunk only',
)
assert.deepEqual(await assembleScene(repacked), changed)
const grown = structuredClone(changed)
grown.elements[0].customData = { text: '🌍'.repeat(800) }
assert.deepEqual(
  await assembleScene(await packScene(grown, repacked, budget)),
  grown,
  'A growing element can spill without being duplicated or lost',
)
const reordered = { ...scene, elements: [...scene.elements].reverse() }
assert.deepEqual(await assembleScene(await packScene(reordered, packed, budget)), reordered)
assert.deepEqual(await assembleScene(await packScene({ elements: [], appState: {} })), { elements: [], appState: {} })
assert.deepEqual(await assembleScene(await packScene({ elements: [], appState: {}, files: {} })), {
  elements: [],
  appState: {},
  files: {},
})
assert.equal(canonicalStringify({ b: 1, a: 2 }), canonicalStringify({ a: 2, b: 1 }))
assert.equal(chunkDocumentBytes('🌍'), 4 + CHUNK_ENVELOPE_RESERVE_BYTES)
assert.deepEqual(
  paginateReferences(Array.from({ length: 205 }, (_, n) => ({ chunkId: `${n}`, digest: 'd' }))).map(
    (page) => page.length,
  ),
  [100, 100, 5],
)
const refs = packed.map(({ chunkId, digest }) => ({ chunkId, digest }))
assert.notEqual(await manifestDigest(refs, 1), await manifestDigest(refs, 2), 'Generation is cryptographically bound')
assert.notEqual(await manifestDigest(refs, 1), await manifestDigest([...refs].reverse(), 1), 'Reference order is bound')
await assert.rejects(
  packScene({ elements: [{ id: 'huge', text: '🌍'.repeat(1100) }], appState: {} }, [], budget),
  /exceeds/,
)
await assert.rejects(packScene({ elements: [{ id: 'duplicate' }, { id: 'duplicate' }], appState: {} }), /unique/)
await assert.rejects(packScene({ elements: [{ id: '' }], appState: {} }), /nonempty/)
await assert.rejects(packScene({ elements: [{ id: 'nan', x: NaN }], appState: {} }), /non-finite/)
await assert.rejects(assembleScene([...packed, packed[0]]), /Duplicate/)
await assert.rejects(assembleScene([{ ...packed[0], payload: packed[0].payload + ' ' }, ...packed.slice(1)]), /digest/)

async function forged(records: unknown[]): Promise<PackedChunk[]> {
  const payload = JSON.stringify(records)
  return [{ chunkId: 'forged', payload, digest: createHash('sha256').update(payload).digest('hex') }]
}
const validRecords = packed.flatMap((chunk) => JSON.parse(chunk.payload))
await assert.rejects(
  assembleScene(await forged(validRecords.filter((record) => record.key !== '$appState'))),
  /app state/,
)
await assert.rejects(
  assembleScene(await forged(validRecords.filter((record) => record.key !== 'element:shape-1'))),
  /order/,
)
await assert.rejects(assembleScene(await forged([...validRecords, validRecords[0]])), /Duplicate/)
await assert.rejects(
  assembleScene(
    await forged(validRecords.map((record) => (record.key === 'element:shape-1' ? { ...record, order: 0 } : record))),
  ),
  /order/,
)
await assert.rejects(
  assembleScene(
    await forged(
      validRecords.map((record) =>
        record.key === 'element:shape-1' ? { ...record, key: 'element:mismatch' } : record,
      ),
    ),
  ),
  /element/,
)
await assert.rejects(
  assembleScene(
    await forged(
      validRecords.map((record) => (record.key === '$header' ? { ...record, value: { hasFiles: false } } : record)),
    ),
  ),
  /file/,
)

await assert.rejects(
  assembleScene(
    await forged(
      validRecords.map((record) =>
        record.key === 'element:shape-1' ? { ...record, key: 'element:', value: { ...record.value, id: '' } } : record,
      ),
    ),
  ),
  /element/,
)
await assert.rejects(
  assembleScene(
    await forged(validRecords.map((record) => (record.key === 'file:image' ? { ...record, key: 'file:' } : record))),
  ),
  /file/,
)

// Seeded varying scenes verify packing independently of chunk membership/order.
let seed = 0x600d
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 2 ** 32
}
for (let pass = 0; pass < 50; pass++) {
  const sample: ScenePayload = {
    elements: Array.from({ length: Math.floor(random() * 100) }, (_, n) => ({
      id: `p${pass}-${n}`,
      text: 'λ'.repeat(Math.floor(random() * 300)),
      isDeleted: random() < 0.2,
      version: Math.floor(random() * 10),
      customData: { nested: [null, n, { uml: 'class' }] },
    })),
    appState: { viewBackgroundColor: '#fff' },
    files: {},
  }
  const chunks = await packScene(sample, [], budget)
  assert.deepEqual(await assembleScene(chunks), sample, `Seeded round-trip ${pass}`)
  assert(chunks.every((chunk) => Buffer.byteLength(chunk.payload) + 4096 <= budget))
}
console.log(
  'PASS scene codec: UTF8 budgets, stable reuse/spill, tombstones, order, bindings, files, semantic fields, corrupt data and 50 seeded round trips',
)
