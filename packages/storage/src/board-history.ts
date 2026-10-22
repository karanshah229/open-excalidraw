import type { BoardDocument, BoardScene } from './index'
import { mergeBoardScenes } from './scene-merge'

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const CHUNK_CHARACTERS = 64 * 1024
const PAGE_RECORDS = 128

export type BoardNotes = Record<string, string>
export type HistoryReceipt = {
  localSnapshotVersionId: string
  canonicalVersionId?: string
  acceptedAt: string
  expiresAt: string
}
export type HistorySaveOptions = {
  notes?: BoardNotes
  expectedFence?: number
  sourceBaseVersionId?: string
  changedFields?: { scene?: boolean; name?: boolean; notes?: string[] }
  fieldBases?: Record<string, unknown>
  reason?: 'create' | 'save' | 'notes' | 'rename' | 'restore'
  /** Only hydration of a previously published cloud head may use this mode. */
  cloudBaseline?: boolean
}
export type LocalBoardVersion = {
  localVersionId: string
  boardId: string
  name: string
  capturedAt: string
  expiresAt: string
  generation: number
  localGeneration?: number
  branchId: string
  branchSequence: number
  parentLocalVersionId?: string
  sourceBaseVersionId?: string
  contentDigest: string
  uploadStatus: 'pending' | 'published'
  reason: NonNullable<HistorySaveOptions['reason']>
  isCurrent: boolean
  active: boolean
  receipt?: HistoryReceipt
}
export type HistoryOutboxEntry = {
  identity: string
  boardId: string
  localVersionId: string
  mutationId: string
  captureMutationId: string
  headMutationId: string
  sourceBaseVersionId?: string
  generation: number
  expectedFence: number
  branchId: string
  publicationIntent: 'head' | 'history-only'
  changedFields: NonNullable<HistorySaveOptions['changedFields']>
  fieldBases: Record<string, unknown>
  retryState: 'pending' | 'blocked'
  receipt?: HistoryReceipt
  headAcknowledged?: boolean
  lastError?: string
  importPublication?: {
    localBranchId: string; branchSequence: number; sourceBaseVersionId: string;
    parentVersionId: string; commitId: string
  }
}
export type CommittedBoardContent = { document: BoardDocument; notes: BoardNotes; version: LocalBoardVersion }

type Current = {
  key: string
  identity: string
  boardId: string
  document: BoardDocument
  notes: BoardNotes
  headVersionId: string
  branchId: string
  generation: number
  fence: number
  sequence: number
  contentDigest: string
  restoring: boolean
}
type StoredVersion = LocalBoardVersion & {
  key: string
  identity: string
  document: Omit<BoardDocument, 'scene'>
  pageIds: string[]
  importPublication?: HistoryOutboxEntry['importPublication']
}
type StoredOutbox = HistoryOutboxEntry & { key: string }
type Payload = { key: string; identity: string; text: string }
type RecordPayload = { kind: 'header' | 'element' | 'file' | 'notes'; value: unknown; id?: string }

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error)
  })
}

function key(identity: string, ...parts: string[]): string {
  return JSON.stringify([identity, ...parts])
}

/** Stable JSON ordering makes identity independent of object insertion order. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_name, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item))
      return Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]]))
    return item
  })
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * One native IndexedDB transaction owns current content, history and outbox.
 * RxDB is a repairable projection; it must never be used as a cross-database
 * transaction participant. SHA-256 and snapshot assembly happen before opening
 * a write transaction, then a compare-and-retry guards inter-tab changes.
 */
export class BoardHistoryStore {
  private connection?: Promise<IDBDatabase>
  private identity: () => string
  private databaseName: string
  private clock: () => number

  constructor(options: { identity?: () => string; databaseName?: string; clock?: () => number } = {}) {
    this.identity = options.identity ?? (() => 'local-user')
    this.databaseName = options.databaseName ?? 'agentic-whiteboard-history-v1'
    this.clock = options.clock ?? Date.now
  }

  private database(): Promise<IDBDatabase> {
    this.connection ??= new Promise((resolve, reject) => {
      const opening = indexedDB.open(this.databaseName, 1)
      opening.onupgradeneeded = () => {
        for (const name of ['current', 'versions', 'payloads', 'outbox']) {
          const store = opening.result.createObjectStore(name, { keyPath: 'key' })
          store.createIndex('identity', 'identity')
        }
      }
      opening.onsuccess = () => {
        const db = opening.result
        db.onversionchange = () => { db.close(); this.connection = undefined }
        resolve(db)
      }
      opening.onerror = () => { this.connection = undefined; reject(opening.error) }
      opening.onblocked = () => { this.connection = undefined; reject(new Error('HISTORY_DATABASE_BLOCKED')) }
    })
    return this.connection
  }

  private async transaction<T>(mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.database()
    const tx = db.transaction(['current', 'versions', 'payloads', 'outbox'], mode)
    const finished = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('HISTORY_TRANSACTION_ABORTED'))
      tx.onerror = () => undefined
    })
    try {
      const value = await run(tx)
      await finished
      return value
    } catch (error) {
      try { tx.abort() } catch { /* A failed request may already have aborted. */ }
      await finished.catch(() => undefined)
      throw error
    }
  }

  private readCurrent(identity: string, boardId: string): Promise<Current | undefined> {
    return this.transaction('readonly', (tx) => request(tx.objectStore('current').get(key(identity, boardId))))
  }

  private publicVersion(version: StoredVersion, current?: Current): LocalBoardVersion {
    const { key: _key, identity: _identity, document: _document, pageIds: _pageIds, importPublication: _import, ...publicFields } = version
    return { ...publicFields, isCurrent: current?.headVersionId === version.localVersionId &&
      current.contentDigest === version.contentDigest }
  }

  private async pack(identity: string, document: BoardDocument, notes: BoardNotes) {
    const { elements, files, ...header } = document.scene
    const records: RecordPayload[] = [{ kind: 'header', value: { ...header, ...(files ? { files: {} } : {}) } }]
    records.push(...elements.map((value) => ({ kind: 'element' as const, value })))
    records.push(...Object.entries(files ?? {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([id, value]) => ({ kind: 'file' as const, id, value })))
    records.push(...Object.entries(notes).sort(([a], [b]) => a.localeCompare(b))
      .map(([id, text]) => ({ kind: 'notes' as const, id, value: text })))
    const payloads = new Map<string, Payload>()
    const recordChunks: string[][] = []
    for (const record of records) {
      const text = stable(record)
      const ids: string[] = []
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(text.length, offset + CHUNK_CHARACTERS)
        // UTF-8 hashing must never normalize a split surrogate into U+FFFD.
        if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--
        const block = text.slice(offset, end)
        const id = await digest(block)
        payloads.set(id, { key: key(identity, id), identity, text: block })
        ids.push(id)
        offset = end
      }
      recordChunks.push(ids)
    }
    const pageIds: string[] = []
    for (let offset = 0; offset < recordChunks.length; offset += PAGE_RECORDS) {
      const text = stable(recordChunks.slice(offset, offset + PAGE_RECORDS))
      const id = await digest(text)
      payloads.set(id, { key: key(identity, id), identity, text })
      pageIds.push(id)
    }
    return { payloads, pageIds, contentDigest: await digest(stable({ name: document.name, scene: document.scene, notes })) }
  }

  async getCommittedContent(boardId: string): Promise<CommittedBoardContent | null> {
    const identity = this.identity()
    return this.transaction('readonly', async (tx) => {
      const current: Current | undefined = await request(tx.objectStore('current').get(key(identity, boardId)))
      if (!current) return null
      const version: StoredVersion = await request(tx.objectStore('versions').get(key(identity, boardId, current.headVersionId)))
      return { document: current.document, notes: current.notes, version: this.publicVersion(version, current) }
    })
  }

  async listCurrentDocuments(): Promise<BoardDocument[]> {
    const identity = this.identity()
    return this.transaction('readonly', async (tx) => {
      const current: Current[] = await request(tx.objectStore('current').index('identity').getAll(identity))
      return current.map((item) => item.document)
    })
  }

  /** Remote hydration updates unrelated committed notes while preserving pending slide intents. */
  async reconcileCloudNotes(boardId: string, remote: BoardNotes): Promise<void> {
    const identity = this.identity()
    for (;;) {
      const previous = await this.readCurrent(identity, boardId)
      if (!previous) return
      const entries = await this.listOutbox(boardId)
      const dirty = new Set(entries.filter((entry) => !entry.headAcknowledged).flatMap((entry) => entry.changedFields.notes ?? []))
      const notes = { ...remote }
      for (const slideId of dirty) {
        if (Object.hasOwn(previous.notes, slideId)) notes[slideId] = previous.notes[slideId]
        else delete notes[slideId]
      }
      const contentDigest = await digest(stable({ name: previous.document.name, scene: previous.document.scene, notes }))
      const changed = await this.transaction('readwrite', async (tx) => {
        const current: Current | undefined = await request(tx.objectStore('current').get(key(identity, boardId)))
        if (current?.headVersionId !== previous.headVersionId || current?.document.revision !== previous.document.revision || current?.fence !== previous.fence)
          return false
        await request(tx.objectStore('current').put({ ...current, notes, contentDigest }))
        return true
      })
      if (changed) return
    }
  }

  /** Choosing remote content retires head intent, never the user's saved historical tuple. */
  async acceptRemoteNote(boardId: string, slideId: string, text: string): Promise<void> {
    const identity = this.identity()
    for (;;) {
      const previous = await this.readCurrent(identity, boardId)
      if (!previous) return
      if (previous.restoring) throw new Error('BOARD_RESTORE_IN_PROGRESS')
      const notes = { ...previous.notes, [slideId]: text }
      const document = { ...previous.document, revision: previous.document.revision + 1,
        updatedAt: new Date(this.clock()).toISOString() }
      const packed = await this.pack(identity, document, notes)
      const id = crypto.randomUUID(), timestamp = new Date(this.clock()).toISOString()
      const { scene: _scene, ...metadata } = document
      const version: StoredVersion = {
        key: key(identity, boardId, id), identity, localVersionId: id, boardId, name: document.name,
        capturedAt: timestamp, expiresAt: new Date(this.clock() + RETENTION_MS).toISOString(),
        generation: previous.generation, branchId: previous.branchId, branchSequence: previous.sequence + 1,
        parentLocalVersionId: previous.headVersionId, sourceBaseVersionId: document.cloudVersionId,
        contentDigest: packed.contentDigest, uploadStatus: 'pending', reason: 'notes', isCurrent: true,
        active: true, document: metadata, pageIds: packed.pageIds,
      }
      const applied = await this.transaction('readwrite', async (tx) => {
        const current: Current | undefined = await request(tx.objectStore('current').get(key(identity, boardId)))
        if (!current || current.headVersionId !== previous.headVersionId || current.document.revision !== previous.document.revision ||
          current.fence !== previous.fence || current.restoring) return false
        const entries: StoredOutbox[] = await request(tx.objectStore('outbox').index('identity').getAll(identity))
        for (const entry of entries.filter((item) => item.boardId === boardId && !item.headAcknowledged && item.changedFields.notes?.includes(slideId))) {
          const changedFields = { ...entry.changedFields, notes: entry.changedFields.notes!.filter((id) => id !== slideId) }
          const noHeadIntent = !changedFields.scene && !changedFields.name && !changedFields.notes.length
          if (noHeadIntent && entry.receipt) await request(tx.objectStore('outbox').delete(entry.key))
          else await request(tx.objectStore('outbox').put({ ...entry, changedFields,
            headAcknowledged: noHeadIntent || entry.headAcknowledged,
            publicationIntent: noHeadIntent ? 'history-only' : entry.publicationIntent }))
        }
        for (const payload of packed.payloads.values()) await request(tx.objectStore('payloads').put(payload))
        await request(tx.objectStore('versions').add(version))
        for (const entry of entries.filter((item) => item.boardId === boardId && item.publicationIntent === 'head')) {
          // Re-read after retiring this slide so those changes cannot be undone.
          const remaining = await request(tx.objectStore('outbox').get(entry.key))
          if (remaining) await request(tx.objectStore('outbox').put({ ...remaining, publicationIntent: 'history-only' }))
        }
        await request(tx.objectStore('outbox').add({ key: version.key, identity, boardId, localVersionId: id,
          mutationId: id, captureMutationId: id, headMutationId: crypto.randomUUID(),
          sourceBaseVersionId: document.cloudVersionId, generation: previous.generation, expectedFence: previous.fence,
          branchId: previous.branchId, publicationIntent: 'head', changedFields: {}, fieldBases: {}, retryState: 'pending' } satisfies StoredOutbox))
        await request(tx.objectStore('current').put({ ...current, notes, contentDigest: packed.contentDigest,
          document, headVersionId: id, sequence: version.branchSequence }))
        return true
      })
      if (applied) return
    }
  }

  /** Explicit keep-local choice rebases only this slide's pending compare-and-set. */
  async rebaseNoteIntent(boardId: string, slideId: string, remoteRevision: number): Promise<void> {
    if (!Number.isInteger(remoteRevision) || remoteRevision < 0) throw new Error('INVALID_NOTE_REVISION')
    const identity = this.identity()
    await this.transaction('readwrite', async (tx) => {
      const current: Current | undefined = await request(tx.objectStore('current').get(key(identity, boardId)))
      if (!current || current.restoring) throw new Error('BOARD_RESTORE_IN_PROGRESS')
      const entries: StoredOutbox[] = await request(tx.objectStore('outbox').index('identity').getAll(identity))
      for (const entry of entries.filter((item) => item.boardId === boardId && item.generation === current.generation &&
        !item.headAcknowledged && item.changedFields.notes?.includes(slideId))) {
        await request(tx.objectStore('outbox').put({ ...entry, fieldBases: { ...entry.fieldBases,
          notes: { ...(entry.fieldBases.notes as Record<string, unknown> | undefined), [slideId]: remoteRevision } },
          headMutationId: crypto.randomUUID(), expectedFence: current.fence, retryState: 'pending', lastError: undefined }))
      }
    })
  }

  /** Seed legacy/current content once, preserving its optimistic revision token. */
  async initialize(document: BoardDocument, notes: BoardNotes = {}): Promise<CommittedBoardContent> {
    const existing = await this.getCommittedContent(document.id)
    if (existing) return existing
    return this.save({ ...document, revision: document.revision - 1 }, {
      notes, reason: 'create', cloudBaseline: document.syncStatus === 'synced' && Boolean(document.cloudRevisionId),
    }, true)
  }

  async save(document: BoardDocument, options: HistorySaveOptions = {}, initializing = false): Promise<CommittedBoardContent> {
    const identity = this.identity()
    for (;;) {
      const previous = await this.readCurrent(identity, document.id)
      if (previous && initializing) {
        return this.transaction('readonly', async (tx) => {
          const current: Current = await request(tx.objectStore('current').get(key(identity, document.id)))
          const version: StoredVersion = await request(tx.objectStore('versions').get(key(identity, document.id, current.headVersionId)))
          return { document: current.document, notes: current.notes, version: this.publicVersion(version, current) }
        })
      }
      const cloudBaseline = options.cloudBaseline && !previous && document.syncStatus === 'synced' && Boolean(document.cloudRevisionId)
      if (previous?.restoring) throw new Error('BOARD_RESTORE_IN_PROGRESS')
      if (previous && !previous.document.active) throw new Error('Board was deleted.')
      if (document.cloudScenePending || previous?.document.cloudScenePending)
        throw new Error('Load the complete board before saving.')
      if (previous && (document.cloudGeneration ?? 1) !== (previous.document.cloudGeneration ?? 1))
        throw new Error('BOARD_GENERATION_CONFLICT')
      if (options.expectedFence !== undefined && options.expectedFence !== (previous?.fence ?? 0))
        throw new Error('BOARD_RESTORE_FENCE_CONFLICT')
      const stale = previous && document.revision < previous.document.revision
      const blocked = previous?.document.syncStatus === 'sync-blocked' || previous?.document.syncStatus === 'conflict'
      const saved: BoardDocument = {
        ...previous?.document, ...document,
        scene: stale ? mergeBoardScenes(document.scene, previous.document.scene) : document.scene,
        name: stale && !options.changedFields?.name ? previous.document.name : document.name,
        cloudRevisionId: previous?.document.cloudRevisionId ?? document.cloudRevisionId,
        cloudGeneration: previous?.document.cloudGeneration ?? document.cloudGeneration,
        cloudVersionId: previous?.document.cloudVersionId ?? document.cloudVersionId,
        cloudRestoreFence: previous?.document.cloudRestoreFence ?? document.cloudRestoreFence,
        cloudNameRevision: previous?.document.cloudNameRevision ?? document.cloudNameRevision,
        revision: Math.max(previous?.document.revision ?? -1, document.revision) + 1,
        baseRevision: previous?.document.baseRevision ?? document.baseRevision,
        syncStatus: blocked ? previous.document.syncStatus : cloudBaseline ? 'synced' : 'local-only',
        updatedAt: new Date(this.clock()).toISOString(),
        syncAttempts: blocked ? previous.document.syncAttempts : 0,
        nextSyncAt: null,
        lastSyncError: blocked ? previous.document.lastSyncError : null,
      }
      let notes = options.notes ?? previous?.notes ?? {}
      if (options.notes && options.changedFields?.notes) {
        notes = { ...previous?.notes }
        for (const slideId of options.changedFields.notes) {
          if (Object.hasOwn(options.notes, slideId)) notes[slideId] = options.notes[slideId]
          else delete notes[slideId]
        }
      }
      const packed = await this.pack(identity, saved, notes)
      const id = crypto.randomUUID()
      const timestamp = new Date(this.clock()).toISOString()
      const { scene: _scene, ...metadata } = saved
      const version: StoredVersion = {
        key: key(identity, saved.id, id), identity, localVersionId: id, boardId: saved.id,
        name: saved.name, capturedAt: timestamp, expiresAt: new Date(this.clock() + RETENTION_MS).toISOString(),
        generation: previous?.generation ?? saved.cloudGeneration ?? 1,
        branchId: previous?.branchId ?? crypto.randomUUID(), branchSequence: (previous?.sequence ?? 0) + 1,
        parentLocalVersionId: previous?.headVersionId,
        sourceBaseVersionId: options.sourceBaseVersionId ?? saved.cloudVersionId,
        contentDigest: packed.contentDigest, uploadStatus: cloudBaseline ? 'published' : 'pending', reason: options.reason ?? 'save',
        isCurrent: true, active: true, document: metadata, pageIds: packed.pageIds,
      }
      const committed = await this.transaction('readwrite', async (tx): Promise<CommittedBoardContent | undefined> => {
        const actual: Current | undefined = await request(tx.objectStore('current').get(key(identity, document.id)))
        if (actual?.headVersionId !== previous?.headVersionId || actual?.document.revision !== previous?.document.revision ||
          actual?.fence !== previous?.fence || actual?.restoring !== previous?.restoring) return undefined
        if (actual && actual.contentDigest === packed.contentDigest) {
          const existing: StoredVersion = await request(tx.objectStore('versions').get(key(identity, document.id, actual.headVersionId)))
          return { document: actual.document, notes: actual.notes, version: this.publicVersion(existing, actual) }
        }
        for (const payload of packed.payloads.values()) await request(tx.objectStore('payloads').put(payload))
        await request(tx.objectStore('versions').add(version))
        const entries: StoredOutbox[] = await request(tx.objectStore('outbox').index('identity').getAll(identity))
        for (const entry of entries.filter((entry) => entry.boardId === saved.id && entry.publicationIntent === 'head'))
          await request(tx.objectStore('outbox').put({ ...entry, publicationIntent: 'history-only' }))
        const outbox: StoredOutbox = {
          key: version.key, identity, boardId: saved.id, localVersionId: id, mutationId: id,
          captureMutationId: id, headMutationId: crypto.randomUUID(),
          sourceBaseVersionId: options.sourceBaseVersionId ?? saved.cloudVersionId, generation: version.generation,
          expectedFence: previous?.fence ?? saved.cloudRestoreFence ?? 0, branchId: version.branchId, publicationIntent: 'head',
          changedFields: options.changedFields ?? {
            scene: !previous || stable(previous.document.scene) !== stable(saved.scene),
            name: !previous || previous.document.name !== saved.name,
            notes: [...new Set([...Object.keys(previous?.notes ?? {}), ...Object.keys(notes)])]
              .filter((slideId) => previous?.notes[slideId] !== notes[slideId]),
          },
          fieldBases: options.fieldBases ?? { nameRevision: previous?.document.cloudNameRevision ?? document.cloudNameRevision },
          retryState: 'pending',
        }
        if (!cloudBaseline) await request(tx.objectStore('outbox').add(outbox))
        const current: Current = {
          key: key(identity, saved.id), identity, boardId: saved.id, document: saved, notes,
          headVersionId: id, branchId: version.branchId, generation: version.generation,
          fence: previous?.fence ?? saved.cloudRestoreFence ?? 0, sequence: version.branchSequence, contentDigest: packed.contentDigest,
          restoring: false,
        }
        await request(tx.objectStore('current').put(current))
        return { document: saved, notes, version: this.publicVersion(version, current) }
      })
      if (committed) return committed
    }
  }

  async saveNotes(boardId: string, notes: BoardNotes, options: Omit<HistorySaveOptions, 'notes'> = {}) {
    const current = await this.getCommittedContent(boardId)
    if (!current) throw new Error('BOARD_HISTORY_NOT_INITIALIZED')
    return this.save(current.document, {
      ...options, notes, reason: 'notes',
      changedFields: options.changedFields ?? { notes: Object.keys(notes) },
    })
  }

  async list(boardId: string): Promise<LocalBoardVersion[]> {
    const identity = this.identity()
    return this.transaction('readonly', async (tx) => {
      const current: Current | undefined = await request(tx.objectStore('current').get(key(identity, boardId)))
      const versions: StoredVersion[] = await request(tx.objectStore('versions').index('identity').getAll(identity))
      return versions.filter((version) => version.boardId === boardId && version.active &&
        (version.localVersionId === current?.headVersionId || Date.parse(version.expiresAt) > this.clock()))
        .map((version) => this.publicVersion(version, current))
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || b.branchSequence - a.branchSequence)
    })
  }

  async get(boardId: string, versionId: string): Promise<CommittedBoardContent | null> {
    const identity = this.identity()
    const checkedPayloads = new Map<string, string>()
    const read = await this.transaction('readonly', async (tx) => {
      const current: Current | undefined = await request(tx.objectStore('current').get(key(identity, boardId)))
      const version: StoredVersion | undefined = await request(tx.objectStore('versions').get(key(identity, boardId, versionId)))
      if (!version || !version.active || (versionId !== current?.headVersionId && Date.parse(version.expiresAt) <= this.clock()))
        return null
      const scene: BoardScene = { elements: [], appState: {} }
      let notes: BoardNotes = {}
      for (const pageId of version.pageIds) {
        const page: Payload | undefined = await request(tx.objectStore('payloads').get(key(identity, pageId)))
        if (!page) throw new Error('BOARD_HISTORY_PAYLOAD_MISSING')
        checkedPayloads.set(pageId, page.text)
        const records = JSON.parse(page.text) as string[][]
        for (const ids of records) {
          const blocks = await Promise.all(ids.map((id) => request<Payload | undefined>(tx.objectStore('payloads').get(key(identity, id)))))
          if (blocks.some((block) => !block)) throw new Error('BOARD_HISTORY_PAYLOAD_MISSING')
          ids.forEach((id, slot) => checkedPayloads.set(id, blocks[slot]!.text))
          const record = JSON.parse(blocks.map((block) => block!.text).join('')) as RecordPayload
          if (record.kind === 'header') Object.assign(scene, record.value)
          if (record.kind === 'element') scene.elements.push(record.value as Record<string, unknown>)
          if (record.kind === 'file') (scene.files ??= {})[record.id!] = record.value as NonNullable<BoardScene['files']>[string]
          if (record.kind === 'notes') {
            if (record.id) notes[record.id] = record.value as string
            else notes = record.value as BoardNotes
          }
        }
      }
      return { document: { ...version.document, scene }, notes, version: this.publicVersion(version, current) }
    })
    for (const [id, text] of checkedPayloads) if (await digest(text) !== id)
      throw new Error('BOARD_HISTORY_PAYLOAD_CORRUPT')
    if (read && await digest(stable({ name: read.document.name, scene: read.document.scene, notes: read.notes })) !== read.version.contentDigest)
      throw new Error('BOARD_HISTORY_CONTENT_CORRUPT')
    return read
  }

  async listOutbox(boardId?: string): Promise<HistoryOutboxEntry[]> {
    const identity = this.identity()
    return this.transaction('readonly', async (tx) => {
      const entries: StoredOutbox[] = await request(tx.objectStore('outbox').index('identity').getAll(identity))
      return entries.filter((entry) => !boardId || entry.boardId === boardId).map(({ key: _key, ...entry }) => entry)
    })
  }

  async acknowledge(boardId: string, versionId: string, receipt: HistoryReceipt): Promise<void> {
    const identity = this.identity()
    await this.transaction('readwrite', async (tx) => {
      const version: StoredVersion | undefined = await request(tx.objectStore('versions').get(key(identity, boardId, versionId)))
      if (!version) return
      if (version.receipt && stable(version.receipt) !== stable(receipt)) throw new Error('HISTORY_RECEIPT_CONFLICT')
      const entry: StoredOutbox | undefined = await request(tx.objectStore('outbox').get(version.key))
      await request(tx.objectStore('versions').put({ ...version, receipt, uploadStatus: 'published',
        expiresAt: receipt.expiresAt, importPublication: entry?.importPublication ?? version.importPublication }))
      if (entry && !entry.headAcknowledged)
        await request(tx.objectStore('outbox').put({ ...entry, receipt }))
      else await request(tx.objectStore('outbox').delete(version.key))
    })
  }

  async acknowledgeHead(boardId: string, versionId: string): Promise<void> {
    const identity = this.identity()
    await this.transaction('readwrite', async (tx) => {
      const entry: StoredOutbox | undefined = await request(tx.objectStore('outbox').get(key(identity, boardId, versionId)))
      if (!entry) return
      if (entry.receipt) await request(tx.objectStore('outbox').delete(entry.key))
      else await request(tx.objectStore('outbox').put({ ...entry, publicationIntent: 'history-only', headAcknowledged: true }))
    })
  }

  /** Legacy servers can apply current fields but cannot acknowledge a history capture. */
  async acknowledgeLegacyFields(boardId: string, versionId: string, fields: {
    scene?: boolean; name?: boolean; notes?: string[]
  }): Promise<void> {
    const identity = this.identity()
    await this.transaction('readwrite', async (tx) => {
      const entry: StoredOutbox | undefined = await request(tx.objectStore('outbox').get(key(identity, boardId, versionId)))
      if (!entry) return
      const changedFields = { ...entry.changedFields }
      if (fields.scene) delete changedFields.scene
      if (fields.name) delete changedFields.name
      if (fields.notes) changedFields.notes = changedFields.notes?.filter((id) => !fields.notes!.includes(id))
      const complete = !changedFields.scene && !changedFields.name && !changedFields.notes?.length
      await request(tx.objectStore('outbox').put({ ...entry, changedFields,
        ...(complete ? { headAcknowledged: true, publicationIntent: 'history-only' as const } : {}) }))
    })
  }

  /** Explicitly bind device lineage at claim; local generation numbers are not cloud fences. */
  async bindCloudLineage(boardId: string, options: {
    generation: number; restoreFence: number; currentVersionId: string; cloudRevisionId?: string
  }): Promise<void> {
    return this.bindLineage(boardId, options, false)
  }

  private async bindLineage(boardId: string, options: {
    generation: number; restoreFence: number; currentVersionId: string; cloudRevisionId?: string
  }, validateKnownCloud: boolean): Promise<void> {
    const identity = this.identity()
    await this.transaction('readwrite', async (tx) => {
      const current: Current | undefined = await request(tx.objectStore('current').get(key(identity, boardId)))
      if (!current) throw new Error('BOARD_HISTORY_NOT_INITIALIZED')
      if (validateKnownCloud && current.document.cloudGeneration !== undefined) {
        if (current.generation !== options.generation || current.document.cloudGeneration !== options.generation)
          throw new Error('BOARD_GENERATION_CONFLICT')
        if (current.fence !== options.restoreFence) throw new Error('BOARD_RESTORE_FENCE_CONFLICT')
      }
      if (current.document.cloudVersionId) {
        if (current.generation === options.generation && current.document.cloudVersionId === options.currentVersionId) return
        throw new Error('BOARD_HISTORY_ALREADY_CLOUD_BOUND')
      }
      const versions: StoredVersion[] = await request(tx.objectStore('versions').index('identity').getAll(identity))
      for (const version of versions.filter((item) => item.boardId === boardId && item.active))
        await request(tx.objectStore('versions').put({ ...version, localGeneration: version.generation, generation: options.generation }))
      const entries: StoredOutbox[] = await request(tx.objectStore('outbox').index('identity').getAll(identity))
      if (validateKnownCloud && current.document.cloudGeneration !== undefined) {
        if (entries.some((entry) => entry.boardId === boardId && entry.generation !== options.generation))
          throw new Error('BOARD_GENERATION_CONFLICT')
        if (entries.some((entry) => entry.boardId === boardId && entry.expectedFence !== options.restoreFence))
          throw new Error('BOARD_RESTORE_FENCE_CONFLICT')
      }
      for (const entry of entries.filter((item) => item.boardId === boardId))
        await request(tx.objectStore('outbox').put({ ...entry, generation: options.generation,
          expectedFence: options.restoreFence, sourceBaseVersionId: entry.sourceBaseVersionId ?? options.currentVersionId }))
      await request(tx.objectStore('current').put({ ...current, generation: options.generation, fence: options.restoreFence,
        document: { ...current.document, cloudGeneration: options.generation, cloudRestoreFence: options.restoreFence,
          cloudVersionId: options.currentVersionId, cloudRevisionId: options.cloudRevisionId } }))
    })
  }

  /** Repair pre-history captures after metadata hydration raced initial lineage binding. */
  async repairLegacyCloudLineage(boardId: string, options: {
    generation: number; restoreFence: number; currentVersionId: string; cloudRevisionId?: string
  }): Promise<void> {
    const identity = this.identity()
    const previous = await this.readCurrent(identity, boardId)
    if (!previous) throw new Error('BOARD_HISTORY_NOT_INITIALIZED')
    if (!previous.document.cloudVersionId) {
      if (previous.document.cloudGeneration !== undefined &&
        (previous.document.cloudGeneration !== options.generation || previous.generation !== options.generation))
        throw new Error('BOARD_GENERATION_CONFLICT')
      if (previous.document.cloudGeneration !== undefined && previous.fence !== options.restoreFence)
        throw new Error('BOARD_RESTORE_FENCE_CONFLICT')
      return this.bindLineage(boardId, options, true)
    }
    await this.transaction('readwrite', async (tx) => {
      const current: Current | undefined = await request(tx.objectStore('current').get(key(identity, boardId)))
      if (!current || current.restoring) throw new Error('BOARD_RESTORE_IN_PROGRESS')
      if (current.generation !== options.generation || current.document.cloudGeneration !== options.generation)
        throw new Error('BOARD_GENERATION_CONFLICT')
      if (current.fence !== options.restoreFence) throw new Error('BOARD_RESTORE_FENCE_CONFLICT')
      const entries: StoredOutbox[] = await request(tx.objectStore('outbox').index('identity').getAll(identity))
      for (const entry of entries.filter((item) => item.boardId === boardId && !item.sourceBaseVersionId &&
        !item.receipt && !item.importPublication && item.generation === options.generation && item.expectedFence === options.restoreFence)) {
        const version: StoredVersion | undefined = await request(tx.objectStore('versions').get(entry.key))
        if (!version?.active || version.receipt || version.importPublication || version.sourceBaseVersionId ||
          version.document.cloudVersionId || version.generation !== options.generation) continue
        await request(tx.objectStore('outbox').put({ ...entry, sourceBaseVersionId: options.currentVersionId,
          retryState: 'pending', lastError: undefined }))
        await request(tx.objectStore('versions').put({ ...version, sourceBaseVersionId: options.currentVersionId }))
      }
    })
  }

  /** Caller resolves the original ambiguous receipt before authorizing a new attempt. */
  async reauthorizeOutbox(boardId: string, versionId: string, options: {
    expectedFence: number; resolvedHeadMutationId: string
  }): Promise<void> {
    const identity = this.identity()
    await this.transaction('readwrite', async (tx) => {
      const current: Current | undefined = await request(tx.objectStore('current').get(key(identity, boardId)))
      const entry: StoredOutbox | undefined = await request(tx.objectStore('outbox').get(key(identity, boardId, versionId)))
      if (!entry || !current || current.restoring || current.fence !== options.expectedFence ||
        current.generation !== entry.generation || entry.headMutationId !== options.resolvedHeadMutationId)
        throw new Error('HISTORY_REAUTHORIZATION_CONFLICT')
      await request(tx.objectStore('outbox').put({ ...entry, expectedFence: options.expectedFence,
        headMutationId: crypto.randomUUID(), importPublication: entry.receipt || !entry.importPublication
          ? entry.importPublication : { ...entry.importPublication, commitId: crypto.randomUUID() } }))
    })
  }

  async prepareImport(boardId: string, versionId: string, publication: NonNullable<HistoryOutboxEntry['importPublication']>): Promise<void> {
    const identity = this.identity()
    await this.transaction('readwrite', async (tx) => {
      const entry: StoredOutbox | undefined = await request(tx.objectStore('outbox').get(key(identity, boardId, versionId)))
      if (!entry) throw new Error('HISTORY_OUTBOX_NOT_FOUND')
      if (entry.importPublication && stable(entry.importPublication) !== stable(publication))
        throw new Error('HISTORY_IMPORT_IDENTITY_CONFLICT')
      await request(tx.objectStore('outbox').put({ ...entry, importPublication: publication }))
    })
  }

  async markOutboxBlocked(boardId: string, versionId: string, error: string): Promise<void> {
    const identity = this.identity()
    await this.transaction('readwrite', async (tx) => {
      const entry: StoredOutbox | undefined = await request(tx.objectStore('outbox').get(key(identity, boardId, versionId)))
      if (entry) await request(tx.objectStore('outbox').put({ ...entry, retryState: 'blocked', lastError: error }))
    })
  }

  async getImportPublication(boardId: string, versionId: string): Promise<HistoryOutboxEntry['importPublication']> {
    const identity = this.identity()
    return this.transaction('readonly', async (tx) => {
      const version: StoredVersion | undefined = await request(tx.objectStore('versions').get(key(identity, boardId, versionId)))
      return version?.importPublication
    })
  }

  /** Used only for sync metadata projection; it never creates a content version. */
  async reconcileDocument(document: BoardDocument, options: { allowLegacyGenerationAdvance?: boolean } = {}): Promise<void> {
    const identity = this.identity()
    const previous = await this.readCurrent(identity, document.id)
    if (!previous) return
    const contentDigest = await digest(stable({ name: document.name, scene: document.scene, notes: previous.notes }))
    await this.transaction('readwrite', async (tx) => {
      const current: Current | undefined = await request(tx.objectStore('current').get(key(identity, document.id)))
      if (!current || current.headVersionId !== previous.headVersionId || current.document.revision > document.revision) return
      const advanced = (document.cloudGeneration ?? 1) !== (current.document.cloudGeneration ?? 1)
      if (advanced) {
        if (!options.allowLegacyGenerationAdvance || current.document.cloudVersionId || document.cloudVersionId ||
          (document.cloudGeneration ?? 1) < (current.document.cloudGeneration ?? 1)) throw new Error('BOARD_GENERATION_CONFLICT')
        const entries: StoredOutbox[] = await request(tx.objectStore('outbox').index('identity').getAll(identity))
        if (entries.some((entry) => entry.boardId === document.id && !entry.headAcknowledged)) throw new Error('BOARD_GENERATION_CONFLICT')
      }
      await request(tx.objectStore('current').put({ ...current, document, contentDigest,
        ...(advanced ? { generation: document.cloudGeneration ?? 1 } : {}) }))
    })
  }

  /** Claim moves only anonymous history; another signed-in account is never a source. */
  async claimLocalBoards(boardIds: string[], ownerId: string): Promise<void> {
    if (!ownerId || ownerId === 'local-user') return
    await this.transaction('readwrite', async (tx) => {
      const boardSet = new Set(boardIds)
      const versions: StoredVersion[] = await request(tx.objectStore('versions').index('identity').getAll('local-user'))
      const payloads: Payload[] = await request(tx.objectStore('payloads').index('identity').getAll('local-user'))
      const moving = versions.filter((item) => boardSet.has(item.boardId))
      const reachable = new Set<string>()
      for (const version of moving) for (const pageId of version.pageIds) {
        reachable.add(pageId)
        const page = payloads.find((payload) => payload.key === key('local-user', pageId))
        if (!page) throw new Error('BOARD_HISTORY_PAYLOAD_MISSING')
        for (const record of JSON.parse(page.text) as string[][]) for (const id of record) reachable.add(id)
      }
      for (const payload of payloads.filter((payload) => reachable.has(JSON.parse(payload.key)[1]))) {
        const id = JSON.parse(payload.key)[1] as string
        await request(tx.objectStore('payloads').put({ ...payload, identity: ownerId, key: key(ownerId, id) }))
      }
      for (const version of moving) {
        await request(tx.objectStore('versions').put({ ...version, identity: ownerId, key: key(ownerId, version.boardId, version.localVersionId) }))
        await request(tx.objectStore('versions').delete(version.key))
      }
      const entries: StoredOutbox[] = await request(tx.objectStore('outbox').index('identity').getAll('local-user'))
      for (const entry of entries.filter((item) => boardSet.has(item.boardId))) {
        await request(tx.objectStore('outbox').put({ ...entry, identity: ownerId, key: key(ownerId, entry.boardId, entry.localVersionId) }))
        await request(tx.objectStore('outbox').delete(entry.key))
      }
      const currents: Current[] = await request(tx.objectStore('current').index('identity').getAll('local-user'))
      for (const current of currents.filter((item) => boardSet.has(item.boardId))) {
        const target: Current | undefined = await request(tx.objectStore('current').get(key(ownerId, current.boardId)))
        if (target) throw new Error('HISTORY_CLAIM_CONFLICT')
        await request(tx.objectStore('current').put({ ...current, identity: ownerId, key: key(ownerId, current.boardId) }))
        await request(tx.objectStore('current').delete(current.key))
      }
    })
  }

  async setRestoreFence(boardId: string, fence: number, restoring: boolean): Promise<void> {
    const identity = this.identity()
    await this.transaction('readwrite', async (tx) => {
      const current: Current | undefined = await request(tx.objectStore('current').get(key(identity, boardId)))
      if (!current || fence < current.fence) return
      await request(tx.objectStore('current').put({ ...current, fence, restoring }))
    })
  }

  async restoreLocal(boardId: string, versionId: string): Promise<CommittedBoardContent> {
    const identity = this.identity()
    const target = await this.get(boardId, versionId)
    const previous = await this.readCurrent(identity, boardId)
    if (!target || !previous || previous.document.cloudRevisionId || previous.document.cloudVersionId) throw new Error('LOCAL_RESTORE_UNAVAILABLE')
    if (!previous.document.active) throw new Error('Board was deleted.')
    if (versionId === previous.headVersionId) throw new Error('BOARD_VERSION_IS_CURRENT')
    return this.replace({ ...previous.document, name: target.document.name, scene: target.document.scene,
      syncStatus: 'local-only', updatedAt: new Date(this.clock()).toISOString(),
    }, target.notes, previous, {
      parentVersionId: versionId, retainAncestors: true, fence: previous.fence + 1,
    })
  }

  async applyCloudRestore(document: BoardDocument, options: {
    notes: BoardNotes; restoreFence: number; currentVersionId?: string
  }): Promise<CommittedBoardContent> {
    const previous = await this.readCurrent(this.identity(), document.id)
    if (previous && (document.cloudGeneration ?? 1) < (previous.document.cloudGeneration ?? 1))
      throw new Error('BOARD_GENERATION_CONFLICT')
    return this.replace({ ...document, cloudVersionId: options.currentVersionId ?? document.cloudVersionId,
      cloudRestoreFence: options.restoreFence, updatedAt: new Date(this.clock()).toISOString() }, options.notes, previous, {
      retainAncestors: false, fence: options.restoreFence, cloudVersionId: options.currentVersionId,
    })
  }

  private async replace(document: BoardDocument, notes: BoardNotes, previous: Current | undefined, options: {
    parentVersionId?: string; retainAncestors: boolean; fence: number; cloudVersionId?: string
  }): Promise<CommittedBoardContent> {
    const identity = this.identity()
    const packed = await this.pack(identity, document, notes)
    const id = crypto.randomUUID()
    const timestamp = new Date(this.clock()).toISOString()
    const { scene: _scene, ...metadata } = document
    const restored = { ...metadata, revision: (previous?.document.revision ?? document.revision) + 1 }
    const version: StoredVersion = {
      key: key(identity, document.id, id), identity, localVersionId: id, boardId: document.id,
      name: document.name, capturedAt: timestamp, expiresAt: new Date(this.clock() + RETENTION_MS).toISOString(),
      generation: options.retainAncestors ? (previous?.generation ?? 1) + 1 : document.cloudGeneration ?? 1,
      branchId: crypto.randomUUID(), branchSequence: 1, parentLocalVersionId: options.parentVersionId,
      contentDigest: packed.contentDigest, uploadStatus: options.retainAncestors ? 'pending' : 'published',
      reason: 'restore', isCurrent: true, active: true, document: restored, pageIds: packed.pageIds,
    }
    return this.transaction('readwrite', async (tx) => {
      const actual: Current | undefined = await request(tx.objectStore('current').get(key(identity, document.id)))
      if (actual?.headVersionId !== previous?.headVersionId || actual?.fence !== previous?.fence)
        throw new Error('BOARD_RESTORE_CONFLICT')
      const versions: StoredVersion[] = await request(tx.objectStore('versions').index('identity').getAll(identity))
      if (options.retainAncestors) {
        const target = versions.find((item) => item.boardId === document.id && item.localVersionId === options.parentVersionId)
        if (!target?.active || Date.parse(target.expiresAt) <= this.clock()) throw new Error('LOCAL_RESTORE_UNAVAILABLE')
      }
      const keep = new Set<string>()
      if (options.retainAncestors) {
        let ancestor = options.parentVersionId
        while (ancestor) {
          keep.add(ancestor)
          ancestor = versions.find((item) => item.localVersionId === ancestor && item.boardId === document.id)?.parentLocalVersionId
        }
      }
      for (const item of versions.filter((item) => item.boardId === document.id)) {
        if (!options.retainAncestors && item.uploadStatus === 'pending') {
          await request(tx.objectStore('versions').delete(item.key))
        } else await request(tx.objectStore('versions').put({ ...item, active: options.retainAncestors && keep.has(item.localVersionId) }))
      }
      const outbox: StoredOutbox[] = await request(tx.objectStore('outbox').index('identity').getAll(identity))
      for (const item of outbox.filter((item) => item.boardId === document.id && (!options.retainAncestors || !keep.has(item.localVersionId))))
        await request(tx.objectStore('outbox').delete(item.key))
      for (const payload of packed.payloads.values()) await request(tx.objectStore('payloads').put(payload))
      await request(tx.objectStore('versions').add(version))
      const current: Current = {
        key: key(identity, document.id), identity, boardId: document.id,
        document: { ...restored, scene: document.scene }, notes, headVersionId: id,
        generation: version.generation, branchId: version.branchId, sequence: 1, fence: options.fence,
        contentDigest: packed.contentDigest, restoring: false,
      }
      await request(tx.objectStore('current').put(current))
      if (options.retainAncestors) {
        const entry: StoredOutbox = {
          key: version.key, identity, boardId: document.id, localVersionId: id, mutationId: id,
          captureMutationId: id, headMutationId: crypto.randomUUID(), generation: version.generation,
          expectedFence: options.fence, branchId: version.branchId, publicationIntent: 'head',
          changedFields: { scene: true, name: true, notes: Object.keys(notes) }, fieldBases: {}, retryState: 'pending',
        }
        await request(tx.objectStore('outbox').add(entry))
      }
      return { document: current.document, notes, version: this.publicVersion(version, current) }
    })
  }

  /** Expired ancestry stubs retain no payload; current content is always pinned. */
  async prune(): Promise<{ versions: number; payloads: number }> {
    const identity = this.identity()
    return this.transaction('readwrite', async (tx) => {
      const current: Current[] = await request(tx.objectStore('current').index('identity').getAll(identity))
      const heads = new Set(current.map((item) => item.headVersionId))
      const versions: StoredVersion[] = await request(tx.objectStore('versions').index('identity').getAll(identity))
      const reachable = new Set<string>()
      let retired = 0
      for (const version of versions) {
        if (!heads.has(version.localVersionId) && Date.parse(version.expiresAt) <= this.clock()) {
          if (version.pageIds.length) retired++
          await request(tx.objectStore('versions').put({ ...version, pageIds: [], active: false }))
          await request(tx.objectStore('outbox').delete(version.key))
          continue
        }
        for (const pageId of version.pageIds) {
          reachable.add(pageId)
          const page: Payload | undefined = await request(tx.objectStore('payloads').get(key(identity, pageId)))
          if (!page) throw new Error('BOARD_HISTORY_PAYLOAD_MISSING')
          for (const record of JSON.parse(page.text) as string[][]) for (const id of record) reachable.add(id)
        }
      }
      const payloads: Payload[] = await request(tx.objectStore('payloads').index('identity').getAll(identity))
      let deleted = 0
      for (const payload of payloads) if (!reachable.has(JSON.parse(payload.key)[1])) {
        await request(tx.objectStore('payloads').delete(payload.key)); deleted++
      }
      return { versions: retired, payloads: deleted }
    })
  }

  async close(): Promise<void> {
    if (this.connection) (await this.connection).close()
    this.connection = undefined
  }
}

let historyIdentity = 'local-user'
export function setBoardHistoryIdentity(identity: string | null): void { historyIdentity = identity ?? 'local-user' }
export const boardHistoryStore = new BoardHistoryStore({ identity: () => historyIdentity })
