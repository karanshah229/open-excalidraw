import type { BoardScene } from '@agentic-whiteboard/storage'
import { doc, getDocFromServer, onSnapshot, setDoc, Timestamp, serverTimestamp } from 'firebase/firestore'
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
// Cache immutable payload bytes only. Every load first authorizes against a fresh head;
// account changes/permission failures discard cached entries. SDK access is never inferred from cache.
const chunkCache = new Map<string, PackedChunk>()
let cacheUser: string | undefined
const MAX_CACHED_BYTES = 32 * 1024 * 1024
let cachedBytes = 0
function clearSceneCache() {
  chunkCache.clear()
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
    try {
      let head = await getDocFromServer(doc(requireDb(), 'boardScenes', boardId))
      if (!head.exists()) return null
      if (head.data().headRevisionId === null) {
        await sceneService.ensure(boardId)
        head = await getDocFromServer(doc(requireDb(), 'boardScenes', boardId))
      }
      const data = head.data() as SceneHead
      if (!data.headRevisionId || data.sceneFormatVersion !== SCENE_FORMAT_VERSION)
        throw new Error('Unsupported board scene format.')
      const loaded = await readRevision(boardId, data.headRevisionId, data.generation)
      if (identity !== getFirebaseAuth()?.currentUser?.uid) throw new Error('Account changed while loading the board.')
      return loaded
    } catch (error) {
      clearSceneCache()
      throw error
    }
  },
  subscribeHead(boardId: string, onChange: () => void, onError?: (error: unknown) => void): () => void {
    const db = getFirestoreDb()
    if (!db) return () => {}
    return onSnapshot(doc(db, 'boardScenes', boardId), onChange, (error) => {
      clearSceneCache()
      onError?.(error)
    })
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
        return await readRevision(boardId, head.data()!.headRevisionId, receipt.generation)
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
      const db = requireDb()
      const createdAt = serverTimestamp()
      const candidate = {
        uploaderUid: uid,
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
        const receipt = await projectCall<Receipt>('commitBoardScene', { boardId, commitId })
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
