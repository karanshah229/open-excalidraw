import { boardHistoryStore, RxDbWorkspaceStore, setWorkspaceIdentity } from '@agentic-whiteboard/storage'
import type { Board, BoardDocument, HistorySaveOptions, Project } from '@agentic-whiteboard/storage'
import { collection, doc, getDoc, getDocs, onSnapshot, query, runTransaction, setDoc, where } from 'firebase/firestore'
import { getFirebaseAuth, getFirestoreDb } from '../../lib/firebase'
import { restoreSceneAssets, storeSceneAssets } from '../assets/scene-assets'
import { sharingService } from '../sharing/sharing-service'
import { projectService, type VisibleProject } from '../sharing/project-service'
import { sceneService, SceneGenerationError } from '../scenes/scene-service'
import { refreshHistoryFence, syncBoardHistory } from './history-sync'
import { readHistoryNotes, readHistorySnapshot } from '../history/history-service'
import { historyEditingState } from '../history/history-editing-gate'

export type WorkspaceBoard = Board & {
  project: VisibleProject
  inheritProjectAccess?: boolean
  isPrivate?: boolean
  role?: 'owner' | 'editor' | 'viewer' | 'presentation'
}
export const workspaceStore = new RxDbWorkspaceStore()
const workspaceRequests = new Map<string, Promise<{ projects: VisibleProject[]; boards: WorkspaceBoard[] }>>()
const deferredHistoryReads = new Map<string, { contextId: string; notesPageCount: number; generation: number }>()
const deferredNoteRequests = new Map<string, Promise<void>>()
const hydrationRequests = new Map<string, Promise<BoardDocument | null>>()
// React StrictMode and route remounts can issue the same initial hydration back-to-back.
// Reuse only the just-hydrated local copy; Firestore head changes invalidate it immediately.
const recentHydrations = new Map<string, { uid: string; activation: number; revisionId: string; generation: number; expiresAt: number }>()

let activeUserId: string | null = null
let activation = 0
const emitWorkspaceChange = () => window.dispatchEvent(new Event('workspace-changed'))
const archiveKey = (uid: string) => `project-archive:v1:${uid}`
function archivePreferences(uid: string): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(archiveKey(uid)) ?? '{}')
  } catch {
    return {}
  }
}
const isOwnerProject = (project: Project) => project.ownerId === (activeUserId ?? 'local-user')
let syncInFlight: Promise<void> | undefined
let syncTimer: number | undefined
let nextWriteAt = 0
const dirtyProjectIds = new Set<string>()
const projectListeners = new Map<string, () => void>()
let projectsListener: (() => void) | undefined
const deletedProjectIds = new Set<string>()
let projectUpdates = Promise.resolve()
const PROJECT_DELETED_MESSAGE =
  'This project was deleted. Local changes are retained. Restore the project to resume cloud sync.'
class DeletedProjectError extends Error {}
const isProjectDeleted = (data: Record<string, unknown> | undefined) =>
  Boolean(data && (data.active === false || data.deletedAt))

async function blockProjectSync(projectId: string) {
  deletedProjectIds.add(projectId)
  dirtyProjectIds.delete(projectId)
  projectListeners.get(projectId)?.()
  projectListeners.delete(projectId)
  const boards = (await workspaceStore.listBoardsForSync(true)).filter((board) => board.projectId === projectId)
  await Promise.all(
    boards.map(async (board) => {
      if (board.syncStatus === 'sync-blocked') return
      await workspaceStore.markBoardSyncBlocked(board.id, PROJECT_DELETED_MESSAGE)
      window.dispatchEvent(new CustomEvent(`board-sync:${board.id}`, { detail: 'sync-blocked' }))
    }),
  )
}

async function resumeProjectSync(projectId: string) {
  if (!deletedProjectIds.delete(projectId)) return
  const boards = (await workspaceStore.listBoardsForSync(true)).filter(
    (board) => board.projectId === projectId && board.syncStatus === 'sync-blocked',
  )
  await Promise.all(
    boards.map(async (board) => {
      await workspaceStore.resumeBoardSync(board.id)
      window.dispatchEvent(new CustomEvent(`board-sync:${board.id}`, { detail: 'local-only' }))
    }),
  )
  if (boards.length) queueSync()
}
const SYNC_DEBOUNCE_MS = 150
const MIN_WRITE_INTERVAL_MS = 1_000
const MAX_RETRY_DELAY_MS = 60_000

const NESTED_ARRAY_KEY = '_agenticWhiteboardNestedArray'

/**
 * Firestore rejects undefined at any depth and arrays nested inside other
 * arrays. Excalidraw uses nested point arrays for arrows and lines, so encode
 * only those inner arrays as maps and restore them when reading the cloud copy.
 */
export function firestoreValue(value: unknown, insideArray = false): unknown {
  if (Array.isArray(value)) {
    const normalized = value.filter((item) => item !== undefined).map((item) => firestoreValue(item, true))
    return insideArray ? { [NESTED_ARRAY_KEY]: normalized } : normalized
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        // Reset insideArray to false because Firestore permits arrays directly inside maps.
        .map(([key, item]) => [key, firestoreValue(item, false)]),
    )
  }
  return value
}

export function workspaceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(workspaceValue)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (
      entries.length === 1 &&
      (entries[0][0] === NESTED_ARRAY_KEY || entries[0][0] === '__agentic_whiteboard_nested_array__') &&
      Array.isArray(entries[0][1])
    ) {
      return entries[0][1].map(workspaceValue)
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, workspaceValue(item)]))
  }
  return value
}

function queueSync() {
  if (!activeUserId || syncTimer) return
  const delay = Math.max(SYNC_DEBOUNCE_MS, nextWriteAt - Date.now())
  syncTimer = window.setTimeout(() => {
    syncTimer = undefined
    void syncWorkspace(activeUserId!)
  }, delay)
}

const retryAt = (attempt: number) =>
  new Date(Date.now() + Math.min(1_000 * 2 ** attempt, MAX_RETRY_DELAY_MS)).toISOString()
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Cloud sync failed')

async function withSyncLock<T>(work: () => Promise<T>) {
  if ('locks' in navigator) return navigator.locks.request('agentic-whiteboard:sync', work)
  return work()
}

const cloudBoard = (board: BoardDocument): BoardDocument => {
  const revision = board.revision ?? 0
  return {
    ...board,
    syncStatus: 'synced',
    revision,
    // A committed cloud document is its own base for the next local edit.
    baseRevision: revision,
    syncAttempts: 0,
    nextSyncAt: null,
    lastSyncError: null,
  }
}

async function performWorkspaceSync(userId: string) {
  const generation = activation
  const db = getFirestoreDb()
  if (!db) return
  const [projects, boards] = await Promise.all([workspaceStore.listProjects(), workspaceStore.listBoardsForSync()])
  if (activation !== generation || activeUserId !== userId) return
  const now = new Date().toISOString()
  // Permanently blocked historical ancestry is retained for the user but must
  // not keep an otherwise-synced board in the cloud-sync loop.
  const historyPending = new Set((await boardHistoryStore.listOutbox())
    .filter((entry) => entry.retryState === 'pending')
    .map((entry) => entry.boardId))
  // A local-only marker can outlive its outbox entry (for example, after an
  // acknowledgement was committed but the RxDB projection was interrupted).
  // Every local content save and its outbox record are committed atomically, so
  // a cloud-bound board with no pending history has no unsynced content to send.
  // Reconcile this stale marker before selecting work; otherwise the worker
  // repeatedly registers the same scene and rewrites unchanged metadata.
  const settledBoardIds = new Set<string>()
  for (const board of boards) {
    if (board.syncStatus !== 'local-only' || historyPending.has(board.id) || !board.cloudRevisionId || board.cloudScenePending)
      continue
    await workspaceStore.markBoardSynced(board.id, board.revision)
    settledBoardIds.add(board.id)
  }
  const unsyncedBoards = boards.filter(
    (board) =>
      (!settledBoardIds.has(board.id) && (board.syncStatus === 'local-only' || board.syncStatus === 'sync-failed' ||
        (board.syncStatus === 'synced' && historyPending.has(board.id))) &&
      (!board.nextSyncAt || board.nextSyncAt <= now)),
  )
  const projectIds = new Set([...dirtyProjectIds, ...unsyncedBoards.map((board) => board.projectId)])

  for (const project of projects.filter((item) => projectIds.has(item.id))) {
    try {
      if (activation !== generation || activeUserId !== userId || project.ownerId !== userId) return
      const projectRef = doc(db, 'users', userId, 'projects', project.id)
      await runTransaction(db, async (transaction) => {
        const existing = await transaction.get(projectRef)
        if (!existing.exists()) transaction.set(projectRef, firestoreValue(project))
        else if (isProjectDeleted(existing.data())) throw new DeletedProjectError(PROJECT_DELETED_MESSAGE)
      })
      dirtyProjectIds.delete(project.id)
    } catch (error) {
      if (error instanceof DeletedProjectError) await blockProjectSync(project.id)
      else dirtyProjectIds.add(project.id)
    }
  }

  for (const board of unsyncedBoards) {
    if (deletedProjectIds.has(board.projectId)) {
      await blockProjectSync(board.projectId)
      continue
    }
    if (generation !== activation || activeUserId !== userId) return
    const wait = Math.max(0, nextWriteAt - Date.now())
    if (wait) await new Promise<void>((resolve) => window.setTimeout(resolve, wait))
    nextWriteAt = Date.now() + MIN_WRITE_INTERVAL_MS
    let saveGeneration: number | undefined
    try {
      await withSyncLock(async () => {
        const current = await workspaceStore.loadBoard(board.id)
        if (!current || (current.syncStatus !== 'local-only' && current.syncStatus !== 'sync-failed' &&
          !(current.syncStatus === 'synced' && historyPending.has(current.id)))) return
        if (current.cloudScenePending) throw new Error('Load the complete board before saving. Your draft is retained.')
        saveGeneration = current.cloudGeneration ?? 1
        const ref = doc(db, 'users', userId, 'projects', current.projectId, 'boards', current.id)
        // Metadata establishes ownership; it never carries the scene payload.
        await runTransaction(db, async (transaction) => {
          const parent = await transaction.get(doc(db, 'users', userId, 'projects', current.projectId))
          if (!parent.exists() || isProjectDeleted(parent.data()))
            throw new DeletedProjectError(PROJECT_DELETED_MESSAGE)
          const remote = await transaction.get(ref)
          if (remote.exists() && remote.data().active === false && current.active) throw new Error('Board was deleted.')
          // A tombstone already present in Firestore is terminal. Updating it
          // again is denied by the rules (updates require resource.active),
          // and retrying that write only creates a permanent 403 loop.
          if (!current.active && (!remote.exists() || remote.data().active === false)) return
          const { scene: _scene, ...metadata } = cloudBoard(current)
          // Preserve legacy payload until trusted registration migrates both copies.
          const { name: _name, ...remainingMetadata } = metadata
          transaction.set(ref, firestoreValue({ ...(remote.exists() ? remainingMetadata : metadata), sceneId: current.id }) as Record<string, unknown>, {
            merge: true,
          })
        })
        if (generation !== activation || activeUserId !== userId) return
        if (!current.active) {
          await workspaceStore.markBoardSynced(current.id, current.revision)
          return
        }
        await sceneService.ensure(current.id, current.projectId)
        const assetRoot = `users/${userId}/boards/${current.id}/assets`
        let expectedCloudRevisionId = current.cloudRevisionId
        const result = await syncBoardHistory({
          boardId: current.id, projectId: current.projectId, assetRoot,
          applyLegacyName: async (snapshot) => {
            if (generation !== activation || activeUserId !== userId) throw new Error('Account changed during sync.')
            await setDoc(ref, { name: snapshot.document.name }, { merge: true })
          },
          applyHead: async (snapshot, entry) => {
            expectedCloudRevisionId = (await boardHistoryStore.getCommittedContent(current.id))?.document.cloudRevisionId
            return sceneService.commit(current.id, snapshot.document.scene, {
              expectedGeneration: entry.generation, expectedFence: entry.expectedFence,
            })
          },
        })
        if (!result) return
        if (generation !== activation || activeUserId !== userId) return
        const restored = await restoreSceneAssets(result.scene, current.scene.files, result.readContextId)
        await workspaceStore.acknowledgeBoardScene(
          current.id,
          current.revision,
          restored,
          result.revisionId,
          result.generation,
          { expectedCloudRevisionId, cloudVersionId: result.currentVersionId ?? undefined,
            cloudRestoreFence: result.restoreFence, cloudNameRevision: result.nameRevision, cloudBoardName: result.boardName },
        )
        const resolvedBoard = (await workspaceStore.loadBoard(current.id))!
        window.dispatchEvent(new CustomEvent(`board-sync:${resolvedBoard.id}`, { detail: resolvedBoard.syncStatus }))
      })
    } catch (error) {
      if (generation !== activation || activeUserId !== userId) return
      if (error instanceof SceneGenerationError) {
        await workspaceStore.markBoardConflict(board.id, error.message, saveGeneration)
        const latest = await workspaceStore.loadBoard(board.id)
        if (generation === activation && activeUserId === userId)
          window.dispatchEvent(new CustomEvent(`board-sync:${board.id}`, { detail: latest?.syncStatus ?? 'conflict' }))
        continue
      }
      // The project can be deleted between the metadata write and image upload.
      const permissionDenied = (error as { code?: string })?.code === 'functions/permission-denied'
      let deleted = error instanceof DeletedProjectError || deletedProjectIds.has(board.projectId)
      if (!deleted && permissionDenied) {
        try {
          deleted = isProjectDeleted((await getDoc(doc(db, 'users', userId, 'projects', board.projectId))).data())
        } catch {
          /* Keep transient/auth failures on the normal retry path. */
        }
      }
      if (deleted) {
        await blockProjectSync(board.projectId)
        continue
      }
      const current = await workspaceStore.loadBoard(board.id)
      const nextAttempt = (current?.syncAttempts ?? 0) + 1
      await workspaceStore.markBoardSyncFailed(board.id, errorMessage(error), retryAt(nextAttempt))
      window.dispatchEvent(new CustomEvent(`board-sync:${board.id}`, { detail: 'sync-failed' }))
    }
  }

  const remaining = await workspaceStore.listBoardsForSync()
  // A save can arrive after this run captured its board list or while its
  // acknowledgement was in flight. A timer consumed by that run must not
  // strand the newer revision in IndexedDB.
  if (remaining.some((board) => board.syncStatus === 'local-only' && !board.nextSyncAt)) queueSync()
  const pending = remaining
    .filter((board) => (board.syncStatus === 'local-only' || board.syncStatus === 'sync-failed') && board.nextSyncAt)
    .map((board) => new Date(board.nextSyncAt!).getTime())
  if (pending.length) {
    const earliest = Math.min(...pending)
    window.setTimeout(queueSync, Math.max(0, earliest - Date.now()))
  }
}

async function syncWorkspace(userId: string) {
  if (syncInFlight) {
    await syncInFlight
    return
  }
  syncInFlight = performWorkspaceSync(userId).finally(() => {
    syncInFlight = undefined
  })
  await syncInFlight
}

function subscribeToRemoteWorkspace(userId: string) {
  const generation = activation
  const db = getFirestoreDb()
  if (!db || projectsListener) return
  projectsListener = onSnapshot(collection(db, 'users', userId, 'projects'), (snapshot) => {
    projectUpdates = projectUpdates
      .catch(console.error)
      .then(async () => {
        if (generation !== activation || activeUserId !== userId) return
        for (const projectSnapshot of snapshot.docs) {
          if (generation !== activation || activeUserId !== userId) return
          const stored = projectSnapshot.data() as Project
          const project: Project = { ...stored, id: projectSnapshot.id, ownerId: userId }
          if (!project.deletedAt && (stored.ownerId !== userId || stored.id !== project.id))
            void projectService
              .manage(project.id, 'repair')
              .catch((error) => console.error('Legacy project repair failed:', error))
          await workspaceStore.upsertProject(project)
          if (generation !== activation || activeUserId !== userId) return
          emitWorkspaceChange()
          if (isProjectDeleted(project)) {
            if (!deletedProjectIds.has(project.id)) await blockProjectSync(project.id)
            continue
          }
          await resumeProjectSync(project.id)
          if (projectListeners.has(project.id)) continue
          projectListeners.set(
            project.id,
            onSnapshot(
              query(collection(db, 'users', userId, 'projects', project.id, 'boards'), where('active', '==', true)),
              (boardSnapshot) => {
                if (generation !== activation || activeUserId !== userId || deletedProjectIds.has(project.id)) return
                for (const change of boardSnapshot.docChanges()) {
                  const boardDocument = change.doc
                  const remote = {
                    ...(workspaceValue(boardDocument.data()) as BoardDocument),
                    id: boardDocument.id,
                    projectId: project.id,
                    active: change.type === 'removed' ? false : true,
                  }
                  void (async () => {
                    if (generation !== activation || activeUserId !== userId || deletedProjectIds.has(project.id))
                      return
                    // Workspace discovery stays metadata-only. Large scenes are loaded on open,
                    // or explicitly for export; listing must not fan out into chunk downloads.
                    await workspaceStore.upsertBoardMetadata(
                      cloudBoard({
                        ...remote,
                        cloudScenePending: Boolean(
                          (remote as BoardDocument & { sceneId?: string }).sceneId || !remote.scene,
                        ),
                        scene: (remote as BoardDocument & { sceneId?: string }).sceneId
                          ? { elements: [], appState: {} }
                          : (remote.scene ?? { elements: [], appState: {} }),
                        formatVersion: 1,
                      }),
                    )
                    emitWorkspaceChange()
                  })().catch((error) => {
                    console.error(`Failed to restore cloud board ${remote.id}:`, error)
                    window.dispatchEvent(new CustomEvent(`board-sync:${remote.id}`, { detail: 'sync-failed' }))
                  })
                }
              },
            ),
          )
        }
      })
      .catch(console.error)
  })
}

const sharedHistoryRetry = new Map<string, number>()
const sharedHistoryRetryAttempts = new Map<string, number>()
const retryableHistoryOutbox = (entries: Awaited<ReturnType<typeof boardHistoryStore.listOutbox>>) =>
  entries.some((entry) => entry.retryState === 'pending')
function clearSharedHistoryRetry(boardId: string) {
  const retry = sharedHistoryRetry.get(boardId)
  if (retry) window.clearTimeout(retry)
  sharedHistoryRetry.delete(boardId)
}
function scheduleSharedHistoryRetry(boardId: string) {
  if (sharedHistoryRetry.has(boardId)) return
  const attempt = sharedHistoryRetryAttempts.get(boardId) ?? 0
  const delay = Math.min(15_000 * 2 ** attempt, 5 * 60_000)
  sharedHistoryRetryAttempts.set(boardId, Math.min(attempt + 1, 5))
  sharedHistoryRetry.set(boardId, window.setTimeout(() => {
    sharedHistoryRetry.delete(boardId)
    void flushSharedHistory(boardId)
  }, delay))
}
async function flushSharedHistory(boardId: string) {
  if (!getFirebaseAuth()?.currentUser || !navigator.onLine || historyEditingState(boardId).blocked) return
  const queued = await boardHistoryStore.listOutbox(boardId)
  if (!retryableHistoryOutbox(queued)) {
    clearSharedHistoryRetry(boardId)
    sharedHistoryRetryAttempts.delete(boardId)
    return
  }
  const current = await boardHistoryStore.getCommittedContent(boardId)
  if (!current) return
  // A guest editor can have a local shadow of a shared board after opening it.
  // Route only genuinely owned boards through workspace sync; otherwise the
  // local shadow would keep diverting its history outbox and shared renames
  // would never reach updateBoardContent.
  const local = await workspaceStore.loadBoard(boardId)
  if (local) {
    const ownedProject = (await workspaceStore.listProjects(true)).find((project) => project.id === local.projectId)
    if (ownedProject?.ownerId === getFirebaseAuth()?.currentUser?.uid) {
      queueSync()
      return
    }
  }
  try {
    await syncBoardHistory({ boardId, projectId: current.document.projectId, assetRoot: `boards/${boardId}/assets` })
    clearSharedHistoryRetry(boardId)
    window.dispatchEvent(new CustomEvent(`board-sync:${boardId}`, { detail: 'synced' }))
    if (retryableHistoryOutbox(await boardHistoryStore.listOutbox(boardId))) scheduleSharedHistoryRetry(boardId)
    else sharedHistoryRetryAttempts.delete(boardId)
  } catch (error) {
    if (historyEditingState(boardId).blocked) return
    console.error('Shared board history sync paused:', error)
    window.dispatchEvent(new CustomEvent(`board-sync:${boardId}`, { detail: 'sync-failed' }))
    if (retryableHistoryOutbox(await boardHistoryStore.listOutbox(boardId))) scheduleSharedHistoryRetry(boardId)
  }
}
window.addEventListener('board-history-local-save', (event) => {
  const boardId = (event as CustomEvent<{ boardId: string }>).detail?.boardId
  if (boardId) void flushSharedHistory(boardId)
})
window.addEventListener('board-history-fence-refreshed', (event) => {
  const detail = (event as CustomEvent<{ boardId: string; generation: number; restoreFence: number }>).detail
  if (!detail || !navigator.onLine) return
  void refreshHistoryFence(detail.boardId, detail.generation, detail.restoreFence)
    .then(() => flushSharedHistory(detail.boardId))
    .catch((error) => console.error('History fence recovery paused:', error))
})
window.addEventListener('online', () => {
  queueSync()
  void boardHistoryStore.listOutbox().then((entries) => {
    for (const boardId of new Set(entries.map((entry) => entry.boardId))) void flushSharedHistory(boardId)
  })
})

const hydrationVersions = new Map<string, number>()
async function hydrateBoardOnOpenOnce(boardId: string): Promise<BoardDocument | null> {
  const loadVersion = (hydrationVersions.get(boardId) ?? 0) + 1
  hydrationVersions.set(boardId, loadVersion)
  const userId = activeUserId
  const currentActivation = activation
  const local = await workspaceStore.loadBoard(boardId)
  if (!local?.active || !userId || !getFirestoreDb()) return local
  // A project tombstone intentionally denies scene/asset reads. Keep the owner's
  // retained local draft available in the explicit read-only deleted-project view.
  if (local.syncStatus === 'sync-blocked') return local
  if (deletedProjectIds.has(local.projectId)) {
    await blockProjectSync(local.projectId)
    return workspaceStore.loadBoard(boardId)
  }
  const localProject = (await workspaceStore.listProjects(true)).find((project) => project.id === local.projectId)
  if (currentActivation !== activation || userId !== activeUserId) return null
  if (localProject && isProjectDeleted(localProject as unknown as Record<string, unknown>)) {
    await blockProjectSync(local.projectId)
    return workspaceStore.loadBoard(boardId)
  }
  if (!navigator.onLine) {
    if (local.cloudScenePending) throw new Error('Connect to download this board before editing it offline.')
    return local
  }
  let canonical
  try {
    canonical = await sceneService.load(boardId)
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    if (!local.cloudScenePending && ['unavailable', 'deadline-exceeded'].includes(code)) return local
    // The parent can be deleted while the page is closed or during chunk fetch.
    // Only the verified owner gets this local recovery path; other access denials stay denied.
    if ((code === 'permission-denied' || code === 'functions/permission-denied') && localProject?.ownerId === userId) {
      try {
        const parent = await getDoc(doc(getFirestoreDb()!, 'users', userId, 'projects', local.projectId))
        if (currentActivation !== activation || userId !== activeUserId) return null
        if (parent.exists() && isProjectDeleted(parent.data())) {
          await workspaceStore.upsertProject({ ...parent.data(), id: local.projectId, ownerId: userId } as Project)
          await blockProjectSync(local.projectId)
          return workspaceStore.loadBoard(boardId)
        }
      } catch {
        // Preserve the original authorization error for unrelated revocations or transport failures.
      }
    }
    throw error
  }
  if (currentActivation !== activation || userId !== activeUserId) return null
  if (hydrationVersions.get(boardId) !== loadVersion) return workspaceStore.loadBoard(boardId)
  if (!canonical) {
    if (local.cloudScenePending) throw new Error('Board scene is not available yet. Retry loading before editing.')
    return local // Legacy migration is performed on the next owner sync.
  }
  if (canonical.historyProtocolVersion === 1 && canonical.readContextId && canonical.notesPageCount !== undefined) {
    deferredHistoryReads.set(boardId, {
      contextId: canonical.readContextId,
      notesPageCount: canonical.notesPageCount,
      generation: canonical.generation,
    })
  }
  const scene = await restoreSceneAssets(canonical.scene, local.scene.files, canonical.readContextId)
  if (currentActivation !== activation || userId !== activeUserId) return null
  if (hydrationVersions.get(boardId) !== loadVersion) return workspaceStore.loadBoard(boardId)
  // Protocol 0 has no complete protected-note gateway. Its absence is not an
  // empty remote snapshot and must not erase notes already saved on this device.
  const knownLocal = await boardHistoryStore.getCommittedContent(boardId)
  if (canonical.historyProtocolVersion === 1 && knownLocal && canonical.currentVersionId &&
    (knownLocal.document.cloudGeneration === undefined ||
      (canonical.generation === knownLocal.document.cloudGeneration &&
        (canonical.restoreFence ?? 0) === (knownLocal.document.cloudRestoreFence ?? 0))))
    await boardHistoryStore.repairLegacyCloudLineage(boardId, { generation: canonical.generation,
      restoreFence: canonical.restoreFence ?? 0, currentVersionId: canonical.currentVersionId,
      cloudRevisionId: canonical.revisionId })
  const notes = knownLocal?.notes ?? {}
  const nextCloud = { ...local, scene, cloudRevisionId: canonical.revisionId,
    cloudGeneration: canonical.generation,
    cloudVersionId: canonical.currentVersionId ?? undefined, cloudRestoreFence: canonical.restoreFence ?? 0,
    cloudNameRevision: canonical.nameRevision, cloudScenePending: false }
  if (nextCloud.cloudGeneration > (local.cloudGeneration ?? 1)) {
    await boardHistoryStore.applyCloudRestore({ ...nextCloud, name: canonical.boardName ?? local.name,
      syncStatus: 'synced' }, { notes, restoreFence: canonical.restoreFence ?? 0,
      currentVersionId: canonical.currentVersionId ?? undefined })
  } else {
    await workspaceStore.applyCloudBoardScene(boardId, scene, nextCloud.cloudRevisionId, nextCloud.cloudGeneration, {
      expectedCloudRevisionId: local.cloudRevisionId,
      legacyGenerationAdvance: !canonical.historyProtocolVersion,
      cloudVersionId: nextCloud.cloudVersionId,
      cloudRestoreFence: nextCloud.cloudRestoreFence,
      cloudNameRevision: nextCloud.cloudNameRevision,
      cloudBoardName: canonical.boardName,
    })
    const hydrated = await workspaceStore.loadBoard(boardId)
    if (hydrated) {
      const pending = await boardHistoryStore.listOutbox(boardId)
      const document = { ...hydrated, cloudVersionId: nextCloud.cloudVersionId,
        cloudRestoreFence: nextCloud.cloudRestoreFence, cloudNameRevision: nextCloud.cloudNameRevision,
        name: pending.some((entry) => !entry.headAcknowledged && entry.changedFields.name)
          ? hydrated.name : canonical.boardName ?? hydrated.name }
      if (!(await boardHistoryStore.getCommittedContent(boardId))) await boardHistoryStore.initialize(document, notes)
      else {
        await boardHistoryStore.reconcileDocument(document)
      }
    }
  }
  // Current-content ACKs do not imply immutable history capture ACKs.
  // Opening a board after a server rollout must wake the retained outbox too.
  if ((await boardHistoryStore.listOutbox(boardId)).length) queueSync()
  return workspaceStore.loadBoard(boardId)
}

async function hydrateBoardOnOpen(boardId: string, expectedHeadRevisionId?: string): Promise<BoardDocument | null> {
  const active = hydrationRequests.get(boardId)
  if (active) {
    const result = await active
    if (!expectedHeadRevisionId || result?.cloudRevisionId === expectedHeadRevisionId) return result
  }
  const cached = recentHydrations.get(boardId)
  if (cached && cached.uid === (activeUserId ?? 'guest') && cached.activation === activation && cached.expiresAt > Date.now()) {
    const local = await workspaceStore.loadBoard(boardId)
    if (local?.cloudRevisionId === cached.revisionId && local.cloudGeneration === cached.generation &&
      (!expectedHeadRevisionId || local.cloudRevisionId === expectedHeadRevisionId)) return local
    recentHydrations.delete(boardId)
  }
  const request = hydrateBoardOnOpenOnce(boardId).finally(() => {
    if (hydrationRequests.get(boardId) === request) hydrationRequests.delete(boardId)
  })
  hydrationRequests.set(boardId, request)
  void request.then((document) => {
    if (document?.cloudRevisionId && document.cloudGeneration !== undefined)
      recentHydrations.set(boardId, {
        uid: activeUserId ?? 'guest', activation, revisionId: document.cloudRevisionId,
        generation: document.cloudGeneration, expiresAt: Date.now() + 2000,
      })
  })
  return request
}

/** Called after the editor mounts; note history is not on the drawing critical path. */
export function loadDeferredCloudNotes(boardId: string): Promise<void> {
  const active = deferredNoteRequests.get(boardId)
  if (active) return active
  const pending = deferredHistoryReads.get(boardId)
  if (!pending || !navigator.onLine) return Promise.resolve()
  const request = (async () => {
    try {
      const snapshot = await readHistoryNotes(boardId, pending.contextId, pending.notesPageCount)
      const current = await boardHistoryStore.getCommittedContent(boardId)
      if (!current) {
        // The board's scene was already downloaded on the drawing path. Seed
        // local version history from that durable copy and fetch only notes;
        // re-reading the full scene manifest/chunks here delayed first paint.
        const local = await workspaceStore.loadBoard(boardId)
        if (!local || local.cloudGeneration !== pending.generation || !local.cloudRevisionId) return
        await boardHistoryStore.initialize(local, snapshot.notes)
      } else {
        if (current.document.cloudGeneration !== pending.generation) return
        await boardHistoryStore.reconcileCloudNotes(boardId, snapshot.notes)
      }
      if (deferredHistoryReads.get(boardId) === pending) deferredHistoryReads.delete(boardId)
    } catch (error) {
      console.warn('Deferred speaker-note history load paused:', error)
    }
  })().finally(() => {
    if (deferredNoteRequests.get(boardId) === request) deferredNoteRequests.delete(boardId)
  })
  deferredNoteRequests.set(boardId, request)
  return request
}

export const workspaceApi = {
  loadDeferredCloudNotes,
  listWorkspace(projectId?: string): Promise<{ projects: VisibleProject[]; boards: WorkspaceBoard[] }> {
    const uid = activeUserId,
      generation = activation
    const key = `${generation}:${uid ?? 'guest'}:${projectId ?? 'all'}`
    const existing = workspaceRequests.get(key)
    if (existing) return existing
    const request = (async () => {
      const db = getFirestoreDb()
      // Independent metadata sources start together; no board drawings are fetched for policies.
      const [shared, preferences] = await Promise.all([
        db && navigator.onLine
          ? projectService.list(projectId, Boolean(uid))
          : Promise.resolve({ projects: [], boards: [] }),
        db && uid && navigator.onLine
          ? getDocs(collection(db, 'users', uid, 'projectPreferences'))
          : Promise.resolve(null),
        workspaceStore.bootstrap(),
      ])
      if (generation !== activation || uid !== activeUserId) return { projects: [], boards: [] }
      const personalArchives = archivePreferences(uid ?? 'local-user')
      for (const preference of preferences?.docs ?? [])
        personalArchives[preference.id] = preference.data().archived === true
      const policies = 'ownedPolicies' in shared ? shared.ownedPolicies : undefined
      const projectPolicies = new Map(policies?.projects.map((policy) => [policy.projectId, policy]))
      const boardPolicies = new Map(policies?.boards.map((policy) => [policy.boardId, policy]))
      const projects: VisibleProject[] = (await workspaceStore.listProjects())
        .filter((project) => (uid || !projectId) && !deletedProjectIds.has(project.id))
        .map((project) => {
          const policy = projectPolicies.get(project.id)
          return {
            ...project,
            role: 'owner' as const,
            archived: personalArchives[project.id] === true,
            sharePolicy: policy ?? {
              generalAccess: 'restricted',
              generalRole: 'viewer',
              collaborators: {},
              invitedEmails: [],
            },
            isShared: Boolean(policy && (policy.generalAccess === 'anyone_with_link' || policy.invitedEmails?.length)),
          }
        })
      const groups = await Promise.all(projects.map((project) => workspaceStore.listBoards(project.id)))
      if (generation !== activation || uid !== activeUserId) return { projects: [], boards: [] }
      const boards: WorkspaceBoard[] = groups.flatMap((group, index) =>
        group.map((board) => {
          const project = projects[index],
            policy = boardPolicies.get(board.id)
          // Only seed a verified default after the metadata request completed successfully.
          if (policies)
            sharingService.rememberShareConfig(
              {
                ...(policy ?? {
                  boardId: board.id,
                  projectId: project.id,
                  boardName: board.name,
                  ownerId: uid ?? 'local-user',
                  ownerName: '',
                  createdAt: board.createdAt,
                  updatedAt: board.updatedAt,
                  generalAccess: 'restricted',
                  generalRole: 'viewer',
                  collaborators: {},
                  invitedEmails: [],
                  inheritProjectAccess: true,
                }),
                projectPolicy: project.sharePolicy,
              },
              uid ?? 'local-user',
            )
          return {
            ...board,
            project,
            role: 'owner' as const,
            inheritProjectAccess: policy?.inheritProjectAccess !== false,
            isPrivate:
              policy?.inheritProjectAccess === false &&
              policy.generalAccess === 'restricted' &&
              !policy.invitedEmails?.length,
          }
        }),
      )
      for (const project of shared.projects) {
        if (projects.some((owned) => owned.id === project.id)) continue
        project.archived = personalArchives[project.id] === true
        projects.push(project)
        boards.push(
          ...shared.boards.filter((board) => board.projectId === project.id).map((board) => ({ ...board, project })),
        )
      }
      return { projects, boards }
    })()
    workspaceRequests.set(key, request)
    void request
      .finally(() => {
        if (workspaceRequests.get(key) === request) workspaceRequests.delete(key)
      })
      .catch(() => {})
    return request
  },
  async flushCloud() {
    if (!activeUserId) return
    if (!navigator.onLine) throw new Error('Connect to the internet to update cloud projects and sharing.')
    await syncWorkspace(activeUserId)
    await syncWorkspace(activeUserId)
  },
  async renameProject(projectId: string, name: string) {
    const local = (await workspaceStore.listProjects()).find((project) => project.id === projectId)
    const project: VisibleProject | undefined =
      local ?? (await projectService.list(projectId)).projects.find((project) => project.id === projectId)
    if (!project || (!isOwnerProject(project) && project.role !== 'editor'))
      throw new Error('Project editor access required.')
    if (!isOwnerProject(project)) {
      await projectService.manage(projectId, 'rename', { name })
      emitWorkspaceChange()
      return
    }
    if (getFirestoreDb()) {
      const parent = await getDoc(doc(getFirestoreDb()!, 'users', activeUserId!, 'projects', projectId))
      if (!parent.exists()) await workspaceApi.flushCloud()
      await projectService.manage(projectId, 'rename', { name })
    }
    await workspaceStore.upsertProject({ ...project, name: name.trim(), updatedAt: new Date().toISOString() })
    emitWorkspaceChange()
  },
  async archiveProject(projectId: string, archived: boolean) {
    const db = getFirestoreDb()
    if (!db || !activeUserId) throw new Error('Sign in to archive projects.')
    const preferences = archivePreferences(activeUserId)
    localStorage.setItem(archiveKey(activeUserId), JSON.stringify({ ...preferences, [projectId]: archived }))
    const pending = setDoc(doc(db, 'users', activeUserId, 'projectPreferences', projectId), { archived })
    emitWorkspaceChange()
    if (navigator.onLine) {
      try {
        await pending
      } catch (error) {
        localStorage.setItem(archiveKey(activeUserId), JSON.stringify(preferences))
        emitWorkspaceChange()
        throw error
      }
    } else void pending.catch((error) => console.error('Archive preference sync failed:', error))
  },
  async deleteProject(projectId: string) {
    const local = (await workspaceStore.listProjects()).find((project) => project.id === projectId)
    const project: VisibleProject | undefined =
      local ?? (await projectService.list(projectId)).projects.find((project) => project.id === projectId)
    if (!project || (!isOwnerProject(project) && project.role !== 'editor'))
      throw new Error('Project editor access required.')
    if (!isOwnerProject(project)) {
      await projectService.manage(projectId, 'delete')
      emitWorkspaceChange()
      return
    }
    await workspaceApi.flushCloud()
    await projectService.manage(projectId, 'delete')
    await workspaceStore.upsertProject({ ...project, deletedAt: new Date().toISOString() })
    emitWorkspaceChange()
  },
  async createBoard(projectId: string, name: string) {
    const project = (await workspaceApi.listWorkspace()).projects.find((project) => project.id === projectId)
    if (project?.isShared) {
      const board = await projectService.createBoard(projectId, name)
      if (isOwnerProject(project)) await workspaceStore.upsertBoard(board)
      emitWorkspaceChange()
      return board
    }
    const board = await workspaceStore.createBoard(projectId, name)
    queueSync()
    return board
  },
  async createProject(name: string) {
    const project = await workspaceStore.createProject(name, activeUserId ?? 'local-user')
    dirtyProjectIds.add(project.id)
    queueSync()
    return project
  },
  async deleteBoard(boardId: string) {
    const board = await workspaceStore.loadBoard(boardId)
    if (!board) throw new Error('Only the owner can delete a board.')
    if (getFirestoreDb()) {
      await workspaceApi.flushCloud()
      await projectService.boardAccess(boardId, board.projectId, 'delete')
    }
    await workspaceStore.deleteBoard(boardId)
    queueSync()
  },
  async loadBoard(boardId: string): Promise<BoardDocument | null> {
    const document = await workspaceStore.loadBoard(boardId)
    return document?.active ? document : null
  },
  async loadBoardWithProject(boardId: string): Promise<{ document: BoardDocument; project: Project } | null> {
    await workspaceStore.bootstrap()
    const document = await hydrateBoardOnOpen(boardId)
    if (!document?.active) return null
    const projects = await workspaceStore.listProjects(true)
    const project = projects.find((p) => p.id === document.projectId) || {
      id: document.projectId,
      name: 'Project',
      ownerId: '',
      members: [],
      createdAt: '',
      updatedAt: '',
    }
    return { document, project }
  },
  async renameBoard(boardId: string, name: string, options: { nameRevision?: number; expectedFence?: number } = {}): Promise<BoardDocument | null> {
    await workspaceStore.bootstrap()
    const document = await workspaceStore.loadBoard(boardId)
    if (!document?.active) return null
    const ownedProject = (await workspaceStore.listProjects(true)).find((project) => project.id === document.projectId)
    // Shared editors can have a local board shadow, but they must publish the
    // rename through the board-history gateway instead of the owner workspace
    // outbox. Returning null lets the editor route capture the local version
    // and issue the authorized updateBoardContent call with its CAS tokens.
    if (!ownedProject || ownedProject.ownerId !== (activeUserId ?? 'local-user')) return null
    const trimmed = name.trim() || 'Untitled'
    const updated: BoardDocument = {
      ...document,
      name: trimmed,
    }
    return workspaceApi.saveBoard(updated, {
      reason: 'rename', changedFields: { name: true },
      expectedFence: options.expectedFence ?? document.cloudRestoreFence,
      fieldBases: { nameRevision: options.nameRevision ?? document.cloudNameRevision },
    })
  },
  async saveBoard(document: BoardDocument, options: HistorySaveOptions = {}) {
    try {
      if (document.cloudScenePending) throw new Error('Load the complete board before saving.')
      const saved = await workspaceStore.saveBoard(document, options)
      emitWorkspaceChange()
      if (deletedProjectIds.has(saved.projectId)) {
        await blockProjectSync(saved.projectId)
        return (await workspaceStore.loadBoard(saved.id))!
      }
      queueSync()
      return saved
    } catch (error) {
      if (error instanceof Error && error.message === 'BOARD_REVISION_CONFLICT') {
        window.dispatchEvent(new CustomEvent(`board-sync:${document.id}`, { detail: 'conflict' }))
      }
      throw error
    }
  },
  async keepLocalConflict(boardId: string) {
    const db = getFirestoreDb()
    const local = await workspaceStore.loadBoard(boardId)
    if (!local) return
    let remoteRevision = local.baseRevision
    if (db && activeUserId) {
      const remote = await getDoc(doc(db, 'users', activeUserId, 'projects', local.projectId, 'boards', boardId))
      if (remote.exists() && remote.data().active === true) remoteRevision = Number(remote.data().revision ?? 0)
    }
    await workspaceStore.requeueConflictedBoard(boardId, remoteRevision)
    window.dispatchEvent(new CustomEvent(`board-sync:${boardId}`, { detail: 'local-only' }))
    queueSync()
  },
  async activateCloudWorkspace(userId: string) {
    if (activeUserId === userId) return
    workspaceApi.deactivateCloudWorkspace()
    activeUserId = userId
    setWorkspaceIdentity(userId)
    const generation = activation
    await workspaceStore.bootstrap()
    if (activation !== generation || activeUserId !== userId) return
    for (const board of await workspaceStore.listBoardsForSync(true)) {
      if (board.syncStatus === 'sync-blocked') deletedProjectIds.add(board.projectId)
    }
    const claimedProjectIds = await workspaceStore.claimLocalProjects(userId)
    claimedProjectIds.forEach((projectId) => dirtyProjectIds.add(projectId))
    subscribeToRemoteWorkspace(userId)
    emitWorkspaceChange()
    const boards = await workspaceStore.listBoardsForSync()
    const historyPending = (await boardHistoryStore.listOutbox())
      .filter((entry) => entry.retryState === 'pending')
    if (activation !== generation || activeUserId !== userId) return
    if (
      boards.some((board) => board.syncStatus === 'local-only' || board.syncStatus === 'sync-failed') ||
      historyPending.length || dirtyProjectIds.size
    )
      queueSync()
  },
  deactivateCloudWorkspace() {
    activation++
    hydrationVersions.clear()
    recentHydrations.clear()
    deferredHistoryReads.clear()
    if (syncTimer) window.clearTimeout(syncTimer)
    syncTimer = undefined
    dirtyProjectIds.clear()
    deletedProjectIds.clear()
    activeUserId = null
    for (const retry of sharedHistoryRetry.values()) window.clearTimeout(retry)
    sharedHistoryRetry.clear()
    sharedHistoryRetryAttempts.clear()
    setWorkspaceIdentity(null)
    emitWorkspaceChange()
    for (const unsubscribe of projectListeners.values()) unsubscribe()
    projectListeners.clear()
    projectsListener?.()
    projectsListener = undefined
  },
  subscribeToCloudScene(
    boardId: string,
    onUpdate: (document: BoardDocument) => void,
    onError?: (error: unknown) => void,
  ) {
    let disposed = false
    let version = 0
    const uid = activeUserId
    const active = activation
    const unsubscribe = sceneService.subscribeHead(
      boardId,
      (head) => {
        const read = ++version
        // A restore locks the head before publishing replacement content. The
        // editor's restore gate handles this interval; hydrating the locked
        // head would create a guaranteed aborted history read.
        if (head?.restoreOperationId) return
        // Firestore also emits metadata-only and local echoes. If the scene,
        // generation, name, and restore fence match the applied copy, there is
        // nothing to hydrate and no reason to re-read manifest/chunks.
        void workspaceStore.loadBoard(boardId).then((current) => {
          if (disposed || read !== version || !current || !head) return
          const recent = recentHydrations.get(boardId)
          if (recent && (recent.revisionId !== head.headRevisionId || recent.generation !== head.generation))
            recentHydrations.delete(boardId)
          if (
            current.cloudRevisionId === head.headRevisionId &&
            current.cloudGeneration === head.generation &&
            current.cloudNameRevision === head.nameRevision &&
            current.cloudRestoreFence === head.restoreFence
          ) return
          return hydrateBoardOnOpen(boardId, head.headRevisionId).then((document) => {
            if (!disposed && read === version && active === activation && uid === activeUserId && document) {
              onUpdate(document)
              if (document.syncStatus === 'local-only') queueSync()
            }
          })
        }).catch((error) => {
          if (!disposed && read === version) onError?.(error)
        })
      },
      onError,
    )
    return () => {
      disposed = true
      version++
      unsubscribe()
    }
  },
  subscribeToBoardSyncStatus(boardId: string, listener: (status: Board['syncStatus']) => void) {
    const eventName = `board-sync:${boardId}`
    const handler = (event: Event) => listener((event as CustomEvent<Board['syncStatus']>).detail)
    window.addEventListener(eventName, handler)
    return () => window.removeEventListener(eventName, handler)
  },
}
