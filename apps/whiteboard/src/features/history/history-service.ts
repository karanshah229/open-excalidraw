import type { BoardScene } from '@agentic-whiteboard/storage'
import type { BoardHistoryEntry, BoardHistoryManifest, BoardRestoreRequest, BoardRestoreResult } from '../../../../../functions/src/board-history-contract'
import { assembleScene, digestString, manifestDigest, type ChunkReference, type PackedChunk } from '../../../../../functions/src/scene-codec'
import { projectCall } from '../sharing/project-service'
import { getFirebaseAuth } from '../../lib/firebase'
import { ensureAuthenticatedUser } from '../collaboration/anonymous-user'
import type { HistoryEntry, HistorySource, HistorySnapshot } from './history-model'

export const toHistoryEntry = (entry: BoardHistoryEntry): HistoryEntry => ({
  id: entry.versionId, name: entry.boardName, createdAt: entry.serverCreatedAt,
  capturedAt: entry.capturedAt, current: entry.current, origin: entry.origin, expiresAt: entry.expiresAt,
})

/** Gateway lease fixes one complete manifest; bytes are verified before rendering or applying it. */
export class LegacySceneHistoryError extends Error {}

export async function readHistorySnapshot(boardId: string, versionId?: string, hydrateAssets = true, includeNotes = true, signal?: AbortSignal, operation: 'manifest' | 'current-scene' = 'manifest'): Promise<HistorySnapshot & { generation: number; revisionId: string; chunks: PackedChunk[]; readContextId: string; noteRevisions: Record<string, number>; notesPageCount: number; historyProtocolVersion?: number; restoreFence?: number; currentVersionId?: string | null; nameRevision?: number }> {
  const canceled = () => { if (signal?.aborted) throw new DOMException('Version preview canceled', 'AbortError') }
  // Public-link readers need their anonymous session before the authenticated
  // history gateway loads the board; collaboration starts only after this load.
  const auth = getFirebaseAuth()
  if (auth) {
    await auth.authStateReady()
    canceled()
    if (!auth.currentUser && !await ensureAuthenticatedUser(auth)) throw new Error('Sign in to access board history.')
  }
  const request = async <T>(operation: string, extra: Record<string, unknown> = {}) => { canceled(); const result = await projectCall<T>('boardHistory', { boardId, operation, ...extra }); canceled(); return result }
  const manifest = await request<BoardHistoryManifest & { references?: ChunkReference[]; chunks?: PackedChunk[]; legacy?: boolean; historyProtocolVersion?: number; restoreFence?: number; currentVersionId?: string | null; nameRevision?: number }>(
    operation, versionId ? { versionId } : {},
  )
  if (manifest.legacy) throw new LegacySceneHistoryError('This board uses the legacy scene protocol.')
  if (!Number.isInteger(manifest.pageCount) || manifest.pageCount < 1 || manifest.pageCount > 6 ||
      !Number.isInteger(manifest.chunkCount) || manifest.chunkCount < 1 || manifest.chunkCount > 512 ||
      !Number.isInteger(manifest.notesPageCount) || manifest.notesPageCount < 0 || manifest.notesPageCount > 100)
    throw new Error('Invalid board version manifest.')
  const [pages, notePages] = await Promise.all([
    manifest.references
      ? Promise.resolve([] as { references: ChunkReference[] }[])
      : Promise.all(Array.from({ length: manifest.pageCount }, (_, page) => request<{ references: ChunkReference[] }>('pages', { contextId: manifest.contextId, page }))),
    Promise.all(Array.from({ length: includeNotes ? manifest.notesPageCount : 0 }, (_, page) => request<{ notes: Record<string, { text: string; revision: number }> }>('notes', { contextId: manifest.contextId, page }))),
  ])
  const references = manifest.references ?? pages.flatMap((page) => page.references)
  if (references.length !== manifest.chunkCount || new Set(references.map((reference) => reference.chunkId)).size !== references.length ||
      await manifestDigest(references, manifest.generation) !== manifest.candidateDigest)
    throw new Error('Board version manifest integrity check failed.')
  // Keep the same progress contract as the legacy chunk loader. History v1
  // is the authoritative loader for these boards, so omitting these events
  // leaves cold multi-chunk hydration without observable progress.
  let completed = 0
  const reportProgress = () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(`board-load:${boardId}`, {
        detail: { completed, total: references.length, revisionId: manifest.revisionId },
      }))
    }
  }
  reportProgress()
  const chunks: PackedChunk[] = []
  const initialChunks = manifest.chunks ?? []
  const initialById = new Map(initialChunks.map((chunk) => [chunk.chunkId, chunk]))
  for (const reference of references.slice(0, initialChunks.length)) {
    const chunk = initialById.get(reference.chunkId)
    if (!chunk || chunk.digest !== reference.digest || await digestString(chunk.payload) !== reference.digest)
      throw new Error('Board version chunk integrity check failed.')
    chunks.push(chunk)
  }
  completed = chunks.length
  reportProgress()
  // Small bounded batches satisfy the callable response budget; no unbounded parallel reads.
  for (let offset = chunks.length; offset < references.length; offset += 6) {
    const batch = references.slice(offset, offset + 6)
    const response = await request<{ chunks: PackedChunk[] }>('chunks', { contextId: manifest.contextId, chunkIds: batch.map((reference) => reference.chunkId) })
    if (response.chunks.length !== batch.length) throw new Error('Board version is incomplete.')
    const byId = new Map(response.chunks.map((chunk) => [chunk.chunkId, chunk]))
    for (const reference of batch) {
      const chunk = byId.get(reference.chunkId)
      if (!chunk || chunk.digest !== reference.digest || await digestString(chunk.payload) !== reference.digest)
        throw new Error('Board version chunk integrity check failed.')
      chunks.push(chunk)
    }
    completed += batch.length
    reportProgress()
  }
  const scene = await assembleScene(chunks) as BoardScene
  const files = Object.entries(scene.files ?? {})
  const hydrated: NonNullable<BoardScene['files']> = {}
  for (let offset = 0; offset < files.length; offset += 4) {
    canceled()
    await Promise.all(files.slice(offset, offset + 4).map(async ([id, file]) => {
      if (hydrateAssets && !file.dataURL && file.storagePath) {
        const response = await projectCall<{ dataURL?: string }>('boardAsset', { operation: 'read', storagePath: file.storagePath, contextId: manifest.contextId })
        if (!response.dataURL) throw new Error(`Image ${id} is unavailable in this version.`)
        hydrated[id] = { ...file, dataURL: response.dataURL }
      } else hydrated[id] = file
    }))
  }
  return {
    entry: { id: manifest.versionId ?? manifest.revisionId, name: manifest.boardName, createdAt: '', current: !versionId, origin: 'cloud' },
    scene: { ...scene, files: hydrated },
    noteRevisions: Object.fromEntries(notePages.flatMap((page) => Object.entries(page.notes).map(([id, note]) => [id, note.revision]))),
    notes: Object.fromEntries(notePages.flatMap((page) => Object.entries(page.notes).map(([id, note]) => [id, note.text]))),
    generation: manifest.generation, revisionId: manifest.revisionId, chunks, readContextId: manifest.contextId,
    notesPageCount: manifest.notesPageCount,
    historyProtocolVersion: manifest.historyProtocolVersion,
    restoreFence: manifest.restoreFence,
    currentVersionId: manifest.currentVersionId,
    nameRevision: manifest.nameRevision,
  }
}

/** Speaker notes are deliberately fetched after the first canvas paint. */
export async function readHistoryNotes(boardId: string, contextId: string, notesPageCount: number) {
  if (!notesPageCount) return { notes: {} as Record<string, string>, noteRevisions: {} as Record<string, number> }
  if (!Number.isInteger(notesPageCount) || notesPageCount < 0 || notesPageCount > 100) throw new Error('Invalid speaker-note manifest.')
  const pages = await Promise.all(Array.from({ length: notesPageCount }, (_, page) =>
    projectCall<{ notes: Record<string, { text: string; revision: number }> }>('boardHistory', { boardId, operation: 'notes', contextId, page }),
  ))
  return {
    notes: Object.fromEntries(pages.flatMap((page) => Object.entries(page.notes).map(([id, note]) => [id, note.text]))),
    noteRevisions: Object.fromEntries(pages.flatMap((page) => Object.entries(page.notes).map(([id, note]) => [id, note.revision]))),
  }
}

type RestoreStatus = { state: 'unknown' | 'preparing' | 'published' | 'completed' | 'failed' | 'failed-unlock-pending'; result?: BoardRestoreResult; errorCode?: string }
const pendingRestores = new Map<string, BoardRestoreRequest>()
function restoreKey(boardId: string) { return `board-history-restore:v1:${getFirebaseAuth()?.currentUser?.uid ?? 'guest'}:${boardId}` }
function pendingRestore(boardId: string) {
  const key = restoreKey(boardId)
  try { return (JSON.parse(sessionStorage.getItem(key) ?? 'null') as BoardRestoreRequest | null) ?? pendingRestores.get(key) ?? null }
  catch { return pendingRestores.get(key) ?? null }
}
function rememberRestore(boardId: string, value: BoardRestoreRequest | null) {
  const key = restoreKey(boardId)
  if (value) pendingRestores.set(key, value)
  else pendingRestores.delete(key)
  try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key) } catch { /* In-memory identity remains available. */ }
}
/** Resume the identical operation after a lost reply/tab reload; never manufacture a second restore. */
export async function recoverPendingCloudRestore(boardId: string): Promise<RestoreStatus> {
  const request = pendingRestore(boardId)
  if (!request) return { state: 'unknown' }
  const status = await projectCall<RestoreStatus>('boardHistory', { boardId, operation: 'restore-status', operationId: request.operationId })
  if (status.state === 'completed' || status.state === 'failed' || status.state === 'unknown') rememberRestore(boardId, null)
  return status
}

export function cloudHistorySource(boardId: string, head: () => { generation: number; restoreFence?: number }): HistorySource {
  const entries = new Map<string, HistoryEntry>()
  return {
    async list(cursor) {
      const { boardHistoryStore } = await import('@agentic-whiteboard/storage')
      const local = cursor ? [] : (await boardHistoryStore.list(boardId)).filter((version) => !navigator.onLine || version.uploadStatus === 'pending').map((version): HistoryEntry => ({
        id: `local:${version.localVersionId}`, name: version.name, createdAt: version.capturedAt, capturedAt: version.capturedAt, current: version.isCurrent, restorable: false, origin: 'local', expiresAt: version.expiresAt,
      }))
      if (!navigator.onLine) return { entries: local }
      const page = await projectCall<{ entries: BoardHistoryEntry[]; cursor: string | null }>('boardHistory', { boardId, operation: 'list', ...(cursor ? { cursor } : {}) })
      const result = page.entries.map(toHistoryEntry)
      result.forEach((entry) => entries.set(entry.id, entry))
      return { entries: [...local, ...result], cursor: page.cursor ?? undefined }
    },
    async preview(id, signal) {
      if (id.startsWith('local:')) {
        const { boardHistoryStore } = await import('@agentic-whiteboard/storage')
        const value = await boardHistoryStore.get(boardId, id.slice(6))
        if (!value) throw new Error('This local version is no longer available.')
        return { entry: { id, name: value.document.name, createdAt: value.version.capturedAt, current: value.version.isCurrent, restorable: false, origin: 'local' }, scene: value.document.scene, notes: value.notes }
      }
      const snapshot = await readHistorySnapshot(boardId, id, true, true, signal)
      return { ...snapshot, entry: entries.get(id) ?? snapshot.entry }
    },
    async restore(id, operationId) {
      if (id.startsWith('local:')) throw new Error('This version must finish syncing before it can be restored.')
      const current = head()
      const pending = pendingRestore(boardId)
      if (pending && pending.versionId !== id) throw new Error('A previous restoration is still being verified. Wait for it to finish.')
      const request: BoardRestoreRequest = pending ?? { boardId, versionId: id, operationId, expectedGeneration: current.generation, expectedFence: current.restoreFence ?? 0 }
      rememberRestore(boardId, request)
      try {
        const result = await projectCall<BoardRestoreResult>('restoreBoardVersion', request)
        rememberRestore(boardId, null)
        return { operationId: result.operationId, generation: result.generation }
      } catch (error) {
        try {
          const status = await recoverPendingCloudRestore(boardId)
          if (status.state === 'completed' && status.result) return { operationId: status.result.operationId, generation: status.result.generation }
        } catch { /* An ambiguous outcome remains pinned to its original identity. */ }
        throw error
      }
    },
  }
}

export async function localHistorySource(boardId: string): Promise<HistorySource> {
  const { boardHistoryStore } = await import('@agentic-whiteboard/storage')
  const entry = (version: Awaited<ReturnType<typeof boardHistoryStore.list>>[number]): HistoryEntry => ({
    id: version.localVersionId, name: version.name, createdAt: version.capturedAt,
    capturedAt: version.capturedAt, expiresAt: version.expiresAt, current: version.isCurrent, origin: 'local',
  })
  return {
    async list() { return { entries: (await boardHistoryStore.list(boardId)).map(entry) } },
    async preview(id, signal) {
      const result = await boardHistoryStore.get(boardId, id)
      if (!result) throw new Error('This local version expired or is no longer available.')
      return { entry: entry(result.version), scene: result.document.scene, notes: result.notes }
    },
    async restore(id, operationId) {
      const result = await boardHistoryStore.restoreLocal(boardId, id)
      return { operationId, generation: result.version.generation }
    },
  }
}
