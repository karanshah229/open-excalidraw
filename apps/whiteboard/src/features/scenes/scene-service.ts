import type { BoardScene } from '@agentic-whiteboard/storage'
import { doc, getDocFromServer, onSnapshot, setDoc, Timestamp, serverTimestamp } from 'firebase/firestore'
import { getFirebaseAuth, getFirestoreDb } from '../../lib/firebase'
import { projectCall } from '../sharing/project-service'
import { LegacySceneHistoryError, readHistorySnapshot } from '../history/history-service'
import { assertHistoryMutationAllowed, historyEditingState } from '../history/history-editing-gate'
import { reconcileElementsLWW } from '../collaboration/reconcile'
import { ensureAuthenticatedUser } from '../collaboration/anonymous-user'
import {
  assembleScene,
  digestString,
  canonicalStringify,
  manifestDigest,
  packScene,
  paginateReferences,
  SCENE_FORMAT_VERSION,
  chunkDocumentBytes,
  type PackedChunk,
  type ChunkReference,
} from '../../../../../functions/src/scene-codec'

export type SceneHead = {
  headRevisionId: string
  generation: number
  sceneFormatVersion: number
  historyProtocolVersion?: number
  restoreFence?: number
  restoreOperationId?: string | null
  currentVersionId?: string | null
  readContextId?: string
  notesPageCount?: number
  currentBranchId?: string | null
  historyEpoch?: number
  boardName?: string
  nameRevision?: number
  notesRevisionId?: string | null
}
export type LoadedScene = {
  scene: BoardScene
  revisionId: string
  generation: number
  chunks: PackedChunk[]
  restoreFence?: number
  historyProtocolVersion?: number
  readContextId?: string
  notesPageCount?: number
  boardName?: string
  nameRevision?: number
  currentVersionId?: string | null
}
type Receipt = {
  revisionId: string
  generation: number
  candidateDigest: string
  committedAt: string
  versionId?: string
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
// Chunk payloads are immutable. Reuse a complete scene only while a server-confirmed
// head listener pins the same revision; account changes and listener errors discard it.
const chunkCache = new Map<string, PackedChunk>()
const recentSceneCache = new Map<string, { identity: string | undefined; expiresAt: number; value: LoadedScene; bytes: number }>()
const observedHeads = new Map<string, { revisionId: string; generation: number }>()
const headSubscriptionCounts = new Map<string, number>()
let recentSceneCacheBytes = 0
let cacheUser: string | undefined
const MAX_CACHED_BYTES = 32 * 1024 * 1024
const MAX_RECENT_SCENE_CACHE_BYTES = 16 * 1024 * 1024
let cachedBytes = 0
function clearSceneCache() {
  chunkCache.clear()
  recentSceneCache.clear()
  observedHeads.clear()
  cachedBytes = 0
  recentSceneCacheBytes = 0
}
function dropRecentScene(boardId: string) {
  const cached = recentSceneCache.get(boardId)
  if (!cached) return
  recentSceneCacheBytes -= cached.bytes
  recentSceneCache.delete(boardId)
}
function cacheRecentScene(boardId: string, identity: string | undefined, value: LoadedScene) {
  dropRecentScene(boardId)
  const bytes = Math.max(1, value.chunks.reduce((total, chunk) => total + new TextEncoder().encode(chunk.payload).byteLength, 0))
  if (bytes > MAX_RECENT_SCENE_CACHE_BYTES) return
  while (recentSceneCacheBytes + bytes > MAX_RECENT_SCENE_CACHE_BYTES) {
    const oldest = recentSceneCache.keys().next().value
    if (!oldest) break
    dropRecentScene(oldest)
  }
  recentSceneCache.set(boardId, { identity, expiresAt: Date.now() + 30_000, value, bytes })
  recentSceneCacheBytes += bytes
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
async function readRevision(boardId: string, revisionId: string, generation: number): Promise<LoadedScene> {
  const db = requireDb()
  const revision = await getDocFromServer(doc(db, 'boardScenes', boardId, 'revisions', revisionId))
  if (!revision.exists()) throw new Error('Board revision is incomplete. Retry loading; your local scene is retained.')
  const manifest = revision.data()
  if (
    manifest.sceneFormatVersion !== SCENE_FORMAT_VERSION ||
    manifest.generation !== generation ||
    !Number.isInteger(manifest.pageCount) ||
    manifest.pageCount < 1 ||
    manifest.pageCount > 1000
  ) {
    throw new Error('Unsupported or invalid board revision.')
  }
  const pages = await inBatches(
    Array.from({ length: manifest.pageCount }, (_, i) => i),
    async (i) => {
      const page = await getDocFromServer(doc(db, 'boardScenes', boardId, 'revisions', revisionId, 'pages', PAGE_ID(i)))
      if (!page.exists() || !Array.isArray(page.data().references)) throw new Error('Board manifest is incomplete.')
      return page.data().references as ChunkReference[]
    },
  )
  const references = pages.flat()
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
  const chunks = await inBatches(references, async (reference) => {
    if (
      typeof reference.chunkId !== 'string' ||
      !/^[\w-]{1,100}$/.test(reference.chunkId) ||
      typeof reference.digest !== 'string'
    )
      throw new Error('Invalid chunk reference.')
    const cached = chunkCache.get(`${boardId}:${reference.chunkId}`)
    if (cached?.digest === reference.digest) {
      window.dispatchEvent(
        new CustomEvent(`board-load:${boardId}`, {
          detail: { completed: ++completed, total: references.length, revisionId },
        }),
      )
      return cached
    }
    const chunk = await getDocFromServer(doc(db, 'boardScenes', boardId, 'chunks', reference.chunkId))
    if (
      !chunk.exists() ||
      typeof chunk.data().payload !== 'string' ||
      chunk.data().digest !== reference.digest ||
      chunk.data().generation !== generation
    )
      throw new Error('Board chunk is missing or invalid.')
    if ((await digestString(chunk.data().payload)) !== reference.digest)
      throw new Error('Board chunk integrity check failed.')
    window.dispatchEvent(
      new CustomEvent(`board-load:${boardId}`, {
        detail: { completed: ++completed, total: references.length, revisionId },
      }),
    )
    const loaded = {
      chunkId: reference.chunkId,
      digest: reference.digest,
      payload: chunk.data().payload,
    } as PackedChunk
    cacheChunk(boardId, loaded)
    return loaded
  })
  return { scene: (await assembleScene(chunks)) as BoardScene, revisionId, generation, chunks }
}
const pendingKey = (uid: string, boardId: string) => `scene-upload:v1:${uid}:${boardId}`
const sceneLoadRequests = new Map<string, Promise<LoadedScene | null>>()
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
    const auth = getFirebaseAuth()
    if (auth) await auth.authStateReady()
    const identity = cacheIdentity()
    const cached = recentSceneCache.get(boardId)
    const observed = observedHeads.get(boardId)
    // Repeated route/share hydrators may reuse an authorized immutable scene
    // only while a server-confirmed Firestore head listener proves it current.
    if (cached && cached.identity === identity && cached.expiresAt > Date.now() && observed &&
      observed.revisionId === cached.value.revisionId && observed.generation === cached.value.generation)
      return cached.value
    if (cached) dropRecentScene(boardId)
    const active = sceneLoadRequests.get(boardId)
    if (active) return active
    const request = sceneService.loadUnshared(boardId).finally(() => {
      if (sceneLoadRequests.get(boardId) === request) sceneLoadRequests.delete(boardId)
    })
    sceneLoadRequests.set(boardId, request)
    return request
  },
  async loadUnshared(boardId: string): Promise<LoadedScene | null> {
    requireOnline()
    // Establish a guest identity before capturing the cache identity. Creating
    // it inside the history read would look like an account switch mid-load.
    const auth = getFirebaseAuth()
    if (auth) {
      await auth.authStateReady()
      if (!auth.currentUser && !await ensureAuthenticatedUser(auth)) throw new Error('Sign in to load this board.')
    }
    const identity = cacheIdentity()
    try {
      let data: SceneHead
      let snapshot: Awaited<ReturnType<typeof readHistorySnapshot>> | Awaited<ReturnType<typeof readRevision>>
      try {
        // One authorized callable returns the head metadata, manifest references,
        // and first bounded chunk batch. Legacy boards fall back to Firestore.
        snapshot = await readHistorySnapshot(boardId, undefined, false, false, undefined, 'current-scene')
        data = {
          headRevisionId: snapshot.revisionId,
          generation: snapshot.generation,
          sceneFormatVersion: SCENE_FORMAT_VERSION,
          historyProtocolVersion: snapshot.historyProtocolVersion,
          restoreFence: snapshot.restoreFence,
          currentVersionId: snapshot.currentVersionId,
          boardName: 'entry' in snapshot ? snapshot.entry.name : undefined,
          nameRevision: snapshot.nameRevision,
        }
      } catch (error) {
        // The boardHistory callable was added after the original scene loader.
        // During a staged Functions rollout, older runtimes can report a
        // missing callable as either not-found or internal (depending on the
        // callable router version). Fall back to the protected Firestore
        // head/revision reads; a genuinely missing board is confirmed by the
        // head lookup below and returns null there.
        const code = (error as { code?: string }).code
        if (!(error instanceof LegacySceneHistoryError) && code !== 'functions/not-found' && code !== 'functions/internal') throw error
        let head = await getDocFromServer(doc(requireDb(), 'boardScenes', boardId))
        if (!head.exists()) return null
        if (head.data().headRevisionId === null) {
          await sceneService.ensure(boardId)
          head = await getDocFromServer(doc(requireDb(), 'boardScenes', boardId))
        }
        data = head.data() as SceneHead
        if (!data.headRevisionId || data.sceneFormatVersion !== SCENE_FORMAT_VERSION)
          throw new Error('Unsupported board scene format.', { cause: error })
        // A concurrent first save may upgrade the board to history protocol 1
        // between the initial callable response and this legacy fallback. The
        // Firestore revision path is intentionally closed for upgraded boards,
        // so retry through the history gateway after observing the new head.
        snapshot = data.historyProtocolVersion === 1
          ? await readHistorySnapshot(boardId, undefined, false, false, undefined, 'current-scene')
          : await readRevision(boardId, data.headRevisionId, data.generation)
      }
      const loaded: LoadedScene = {
        ...snapshot,
        restoreFence: data.restoreFence ?? 0,
        historyProtocolVersion: data.historyProtocolVersion,
        boardName: data.boardName,
        nameRevision: data.nameRevision,
        currentVersionId: data.currentVersionId,
        readContextId: 'readContextId' in snapshot ? snapshot.readContextId : undefined,
        notesPageCount: 'notesPageCount' in snapshot ? snapshot.notesPageCount : undefined,
      }
      if (identity !== getFirebaseAuth()?.currentUser?.uid) throw new Error('Account changed while loading the board.')
      cacheRecentScene(boardId, identity, loaded)
      return loaded
    } catch (error) {
      clearSceneCache()
      throw error
    }
  },
  subscribeHead(boardId: string, onChange: (head: SceneHead | undefined) => void, onError?: (error: unknown) => void): () => void {
    const db = getFirestoreDb()
    if (!db) return () => {}
    headSubscriptionCounts.set(boardId, (headSubscriptionCounts.get(boardId) ?? 0) + 1)
    const unsubscribe = onSnapshot(doc(db, 'boardScenes', boardId), { includeMetadataChanges: true }, (snapshot) => {
      const head = snapshot.exists() ? snapshot.data() as SceneHead : undefined
      if (!snapshot.metadata.fromCache) {
        if (head?.headRevisionId) {
          const next = { revisionId: head.headRevisionId, generation: head.generation }
          const cached = recentSceneCache.get(boardId)
          if (cached && (cached.value.revisionId !== next.revisionId || cached.value.generation !== next.generation))
            dropRecentScene(boardId)
          observedHeads.set(boardId, next)
        } else {
          observedHeads.delete(boardId)
          dropRecentScene(boardId)
        }
      }
      onChange(head)
    }, (error) => {
      observedHeads.delete(boardId)
      dropRecentScene(boardId)
      clearSceneCache()
      onError?.(error)
    })
    return () => {
      unsubscribe()
      const remaining = (headSubscriptionCounts.get(boardId) ?? 1) - 1
      if (remaining > 0) headSubscriptionCounts.set(boardId, remaining)
      else {
        headSubscriptionCounts.delete(boardId)
        observedHeads.delete(boardId)
      }
    }
  },
  async commit(
    boardId: string,
    source: BoardScene,
    options: { expectedGeneration?: number; expectedFence?: number } = {},
  ): Promise<LoadedScene> {
    requireOnline()
    assertHistoryMutationAllowed(boardId)
    const editingEpoch = historyEditingState(boardId).epoch
    const uid = getFirebaseAuth()?.currentUser?.uid
    if (!uid) throw new Error('Sign in to save this board.')
    const sourceDigest = await digestString(canonicalStringify(source))
    const pending = pendingCandidate(uid, boardId)
    // Resolve ambiguous success before creating another candidate, including after reload.
    if (pending?.sourceDigest === sourceDigest) {
      checkedIdentity(uid)
      try {
        const receipt = await projectCall<Receipt>('commitBoardScene', { boardId, commitId: pending.commitId })
        const head = await getDocFromServer(doc(requireDb(), 'boardScenes', boardId))
        const currentGeneration = head.data()?.generation
        if (currentGeneration !== receipt.generation || currentGeneration !== (options.expectedGeneration ?? 1))
          throw new SceneGenerationError()
        forgetCandidate(uid, boardId)
        // The receipt acknowledges this candidate, but a later committed head must
        // remain the scene we display/cache after an ambiguous-response recovery.
        return head.data()?.historyProtocolVersion === 1
          ? (await sceneService.load(boardId))!
          : await readRevision(boardId, head.data()!.headRevisionId, receipt.generation)
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code !== 'functions/aborted' && code !== 'functions/not-found' && code !== 'functions/failed-precondition')
          throw error
        forgetCandidate(uid, boardId)
      }
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      checkedIdentity(uid)
      assertHistoryMutationAllowed(boardId, editingEpoch)
      let base = await sceneService.load(boardId)
      if (!base) {
        await sceneService.ensure(boardId)
        base = await sceneService.load(boardId)
      }
      if (!base) throw new Error('Board scene has not been registered.')
      if (base.generation !== (options.expectedGeneration ?? 1)) throw new SceneGenerationError()
      if (
        base.historyProtocolVersion === 1 &&
        options.expectedFence !== undefined &&
        options.expectedFence !== base.restoreFence
      )
        throw new Error('The board restore fence changed. Refresh before retrying this save.')
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
      const db = requireDb()
      const createdAt = serverTimestamp()
      const candidate = {
        uploaderUid: uid,
        ...(base.historyProtocolVersion === 1
          ? { expectedFence: options.expectedFence ?? base.restoreFence ?? 0 }
          : {}),
        expectedHeadRevisionId: base.revisionId,
        generation: base.generation,
        sceneFormatVersion: SCENE_FORMAT_VERSION,
        pageCount: pages.length,
        chunkCount: chunks.length,
        newChunkCount: fresh.length,
        candidateDigest,
        createdAt,
        expiresAt: Timestamp.fromMillis(Date.now() + 23 * 60 * 60 * 1000),
      }
      checkedIdentity(uid)
      try {
        await setDoc(doc(db, 'boardScenes', boardId, 'uploads', commitId), candidate)
      } catch (error) {
        // Rules reject stale expected heads during candidate creation. Distinguish that
        // narrow race from actual revocation instead of retrying permission errors blindly.
        if ((error as { code?: string }).code === 'permission-denied') {
          const latest = await sceneService.load(boardId)
          if (latest && latest.generation !== base.generation) throw new SceneGenerationError()
          if (latest && latest.revisionId !== base.revisionId) {
            await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** attempt))
            continue
          }
        }
        throw error
      }
      await inBatches(fresh, async (c, slot) => {
        checkedIdentity(uid)
        await setDoc(doc(db, 'boardScenes', boardId, 'chunks', c.chunkId), {
          payload: c.payload,
          digest: c.digest,
          uploadId: commitId,
          slot,
          uploaderUid: uid,
          generation: base.generation,
          kind: 'records',
        })
      })
      await inBatches(pages, async (references, i) => {
        checkedIdentity(uid)
        await setDoc(doc(db, 'boardScenes', boardId, 'uploads', commitId, 'pages', PAGE_ID(i)), { references })
      })
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
        assertHistoryMutationAllowed(boardId, editingEpoch)
        const receipt = await projectCall<Receipt>('commitBoardScene', { boardId, commitId })
        if (receipt.candidateDigest !== candidateDigest || receipt.generation !== base.generation)
          throw new Error('Invalid scene commit receipt.')
        forgetCandidate(uid, boardId)
        chunks.forEach((chunk) => cacheChunk(boardId, chunk))
        return {
          scene,
          chunks,
          revisionId: receipt.revisionId,
          generation: receipt.generation,
          restoreFence: base.restoreFence,
          historyProtocolVersion: base.historyProtocolVersion,
          boardName: base.boardName,
          nameRevision: base.nameRevision,
          currentVersionId: receipt.versionId ?? base.currentVersionId,
        }
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
