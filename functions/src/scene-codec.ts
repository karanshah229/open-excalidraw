/** Pure wire codec shared by browser persistence and trusted scene publication. */
export const SCENE_FORMAT_VERSION = 1 as const
export const CHUNK_BUDGET_BYTES = 512 * 1024
export const CHUNK_ENVELOPE_RESERVE_BYTES = 4096
export const MANIFEST_PAGE_REFERENCES = 100

export type ScenePayload = {
  elements: Record<string, unknown>[]
  appState: Record<string, unknown>
  files?: Record<string, unknown>
  [key: string]: unknown
}
export type ChunkReference = { chunkId: string; digest: string }
export type PackedChunk = ChunkReference & { payload: string }
export type SceneRecord = {
  key: string
  kind: 'header' | 'appState' | 'element' | 'file' | 'extra'
  value: unknown
  order?: number
}

const encoder = new TextEncoder()
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** Match JSON persistence while making object-key order irrelevant to reuse. */
export function canonicalStringify(value: unknown): string {
  const normalise = (item: unknown): unknown => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Scene contains a non-finite number.')
    if (Array.isArray(item)) return item.map((entry) => (entry === undefined ? null : normalise(entry)))
    if (object(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .filter((key) => item[key] !== undefined)
          .map((key) => [key, normalise(item[key])]),
      )
    }
    if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint')
      throw new Error('Scene contains unsupported JSON data.')
    return item
  }
  const encoded = JSON.stringify(normalise(value))
  if (encoded === undefined) throw new Error('Missing scene JSON data.')
  return encoded
}

export function chunkDocumentBytes(payload: string): number {
  // The document stores JSON as one string, not recursively indexed fields.
  // Reserve for Firestore field/name/string overhead and bounded envelope IDs.
  return encoder.encode(payload).byteLength + CHUNK_ENVELOPE_RESERVE_BYTES
}

export async function digestString(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function paginateReferences(references: ChunkReference[], max = MANIFEST_PAGE_REFERENCES): ChunkReference[][] {
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('Invalid manifest page budget.')
  const pages: ChunkReference[][] = []
  for (let offset = 0; offset < references.length; offset += max) pages.push(references.slice(offset, offset + max))
  return pages
}

export async function manifestDigest(references: ChunkReference[], generation: number): Promise<string> {
  return digestString(canonicalStringify({ sceneFormatVersion: SCENE_FORMAT_VERSION, generation, references }))
}

function sceneRecords(scene: ScenePayload): SceneRecord[] {
  if (!object(scene) || !Array.isArray(scene.elements) || !object(scene.appState)) throw new Error('Invalid scene.')
  if (scene.files !== undefined && !object(scene.files)) throw new Error('Invalid scene files.')
  const ids = new Set<string>()
  const records: SceneRecord[] = [
    { key: '$header', kind: 'header', value: { hasFiles: scene.files !== undefined } },
    { key: '$appState', kind: 'appState', value: scene.appState },
  ]
  for (const [order, element] of scene.elements.entries()) {
    if (!object(element) || typeof element.id !== 'string' || !element.id || ids.has(element.id))
      throw new Error('Scene elements require unique nonempty IDs.')
    ids.add(element.id)
    records.push({ key: `element:${element.id}`, kind: 'element', value: element, order })
  }
  for (const [id, file] of Object.entries(scene.files ?? {}).sort(([a], [b]) => a.localeCompare(b)))
    records.push({ key: `file:${id}`, kind: 'file', value: file })
  for (const key of Object.keys(scene).sort()) {
    if (key !== 'elements' && key !== 'appState' && key !== 'files' && scene[key] !== undefined)
      records.push({ key: `extra:${key}`, kind: 'extra', value: scene[key] })
  }
  return records
}

function parseRecords(payload: string): SceneRecord[] {
  const records: unknown = JSON.parse(payload)
  if (!Array.isArray(records) || records.length === 0) throw new Error('Invalid empty chunk payload.')
  for (const record of records) {
    if (!object(record) || typeof record.key !== 'string' || !Object.hasOwn(record, 'value'))
      throw new Error('Invalid chunk record.')
    if (!['header', 'appState', 'element', 'file', 'extra'].includes(String(record.kind)))
      throw new Error('Unsupported chunk record kind.')
  }
  return records as SceneRecord[]
}

/** Retain prior membership; spills and new records are packed into new chunks. */
export async function packScene(
  scene: ScenePayload,
  previousChunks: PackedChunk[] = [],
  maxBytes = CHUNK_BUDGET_BYTES,
): Promise<PackedChunk[]> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= CHUNK_ENVELOPE_RESERVE_BYTES + 2 || maxBytes > CHUNK_BUDGET_BYTES)
    throw new Error('Invalid chunk byte budget.')
  const records = sceneRecords(scene)
  const byKey = new Map(records.map((record) => [record.key, record]))
  const encoded = new Map(records.map((record) => [record.key, canonicalStringify(record)]))
  const limit = maxBytes - CHUNK_ENVELOPE_RESERVE_BYTES
  for (const record of records) {
    if (encoder.encode(encoded.get(record.key)!).byteLength + 2 > limit)
      throw new Error(`Scene record ${record.key} exceeds the chunk byte budget. The local edit must be retained.`)
  }
  const groups: { records: SceneRecord[]; previous?: PackedChunk }[] = []
  const assigned = new Set<string>()
  for (const previous of previousChunks) {
    if ((await digestString(previous.payload)) !== previous.digest) throw new Error('Previous chunk digest mismatch.')
    const group: SceneRecord[] = []
    let bytes = 2
    for (const old of parseRecords(previous.payload)) {
      const current = byKey.get(old.key)
      if (!current || assigned.has(current.key)) continue
      const added = encoder.encode(encoded.get(current.key)!).byteLength + (group.length ? 1 : 0)
      if (bytes + added > limit) continue
      group.push(current)
      bytes += added
      assigned.add(current.key)
    }
    if (group.length) groups.push({ records: group, previous })
  }
  let pending: SceneRecord[] = []
  let bytes = 2
  for (const record of records) {
    if (assigned.has(record.key)) continue
    const added = encoder.encode(encoded.get(record.key)!).byteLength + (pending.length ? 1 : 0)
    if (pending.length && bytes + added > limit) {
      groups.push({ records: pending })
      pending = []
      bytes = 2
    }
    bytes += encoder.encode(encoded.get(record.key)!).byteLength + (pending.length ? 1 : 0)
    pending.push(record)
  }
  if (pending.length) groups.push({ records: pending })
  return Promise.all(
    groups.map(async ({ records: group, previous }) => {
      const payload = canonicalStringify(group)
      const digest = await digestString(payload)
      return { payload, digest, chunkId: previous?.payload === payload ? previous.chunkId : digest }
    }),
  )
}

export async function assembleScene(chunks: PackedChunk[]): Promise<ScenePayload> {
  const records: SceneRecord[] = []
  const keys = new Set<string>()
  const chunkIds = new Set<string>()
  for (const chunk of chunks) {
    if (chunkIds.has(chunk.chunkId) || (await digestString(chunk.payload)) !== chunk.digest)
      throw new Error('Duplicate chunk or chunk digest mismatch.')
    chunkIds.add(chunk.chunkId)
    for (const record of parseRecords(chunk.payload)) {
      if (keys.has(record.key)) throw new Error('Duplicate scene record.')
      keys.add(record.key)
      records.push(record)
    }
  }
  const header = records.find((record) => record.key === '$header')
  const state = records.find((record) => record.key === '$appState')
  if (header?.kind !== 'header' || !object(header.value) || typeof header.value.hasFiles !== 'boolean')
    throw new Error('Missing scene header.')
  if (state?.kind !== 'appState' || !object(state.value)) throw new Error('Missing scene app state.')
  const elements: { order: number; value: Record<string, unknown> }[] = []
  const files: [string, unknown][] = []
  const extra: [string, unknown][] = []
  const orders = new Set<number>()
  for (const record of records) {
    if (record.kind === 'header' && record.key !== '$header') throw new Error('Invalid header record.')
    if (record.kind === 'appState' && record.key !== '$appState') throw new Error('Invalid app state record.')
    if (record.kind === 'element') {
      if (
        !object(record.value) ||
        typeof record.value.id !== 'string' ||
        !record.value.id ||
        record.key !== `element:${record.value.id}` ||
        !Number.isSafeInteger(record.order) ||
        Number(record.order) < 0 ||
        orders.has(Number(record.order))
      )
        throw new Error('Invalid scene element record/order.')
      orders.add(Number(record.order))
      elements.push({ order: Number(record.order), value: record.value })
    } else if (record.kind === 'file') {
      if (!record.key.startsWith('file:') || !record.key.slice(5) || !header.value.hasFiles)
        throw new Error('Invalid scene file record.')
      files.push([record.key.slice(5), record.value])
    } else if (record.kind === 'extra') {
      const name = record.key.slice(6)
      if (!record.key.startsWith('extra:') || !name || ['elements', 'appState', 'files'].includes(name))
        throw new Error('Invalid extra scene field.')
      extra.push([name, record.value])
    }
  }
  elements.sort((a, b) => a.order - b.order)
  if (elements.some((element, index) => element.order !== index)) throw new Error('Incomplete scene element order.')
  return {
    ...Object.fromEntries(extra),
    elements: elements.map((element) => element.value),
    appState: state.value,
    ...(header.value.hasFiles ? { files: Object.fromEntries(files) } : {}),
  }
}
