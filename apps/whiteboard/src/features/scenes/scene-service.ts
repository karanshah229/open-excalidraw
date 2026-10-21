import type { BoardScene } from '@agentic-whiteboard/storage'
import { doc, onSnapshot } from 'firebase/firestore'
import { getFirebaseAuth, getFirestoreDb } from '../../lib/firebase'
import { projectCall } from '../sharing/project-service'
import { reconcileElementsLWW } from '../collaboration/reconcile'
import {
  assembleScene,
  digestString,
  canonicalStringify,
  manifestDigest,
  packScene,
  paginateReferences,
  SCENE_FORMAT_VERSION,
  SCENE_PROTOCOL_VERSION,
  chunkDocumentBytes,
  type PackedChunk,
  type ChunkReference,
} from '../../../../../functions/src/scene-codec'

export type SceneHead = {
  headRevisionId: string
  generation: number
  sceneFormatVersion: number
}
export type LoadedScene = {
  scene: BoardScene
  revisionId: string
  generation: number
  chunks: PackedChunk[]
}
type Receipt = { revisionId: string; generation: number; candidateDigest: string; committedAt: string }
type SceneReadPin = {
  pinId: string
  revisionId: string
  generation: number
  sceneFormatVersion: number
  expiresAt: string
  initialPage?: ScenePageResponse
}
export type NamedSceneVersion = {
  versionId: string
  name: string
  revisionId: string
  generation: number
  sceneFormatVersion: number
  createdAt: string
}
export type PreparedSceneRestore = {
  operationId: string
  phase: 'prepared' | 'fenced' | 'published' | 'activated' | 'cancelled'
  status?: 'deferred' | 'fenced' | 'published' | 'complete'
  reason?: string
  sourceGeneration: number
  targetGeneration: number
  sourceHeadRevisionId: string
  targetSourceRevisionId: string
  recoveryVersionId: string
  targetRevisionId?: string
  revisionId?: string
}
type SceneRevisionManifest = {
  sceneFormatVersion: number
  generation: number
  pageCount: number
  chunkCount: number
  candidateDigest: string
}
type ScenePageResponse = {
  revision: SceneRevisionManifest
  references: ChunkReference[]
  chunks?: Array<{ id: string; payload: string; digest: string }>
}
type SceneChunkResponse = { chunks: Array<{ id: string; payload: string; digest: string }> }
type CallableError = {
  code?: string
  message?: string
  details?: { reason?: string; [key: string]: unknown }
}
class SceneReadPinRestartError extends Error {
  readonly originalError: unknown

  constructor(cause?: unknown) {
    super('The scene read lease expired or could not be renewed.')
    this.name = 'SceneReadPinRestartError'
    this.originalError = cause
  }
}
export class SceneGenerationError extends Error {
  constructor() {
    super(
      'This board was replaced or restored. Your local draft is retained; reload before choosing how to recover it.',
    )
  }
}
const PAGE_ID = (slot: number) => String(slot).padStart(6, '0')
const requireDb = () => {
  const db = getFirestoreDb()
  if (!db) throw new Error('Cloud scene storage is not configured.')
  return db
}
const requireOnline = () => {
  if (!navigator.onLine) throw new Error('Offline: your draft is saved locally and will sync when connected.')
}
async function inBatches<T, R>(items: T[], work: (item: T, index: number) => Promise<R>, width = 6): Promise<R[]> {
  const results: R[] = []
  for (let offset = 0; offset < items.length; offset += width) {
    results.push(
      ...(await Promise.all(items.slice(offset, offset + width).map((item, index) => work(item, offset + index)))),
    )
  }
  return results
}
function checkedIdentity(uid: string) {
  if (getFirebaseAuth()?.currentUser?.uid !== uid) throw new Error('Account changed while saving the board.')
}
function isMaintenanceBusy(error: unknown) {
  const callableError = error as CallableError
  return callableError.code === 'functions/unavailable' && callableError.details?.reason === 'maintenance'
}
function isSceneBootstrapPending(error: unknown) {
  const callableError = error as CallableError
  return (
    callableError.code === 'functions/failed-precondition' &&
    callableError.details?.reason === 'scene-bootstrap-pending'
  )
}
async function callScene<T>(name: string, data: Record<string, unknown>): Promise<T> {
  try {
    return await projectCall<T>(name, data)
  } catch (error) {
    if (isMaintenanceBusy(error))
      throw new Error('Board maintenance is in progress. Your local draft is retained; try syncing again shortly.')
    throw error
  }
}
// Cache immutable payload bytes only. Every load first authorizes through a fresh read pin;
// account changes/permission failures discard cached entries. SDK access is never inferred from cache.
const chunkCache = new Map<string, PackedChunk>()
// A read pin authorizes the current immutable revision. Remember its ordered
// chunk IDs so later policy/scene-listener refreshes can assemble the verified
// payloads locally instead of fetching the same manifest page again.
const revisionChunkCache = new Map<string, { generation: number; chunkIds: string[] }>()
const MAX_CACHED_REVISIONS = 128
// React StrictMode and concurrent share/metadata readers can request the same
// board at once. Share one pinned read so duplicate requests do not consume the
// server's per-user active-read quota or race to hydrate the editor.
const sceneLoadsInFlight = new Map<string, Promise<LoadedScene | null>>()
let cacheUser: string | undefined
const MAX_CACHED_BYTES = 32 * 1024 * 1024
let cachedBytes = 0
function clearSceneCache() {
  chunkCache.clear()
  revisionChunkCache.clear()
  cachedBytes = 0
}
function cacheIdentity() {
  const user = getFirebaseAuth()?.currentUser?.uid
  if (cacheUser !== user) {
    clearSceneCache()
    cacheUser = user
  }
  return user
}
function cacheChunk(boardId: string, chunk: PackedChunk) {
  const key = `${boardId}:${chunk.chunkId}`
  if (chunkCache.has(key)) return
  const bytes = new TextEncoder().encode(chunk.payload).byteLength
  while (cachedBytes + bytes > MAX_CACHED_BYTES && chunkCache.size) {
    const oldest = chunkCache.keys().next().value!
    cachedBytes -= new TextEncoder().encode(chunkCache.get(oldest)!.payload).byteLength
    chunkCache.delete(oldest)
  }
  if (bytes <= MAX_CACHED_BYTES) {
    chunkCache.set(key, chunk)
    cachedBytes += bytes
  }
}
function revisionCacheKey(boardId: string, revisionId: string) {
  return `${boardId}:${revisionId}`
}
async function loadCachedRevision(
  boardId: string,
  revisionId: string,
  generation: number,
): Promise<LoadedScene | null> {
  const cached = revisionChunkCache.get(revisionCacheKey(boardId, revisionId))
  if (!cached || cached.generation !== generation) return null
  const key = revisionCacheKey(boardId, revisionId)
  revisionChunkCache.delete(key)
  revisionChunkCache.set(key, cached)
  const chunks = cached.chunkIds.map((chunkId) => chunkCache.get(`${boardId}:${chunkId}`))
  if (chunks.some((chunk) => !chunk)) return null
  const verifiedChunks = chunks as PackedChunk[]
  window.dispatchEvent(
    new CustomEvent(`board-load:${boardId}`, {
      detail: { completed: verifiedChunks.length, total: verifiedChunks.length, revisionId },
    }),
  )
  return {
    scene: (await assembleScene(verifiedChunks)) as BoardScene,
    revisionId,
    generation,
    chunks: verifiedChunks,
  }
}
async function readRevision(
  boardId: string,
  pinId: string,
  revisionId: string,
  generation: number,
  ensureReadPin: () => Promise<void>,
  initialPage?: ScenePageResponse,
): Promise<LoadedScene> {
  const guardedRead = async <T>(read: () => Promise<T>): Promise<T> => {
    await ensureReadPin()
    let result: T
    try {
      result = await read()
    } catch (error) {
      // If the lease expired while a request was in flight, expiry takes precedence
      // over a potentially misleading missing-document error from concurrent GC.
      await ensureReadPin()
      throw error
    }
    await ensureReadPin()
    return result
  }
  const readPage = (pageId: string) =>
    guardedRead(() =>
      callScene<ScenePageResponse>('readBoardScenePage', {
        boardId,
        pinId,
        revisionId,
        pageId,
        sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
      }),
    )
  const firstPage = initialPage ?? (await readPage(PAGE_ID(0)))
  const manifest = firstPage.revision
  if (
    !manifest ||
    manifest.sceneFormatVersion !== SCENE_FORMAT_VERSION ||
    manifest.generation !== generation ||
    !Number.isSafeInteger(manifest.pageCount) ||
    manifest.pageCount < 1 ||
    manifest.pageCount > 6
  ) {
    throw new Error('Unsupported or invalid board revision.')
  }
  if (
    !Number.isSafeInteger(manifest.chunkCount) ||
    manifest.chunkCount < 1 ||
    manifest.chunkCount > 512 ||
    typeof manifest.candidateDigest !== 'string'
  )
    throw new Error('Invalid board revision manifest.')
  const remainingPages = await inBatches(
    Array.from({ length: manifest.pageCount - 1 }, (_, index) => index + 1),
    async (pageIndex) => readPage(PAGE_ID(pageIndex)),
  )
  const allPages = [firstPage, ...remainingPages]
  for (const page of allPages) {
    const other = page.revision
    if (
      !other ||
      other.sceneFormatVersion !== manifest.sceneFormatVersion ||
      other.generation !== manifest.generation ||
      other.pageCount !== manifest.pageCount ||
      other.chunkCount !== manifest.chunkCount ||
      other.candidateDigest !== manifest.candidateDigest ||
      !Array.isArray(page.references)
    )
      throw new Error('Board manifest changed or is incomplete.')
  }
  const pageReferences = allPages.map((page, pageIndex) => ({
    pageId: PAGE_ID(pageIndex),
    references: page.references,
  }))
  const references = pageReferences.flatMap(({ references: pageRefs }) => pageRefs)
  if (
    references.length !== manifest.chunkCount ||
    references.length > 10000 ||
    new Set(references.map((r) => r.chunkId)).size !== references.length
  )
    throw new Error('Invalid board manifest references.')
  if ((await manifestDigest(references, generation)) !== manifest.candidateDigest)
    throw new Error('Board manifest integrity check failed.')
  let completed = 0
  window.dispatchEvent(
    new CustomEvent(`board-load:${boardId}`, {
      detail: { completed, total: references.length, revisionId },
    }),
  )
  const loadedById = new Map<string, PackedChunk>()
  // The server returns the first bounded payload batch with each manifest page.
  // Verify it exactly like a separately fetched chunk before accepting it.
  for (const page of allPages) {
    for (const chunk of page.chunks ?? []) {
      const reference = page.references.find(({ chunkId }) => chunkId === chunk.id)
      if (
        !reference ||
        loadedById.has(chunk.id) ||
        typeof chunk.payload !== 'string' ||
        chunk.digest !== reference.digest ||
        (await digestString(chunk.payload)) !== reference.digest
      )
        throw new Error('Board chunk is missing or invalid.')
      loadedById.set(chunk.id, { chunkId: chunk.id, digest: chunk.digest, payload: chunk.payload })
    }
  }
  const missing: ChunkReference[] = []
  for (const reference of references) {
    if (
      typeof reference.chunkId !== 'string' ||
      !/^[\w-]{1,100}$/.test(reference.chunkId) ||
      typeof reference.digest !== 'string'
    )
      throw new Error('Invalid chunk reference.')
    const cached = chunkCache.get(`${boardId}:${reference.chunkId}`)
    const inline = loadedById.get(reference.chunkId)
    if (inline) {
      window.dispatchEvent(
        new CustomEvent(`board-load:${boardId}`, {
          detail: { completed: ++completed, total: references.length, revisionId },
        }),
      )
    } else if (cached?.digest === reference.digest) {
      loadedById.set(reference.chunkId, cached)
      window.dispatchEvent(
        new CustomEvent(`board-load:${boardId}`, {
          detail: { completed: ++completed, total: references.length, revisionId },
        }),
      )
    } else missing.push(reference)
  }
  // Keep callable responses bounded even for maximum-sized boards: each request carries
  // at most eight chunk IDs, and each stored chunk is capped at 512 KiB.
  const chunkBatches: Array<{ pageId: string; references: ChunkReference[] }> = []
  const missingIds = new Set(missing.map(({ chunkId }) => chunkId))
  for (const page of pageReferences) {
    for (let offset = 0; offset < page.references.length; offset += 8) {
      const referencesInBatch = page.references
        .slice(offset, offset + 8)
        .filter((reference) => missingIds.has(reference.chunkId))
      if (referencesInBatch.length) chunkBatches.push({ pageId: page.pageId, references: referencesInBatch })
    }
  }
  await inBatches(chunkBatches, async ({ pageId, references: batch }) => {
    const result = await guardedRead(() =>
      callScene<SceneChunkResponse>('readBoardSceneChunks', {
        boardId,
        pinId,
        revisionId,
        pageId,
        chunkIds: batch.map(({ chunkId }) => chunkId),
        sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
      }),
    )
    if (!Array.isArray(result?.chunks) || result.chunks.length !== batch.length)
      throw new Error('Board chunk response is incomplete.')
    const expected = new Map(batch.map((reference) => [reference.chunkId, reference.digest]))
    const seen = new Set<string>()
    const verified: PackedChunk[] = []
    for (const chunk of result.chunks) {
      const expectedDigest = expected.get(chunk.id)
      if (
        !expectedDigest ||
        seen.has(chunk.id) ||
        typeof chunk.payload !== 'string' ||
        chunk.digest !== expectedDigest ||
        (await digestString(chunk.payload)) !== expectedDigest
      )
        throw new Error('Board chunk is missing or invalid.')
      seen.add(chunk.id)
      const packed = { chunkId: chunk.id, digest: chunk.digest, payload: chunk.payload }
      loadedById.set(chunk.id, packed)
      verified.push(packed)
      window.dispatchEvent(
        new CustomEvent(`board-load:${boardId}`, {
          detail: { completed: ++completed, total: references.length, revisionId },
        }),
      )
    }
    if (seen.size !== expected.size) throw new Error('Board chunk response is incomplete.')
    return verified
  })
  const chunks = references.map((reference) => loadedById.get(reference.chunkId))
  if (chunks.some((chunk) => !chunk)) throw new Error('Board chunk response is incomplete.')
  const verifiedChunks = chunks as PackedChunk[]
  const scene = (await assembleScene(verifiedChunks)) as BoardScene
  await ensureReadPin()
  // Publish cache entries only after the complete scene is assembled under a live pin.
  verifiedChunks.forEach((chunk) => cacheChunk(boardId, chunk))
  const key = revisionCacheKey(boardId, revisionId)
  revisionChunkCache.delete(key)
  while (revisionChunkCache.size >= MAX_CACHED_REVISIONS) {
    revisionChunkCache.delete(revisionChunkCache.keys().next().value!)
  }
  revisionChunkCache.set(key, {
    generation,
    chunkIds: verifiedChunks.map(({ chunkId }) => chunkId),
  })
  return { scene, revisionId, generation, chunks: verifiedChunks }
}
const pendingKey = (uid: string, boardId: string) => `scene-upload:v1:${uid}:${boardId}`
function pendingCandidate(
  uid: string,
  boardId: string,
): { commitId: string; sourceDigest: string; generation: number } | null {
  try {
    return JSON.parse(sessionStorage.getItem(pendingKey(uid, boardId)) ?? 'null')
  } catch {
    return null
  }
}
function forgetCandidate(uid: string, boardId: string) {
  try {
    sessionStorage.removeItem(pendingKey(uid, boardId))
  } catch {
    /* Receipt remains authoritative. */
  }
}

export const sceneService = {
  ensure(boardId: string, projectId?: string): Promise<SceneHead> {
    return projectCall('ensureBoardScene', { boardId, ...(projectId ? { projectId } : {}) })
  },
  async load(boardId: string): Promise<LoadedScene | null> {
    requireOnline()
    const identity = cacheIdentity()
    const loadKey = `${identity ?? 'anonymous'}:${boardId}`
    const existingLoad = sceneLoadsInFlight.get(loadKey)
    if (existingLoad) return existingLoad

    const loadPromise = (async (): Promise<LoadedScene | null> => {
      try {
        let bootstrapEnsured = false
        const acquirePin = async (): Promise<SceneReadPin | null> => {
          try {
            return await projectCall<SceneReadPin | null>('acquireBoardSceneReadPin', {
              boardId,
              sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
            })
          } catch (error) {
            if (!isSceneBootstrapPending(error) || bootstrapEnsured) throw error
            bootstrapEnsured = true
            await sceneService.ensure(boardId)
            return projectCall<SceneReadPin | null>('acquireBoardSceneReadPin', {
              boardId,
              sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
            })
          }
        }
        const isValidPin = (pin: SceneReadPin): boolean =>
          typeof pin?.pinId === 'string' &&
          typeof pin.revisionId === 'string' &&
          Number.isSafeInteger(pin.generation) &&
          pin.sceneFormatVersion === SCENE_FORMAT_VERSION &&
          typeof pin.expiresAt === 'string' &&
          Number.isFinite(Date.parse(pin.expiresAt))

        for (let attempt = 0; attempt < 2; attempt++) {
          let pin: SceneReadPin | undefined
          try {
            const acquiredPin = await acquirePin()
            if (acquiredPin === null) return null
            pin = acquiredPin
            if (!isValidPin(acquiredPin)) throw new Error('Board read authorization returned an invalid revision.')

            let lastRenewedWallTime = Date.now()
            let lastRenewedMonotonicTime = performance.now()
            const renewalDue = () =>
              Math.max(Date.now() - lastRenewedWallTime, performance.now() - lastRenewedMonotonicTime) >= 60_000
            let renewalPromise: Promise<void> | undefined
            let renewalFailure: unknown
            const renewPin = async (): Promise<void> => {
              if (renewalFailure) throw renewalFailure
              if (!renewalPromise) {
                const activePin = pin!
                renewalPromise = (async () => {
                  let renewed: SceneReadPin
                  try {
                    renewed = await projectCall<SceneReadPin>('renewBoardSceneReadPin', {
                      boardId,
                      pinId: activePin.pinId,
                      sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
                    })
                  } catch (error) {
                    if (isMaintenanceBusy(error)) throw error
                    throw new SceneReadPinRestartError(error)
                  }
                  if (
                    !isValidPin(renewed) ||
                    renewed.pinId !== activePin.pinId ||
                    renewed.revisionId !== activePin.revisionId ||
                    renewed.generation !== activePin.generation
                  )
                    throw new SceneReadPinRestartError()
                  pin = renewed
                  lastRenewedWallTime = Date.now()
                  lastRenewedMonotonicTime = performance.now()
                })()
              }
              const activeRenewal = renewalPromise
              try {
                await activeRenewal
              } catch (error) {
                renewalFailure = error
                throw error
              } finally {
                if (renewalPromise === activeRenewal) renewalPromise = undefined
              }
            }
            const ensureReadPin = async (): Promise<void> => {
              if (renewalFailure) throw renewalFailure
              if (renewalDue()) await renewPin()
              else if (renewalPromise) await renewPin()
              if (renewalFailure) throw renewalFailure
            }
            const renewalTimer = window.setInterval(() => {
              if (renewalDue())
                void renewPin().catch((error) => {
                  renewalFailure = error
                })
            }, 60_000)
            let loaded = await loadCachedRevision(boardId, pin!.revisionId, pin!.generation)
            try {
              if (!loaded) {
                loaded = await readRevision(
                  boardId,
                  pin!.pinId,
                  pin!.revisionId,
                  pin!.generation,
                  ensureReadPin,
                  pin!.initialPage,
                )
              } else await ensureReadPin()
            } finally {
              window.clearInterval(renewalTimer)
            }
            if (identity !== getFirebaseAuth()?.currentUser?.uid)
              throw new Error('Account changed while loading the board.')
            return loaded
          } catch (error) {
            if (error instanceof SceneReadPinRestartError && attempt === 0) {
              clearSceneCache()
              continue
            }
            clearSceneCache()
            if (isMaintenanceBusy(error))
              throw new Error(
                'Board maintenance is in progress. Your local draft is retained; try loading again shortly.',
              )
            if (error instanceof SceneReadPinRestartError)
              throw new Error(
                'Could not keep the board available while loading. Your local draft is retained; retry loading.',
              )
            throw error
          } finally {
            if (pin?.pinId) {
              try {
                await projectCall('releaseBoardSceneReadPin', {
                  boardId,
                  pinId: pin.pinId,
                  sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
                })
              } catch {
                // The read lease expires if explicit release fails; never mask the load result.
              }
            }
          }
        }
        throw new Error(
          'Could not keep the board available while loading. Your local draft is retained; retry loading.',
        )
      } catch (error) {
        clearSceneCache()
        throw error
      }
    })()
    sceneLoadsInFlight.set(loadKey, loadPromise)
    try {
      return await loadPromise
    } finally {
      if (sceneLoadsInFlight.get(loadKey) === loadPromise) sceneLoadsInFlight.delete(loadKey)
    }
  },
  async createNamedVersion(boardId: string, name: string): Promise<NamedSceneVersion> {
    requireOnline()
    return projectCall('createNamedBoardSceneVersion', { boardId, name, sceneProtocolVersion: SCENE_PROTOCOL_VERSION })
  },
  async listNamedVersions(boardId: string): Promise<NamedSceneVersion[]> {
    requireOnline()
    const result = await projectCall<{ versions: NamedSceneVersion[] }>('listNamedBoardSceneVersions', { boardId })
    if (!Array.isArray(result?.versions)) throw new Error('Board version list is invalid.')
    return result.versions
  },
  /** Create an idempotent, recoverable restore plan; this does not change the live board. */
  async prepareVersionRestore(boardId: string, versionId: string, operationId: string): Promise<PreparedSceneRestore> {
    requireOnline()
    const result = await projectCall<PreparedSceneRestore>('prepareBoardSceneGenerationReset', {
      boardId,
      versionId,
      operationId,
      sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
    })
    if (
      !result ||
      result.operationId !== operationId ||
      !['prepared', 'fenced', 'published', 'activated', 'cancelled'].includes(result.phase) ||
      !Number.isSafeInteger(result.sourceGeneration) ||
      result.targetGeneration !== result.sourceGeneration + 1 ||
      !result.sourceHeadRevisionId ||
      !result.targetSourceRevisionId ||
      !result.recoveryVersionId
    )
      throw new Error('Board restore preparation returned an invalid operation.')
    return result
  },
  /** Run or resume the cross-store restore state machine; active rooms return a deferred checkpoint. */
  async restoreNamedVersion(boardId: string, versionId: string, operationId: string): Promise<PreparedSceneRestore> {
    requireOnline()
    let state = await this.prepareVersionRestore(boardId, versionId, operationId)
    if (state.phase === 'prepared') {
      const fenced = await projectCall<PreparedSceneRestore>('fenceBoardSceneGenerationReset', {
        boardId,
        operationId,
        sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
      })
      state = { ...state, ...fenced }
      if (fenced.status === 'deferred') return state
    }
    if (state.phase === 'fenced') {
      const published = await projectCall<PreparedSceneRestore>('publishBoardSceneGenerationReset', {
        boardId,
        operationId,
        sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
      })
      state = { ...state, ...published }
    }
    if (state.phase === 'published' || (state.phase === 'activated' && state.status !== 'complete')) {
      const activated = await projectCall<PreparedSceneRestore>('activateBoardSceneGenerationReset', {
        boardId,
        operationId,
        sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
      })
      state = { ...state, ...activated }
    }
    return state
  },
  /** Load an immutable historical snapshot; this deliberately does not read or merge RTDB state. */
  async loadNamedVersion(boardId: string, versionId: string): Promise<LoadedScene> {
    requireOnline()
    const identity = cacheIdentity()
    const pin = await projectCall<SceneReadPin & { versionId: string }>('acquireNamedBoardSceneVersionReadPin', {
      boardId,
      versionId,
      sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
    })
    let lastRenewed = Date.now(),
      renewalFailure: unknown
    let renewalPromise: Promise<void> | undefined
    const renew = async () => {
      if (Date.now() - lastRenewed < 60_000) return
      if (!renewalPromise)
        renewalPromise = (async () => {
          const renewed = await projectCall<SceneReadPin>('renewBoardSceneReadPin', {
            boardId,
            pinId: pin.pinId,
            sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
          })
          if (
            renewed.pinId !== pin.pinId ||
            renewed.revisionId !== pin.revisionId ||
            renewed.generation !== pin.generation
          )
            throw new Error('Historical board read pin changed.')
          lastRenewed = Date.now()
        })()
          .catch((error) => {
            renewalFailure = error
            throw error
          })
          .finally(() => {
            renewalPromise = undefined
          })
      return renewalPromise
    }
    const timer = window.setInterval(() => {
      if (Date.now() - lastRenewed >= 60_000) void renew().catch(() => {})
    }, 60_000)
    try {
      if (
        !pin?.pinId ||
        pin.versionId !== versionId ||
        !pin.revisionId ||
        !Number.isSafeInteger(pin.generation) ||
        pin.sceneFormatVersion !== SCENE_FORMAT_VERSION ||
        !Number.isFinite(Date.parse(pin.expiresAt))
      )
        throw new Error('Named board version authorization returned an invalid revision.')
      const loaded = await readRevision(boardId, pin.pinId, pin.revisionId, pin.generation, async () => {
        if (renewalFailure) throw renewalFailure
        await renew()
      })
      if (identity !== getFirebaseAuth()?.currentUser?.uid)
        throw new Error('Account changed while loading the board version.')
      return loaded
    } finally {
      window.clearInterval(timer)
      try {
        if (pin?.pinId)
          await projectCall('releaseBoardSceneReadPin', {
            boardId,
            pinId: pin.pinId,
            sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
          })
      } catch {
        /* Pin expires naturally if explicit release fails. */
      }
    }
  },
  subscribeHead(
    boardId: string,
    onChange: (head?: Record<string, unknown>) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const db = getFirestoreDb()
    if (!db) return () => {}
    return onSnapshot(
      doc(db, 'boardScenes', boardId),
      (snapshot) => onChange(snapshot.data()),
      (error) => {
        clearSceneCache()
        onError?.(error)
      },
    )
  },
  async commit(
    boardId: string,
    source: BoardScene,
    options: { expectedGeneration?: number } = {},
  ): Promise<LoadedScene> {
    requireOnline()
    const uid = getFirebaseAuth()?.currentUser?.uid
    if (!uid) throw new Error('Sign in to save this board.')
    const sourceDigest = await digestString(canonicalStringify(source))
    const pending = pendingCandidate(uid, boardId)
    // Resolve ambiguous success before creating another candidate, including after reload.
    if (pending) {
      checkedIdentity(uid)
      try {
        const receipt = await callScene<Receipt>('commitBoardScene', {
          boardId,
          commitId: pending.commitId,
          sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
        })
        // Resolve to the current head through a read pin. A successful receipt may already
        // have been followed by another save, so return the latest pinned revision.
        const loaded = await sceneService.load(boardId)
        const currentGeneration = loaded?.generation
        if (currentGeneration !== receipt.generation || currentGeneration !== (options.expectedGeneration ?? 1))
          throw new SceneGenerationError()
        forgetCandidate(uid, boardId)
        // A newer local edit may have arrived while the previous commit's response
        // was lost. Resolve that ambiguous receipt first, then publish the newer
        // source against the now-current head below.
        if (pending.sourceDigest === sourceDigest) return loaded!
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code !== 'functions/aborted' && code !== 'functions/not-found' && code !== 'functions/failed-precondition')
          throw error
        forgetCandidate(uid, boardId)
      }
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      checkedIdentity(uid)
      let base = await sceneService.load(boardId)
      if (!base) {
        await sceneService.ensure(boardId)
        base = await sceneService.load(boardId)
      }
      if (!base) throw new Error('Board scene has not been registered.')
      if (base.generation !== (options.expectedGeneration ?? 1)) throw new SceneGenerationError()
      const scene: BoardScene = {
        ...base.scene,
        ...source,
        elements: reconcileElementsLWW(source.elements, base.scene.elements),
        files: { ...base.scene.files, ...source.files },
      }
      const packed = await packScene(scene, base.chunks)
      const previousIds = new Set(base.chunks.map((c) => c.chunkId))
      if (packed.length === base.chunks.length && packed.every((c, i) => c.chunkId === base.chunks[i].chunkId))
        return base
      const commitId = crypto.randomUUID()
      let freshSlot = 0
      const chunks = packed.map((c) =>
        previousIds.has(c.chunkId) ? c : { ...c, chunkId: `${commitId}_${PAGE_ID(freshSlot++)}` },
      )
      const references = chunks.map(({ chunkId, digest }) => ({ chunkId, digest }))
      const pages = paginateReferences(references)
      if (
        pages.length > 6 ||
        chunks.length > 512 ||
        chunks.reduce((bytes, chunk) => bytes + chunkDocumentBytes(chunk.payload), 0) > 64 * 1024 * 1024
      )
        throw new Error('This board exceeds the current cloud scene budget. Your local draft is retained.')
      const candidateDigest = await manifestDigest(references, base.generation)
      const fresh = chunks.filter((c) => !previousIds.has(c.chunkId))
      checkedIdentity(uid)
      try {
        await callScene('beginBoardSceneUpload', {
          boardId,
          commitId,
          expectedHeadRevisionId: base.revisionId,
          generation: base.generation,
          sceneFormatVersion: SCENE_FORMAT_VERSION,
          sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
          pageCount: pages.length,
          chunkCount: chunks.length,
          newChunkCount: fresh.length,
          candidateDigest,
        })
      } catch (error) {
        if ((error as CallableError).code !== 'functions/aborted') throw error
        const latest = await sceneService.load(boardId)
        const details = (error as CallableError).details
        const latestGeneration = latest?.generation ?? details?.generation
        if (latestGeneration !== undefined && latestGeneration !== base.generation) throw new SceneGenerationError()
        if (latest && latest.revisionId !== base.revisionId) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** attempt))
          continue
        }
        throw error
      }
      try {
        await inBatches(fresh, async (c, slot) => {
          checkedIdentity(uid)
          await callScene('stageBoardSceneChunk', {
            boardId,
            commitId,
            sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
            slot,
            payload: c.payload,
            digest: c.digest,
          })
        })
        await inBatches(pages, async (references, i) => {
          checkedIdentity(uid)
          await callScene('stageBoardScenePage', {
            boardId,
            commitId,
            sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
            pageIndex: i,
            references,
          })
        })
      } catch (error) {
        // Another writer may publish after beginUpload but before this candidate finishes
        // staging. The server fences that upload; rebase from the new head just as we do
        // when begin/publish detects a stale revision. Preserve gate/permission failures.
        const code = (error as CallableError).code
        if (code !== 'functions/failed-precondition' && code !== 'functions/aborted') throw error
        const latest = await sceneService.load(boardId)
        if (latest && latest.generation !== base.generation) throw new SceneGenerationError()
        if (latest && latest.revisionId !== base.revisionId) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** attempt + Math.random() * 100))
          continue
        }
        throw error
      }
      try {
        sessionStorage.setItem(
          pendingKey(uid, boardId),
          JSON.stringify({ commitId, sourceDigest, generation: base.generation }),
        )
      } catch {
        /* Retry within this call still uses the same identity. */
      }
      checkedIdentity(uid)
      try {
        const receipt = await callScene<Receipt>('commitBoardScene', {
          boardId,
          commitId,
          sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
        })
        if (receipt.candidateDigest !== candidateDigest || receipt.generation !== base.generation)
          throw new Error('Invalid scene commit receipt.')
        forgetCandidate(uid, boardId)
        chunks.forEach((chunk) => cacheChunk(boardId, chunk))
        return { scene, chunks, revisionId: receipt.revisionId, generation: receipt.generation }
      } catch (error) {
        if ((error as { code?: string }).code !== 'functions/aborted') throw error
        forgetCandidate(uid, boardId)
        const generation = (error as { details?: { generation?: number } }).details?.generation
        if (generation !== undefined && generation !== base.generation) throw new SceneGenerationError()
        await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** attempt + Math.random() * 100))
      }
    }
    throw new Error('Board is changing rapidly. Your draft is retained and cloud sync will retry.')
  },
}
