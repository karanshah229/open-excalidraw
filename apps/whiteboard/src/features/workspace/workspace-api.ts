import { RxDbWorkspaceStore } from '@agentic-whiteboard/storage'
import type { Board, BoardDocument, Project } from '@agentic-whiteboard/storage'
import { collection, doc, getDoc, getDocs, onSnapshot, query, runTransaction, setDoc, where } from 'firebase/firestore'
import { getFirestoreDb } from '../../lib/firebase'

export type WorkspaceBoard = Board & { project: Project }
export const workspaceStore = new RxDbWorkspaceStore()

let activeUserId: string | null = null
let syncTimer: number | undefined
let nextWriteAt = 0
const dirtyProjectIds = new Set<string>()
const projectListeners = new Map<string, () => void>()
let projectsListener: (() => void) | undefined
const SYNC_DEBOUNCE_MS = 150
const MIN_WRITE_INTERVAL_MS = 1_000
const MAX_RETRY_DELAY_MS = 60_000
const ACTIVE_FLAG_MIGRATION_KEY = 'agentic-whiteboard:active-boards-v1'

class SyncConflictError extends Error {}

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

async function updateSyncStatus(boardId: string, syncStatus: Board['syncStatus']) {
  await workspaceStore.updateBoardSyncStatus(boardId, syncStatus)
  window.dispatchEvent(new CustomEvent(`board-sync:${boardId}`, { detail: syncStatus }))
}

function queueSync() {
  if (!activeUserId || syncTimer) return
  const delay = Math.max(SYNC_DEBOUNCE_MS, nextWriteAt - Date.now())
  syncTimer = window.setTimeout(() => {
    syncTimer = undefined
    void syncWorkspace(activeUserId!)
  }, delay)
}

const retryAt = (attempt: number) => new Date(Date.now() + Math.min(1_000 * 2 ** attempt, MAX_RETRY_DELAY_MS)).toISOString()
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

/** A reload may happen after Firestore committed a write but before the local ACK was recorded. */
const matchesCommittedVersion = (local: BoardDocument, remote: BoardDocument) =>
  local.revision === remote.revision && local.updatedAt === remote.updatedAt

async function syncWorkspace(userId: string) {
  const db = getFirestoreDb()
  if (!db) return
  const [projects, boards] = await Promise.all([workspaceStore.listProjects(), workspaceStore.listBoardsForSync()])
  const now = new Date().toISOString()
  const unsyncedBoards = boards.filter(
    (board) => (board.syncStatus === 'local-only' || board.syncStatus === 'sync-failed') && (!board.nextSyncAt || board.nextSyncAt <= now),
  )
  const projectIds = new Set([...dirtyProjectIds, ...unsyncedBoards.map((board) => board.projectId)])

  for (const project of projects.filter((item) => projectIds.has(item.id))) {
    try {
      await setDoc(doc(db, 'users', userId, 'projects', project.id), firestoreValue(project))
      dirtyProjectIds.delete(project.id)
    } catch {
      dirtyProjectIds.add(project.id)
    }
  }

  for (const board of unsyncedBoards) {
    const wait = Math.max(0, nextWriteAt - Date.now())
    if (wait) await new Promise<void>((resolve) => window.setTimeout(resolve, wait))
    nextWriteAt = Date.now() + MIN_WRITE_INTERVAL_MS
    try {
      await withSyncLock(async () => {
        const current = await workspaceStore.loadBoard(board.id)
        if (!current || (current.syncStatus !== 'local-only' && current.syncStatus !== 'sync-failed')) return
        const ref = doc(db, 'users', userId, 'projects', current.projectId, 'boards', current.id)
        await runTransaction(db, async (transaction) => {
          const remoteSnapshot = await transaction.get(ref)
          const remoteRevision = remoteSnapshot.exists() ? Number(remoteSnapshot.data().revision ?? 0) : 0
          if (remoteSnapshot.exists() && remoteRevision !== current.baseRevision) {
            throw new SyncConflictError('This board changed in another tab or device. Your local copy was preserved.')
          }
          transaction.set(ref, firestoreValue(cloudBoard(current)))
        })
        await workspaceStore.markBoardSynced(current.id, current.revision)
        window.dispatchEvent(new CustomEvent(`board-sync:${current.id}`, { detail: 'synced' }))
      })
    } catch (error) {
      if (error instanceof SyncConflictError) {
        await workspaceStore.markBoardConflict(board.id, error.message)
        window.dispatchEvent(new CustomEvent(`board-sync:${board.id}`, { detail: 'conflict' }))
      } else {
        const current = await workspaceStore.loadBoard(board.id)
        const nextAttempt = (current?.syncAttempts ?? 0) + 1
        await workspaceStore.markBoardSyncFailed(board.id, errorMessage(error), retryAt(nextAttempt))
        window.dispatchEvent(new CustomEvent(`board-sync:${board.id}`, { detail: 'sync-failed' }))
      }
    }
  }

  const pending = (await workspaceStore.listBoardsForSync())
    .filter((board) => (board.syncStatus === 'local-only' || board.syncStatus === 'sync-failed') && board.nextSyncAt)
    .map((board) => new Date(board.nextSyncAt!).getTime())
  if (pending.length) {
    const earliest = Math.min(...pending)
    window.setTimeout(queueSync, Math.max(0, earliest - Date.now()))
  }
}

async function downloadWorkspace(userId: string) {
  const db = getFirestoreDb()
  if (!db) return
  const projectSnapshots = await getDocs(collection(db, 'users', userId, 'projects'))
  await Promise.all(
    projectSnapshots.docs.map(async (projectSnapshot) => {
      const project = projectSnapshot.data() as Project
      await workspaceStore.upsertProject(project)
      const boardSnapshots = await getDocs(
        query(collection(db, 'users', userId, 'projects', project.id, 'boards'), where('active', '==', true)),
      )
      await Promise.all(
        boardSnapshots.docs.map(async (boardSnapshot) => {
          const remote = cloudBoard(workspaceValue(boardSnapshot.data()) as BoardDocument)
          const local = await workspaceStore.loadBoard(remote.id)
          if (local?.syncStatus === 'local-only' || local?.syncStatus === 'sync-failed') {
            if (matchesCommittedVersion(local, remote)) {
              await workspaceStore.markBoardSynced(remote.id, remote.revision)
            } else if (remote.revision !== local.baseRevision) {
              await workspaceStore.markBoardConflict(remote.id, 'This board changed remotely while local work was pending.')
            }
          } else if (!local || remote.revision >= local.revision) {
            await workspaceStore.upsertBoard(remote)
          }
        }),
      )
    }),
  )
}

/** Add the activity flag to pre-existing cloud boards before active-only reads begin. */
async function migrateLegacyBoardActivity(userId: string) {
  const db = getFirestoreDb()
  const migrationKey = `${ACTIVE_FLAG_MIGRATION_KEY}:${userId}`
  if (!db || localStorage.getItem(migrationKey)) return

  const projects = await getDocs(collection(db, 'users', userId, 'projects'))
  await Promise.all(
    projects.docs.map(async (project) => {
      const boards = await getDocs(collection(db, 'users', userId, 'projects', project.id, 'boards'))
      await Promise.all(
        boards.docs
          .filter((board) => board.data().active === undefined)
          .map((board) => setDoc(board.ref, { active: true }, { merge: true })),
      )
    }),
  )
  localStorage.setItem(migrationKey, 'complete')
}

function subscribeToRemoteWorkspace(userId: string) {
  const db = getFirestoreDb()
  if (!db || projectsListener) return
  projectsListener = onSnapshot(collection(db, 'users', userId, 'projects'), (snapshot) => {
    for (const projectSnapshot of snapshot.docs) {
      const project = projectSnapshot.data() as Project
      void workspaceStore.upsertProject(project)
      if (projectListeners.has(project.id)) continue
      projectListeners.set(
        project.id,
        onSnapshot(query(collection(db, 'users', userId, 'projects', project.id, 'boards'), where('active', '==', true)), (boardSnapshot) => {
          for (const change of boardSnapshot.docChanges()) {
            const boardDocument = change.doc
            const remote = {
              ...(workspaceValue(boardDocument.data()) as BoardDocument),
              active: change.type === 'removed' ? false : true,
            }
            void (async () => {
              const local = await workspaceStore.loadBoard(remote.id)
              const normalized = cloudBoard(remote)
              if (local?.syncStatus === 'local-only' || local?.syncStatus === 'sync-failed') {
                // Firestore can emit this tab's transaction before markBoardSynced runs.
                // Keep that in-flight acknowledgement owned by syncWorkspace; only a truly
                // newer remote revision is a conflict.
                if (normalized.revision !== local.baseRevision && normalized.revision !== local.revision) {
                  await workspaceStore.markBoardConflict(remote.id, 'This board changed remotely while local work was pending.')
                  await updateSyncStatus(remote.id, 'conflict')
                }
              } else if (!local || normalized.revision >= local.revision) {
                await workspaceStore.upsertBoard(normalized)
                await updateSyncStatus(remote.id, 'synced')
              }
            })()
          }
        }),
      )
    }
  })
}

export const workspaceApi = {
  async listWorkspace(): Promise<{ projects: Project[]; boards: WorkspaceBoard[] }> {
    await workspaceStore.bootstrap()
    const projects = await workspaceStore.listProjects()
    const boardGroups = await Promise.all(projects.map((project) => workspaceStore.listBoards(project.id)))
    return {
      projects,
      boards: boardGroups.flatMap((boards, index) => boards.map((board) => ({ ...board, project: projects[index] }))),
    }
  },
  async createBoard(projectId: string, name: string) {
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
    await workspaceStore.deleteBoard(boardId)
    queueSync()
  },
  async loadBoard(boardId: string): Promise<BoardDocument | null> {
    const document = await workspaceStore.loadBoard(boardId)
    return document?.active ? document : null
  },
  async loadBoardWithProject(boardId: string): Promise<{ document: BoardDocument; project: Project } | null> {
    await workspaceStore.bootstrap()
    const document = await workspaceStore.loadBoard(boardId)
    if (!document?.active) return null
    const projects = await workspaceStore.listProjects()
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
  async renameBoard(boardId: string, name: string): Promise<BoardDocument | null> {
    await workspaceStore.bootstrap()
    const document = await workspaceStore.loadBoard(boardId)
    if (!document?.active) return null
    const trimmed = name.trim() || 'Untitled'
    const updated: BoardDocument = {
      ...document,
      name: trimmed,
    }
    return workspaceApi.saveBoard(updated)
  },
  async saveBoard(document: BoardDocument) {
    try {
      const saved = await workspaceStore.saveBoard(document)
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
    activeUserId = userId
    await workspaceStore.bootstrap()
    await migrateLegacyBoardActivity(userId)
    await downloadWorkspace(userId)
    subscribeToRemoteWorkspace(userId)
    const { boards } = await workspaceApi.listWorkspace()
    if (boards.some((board) => board.syncStatus === 'local-only' || board.syncStatus === 'sync-failed') || dirtyProjectIds.size) queueSync()
  },
  deactivateCloudWorkspace() {
    activeUserId = null
    for (const unsubscribe of projectListeners.values()) unsubscribe()
    projectListeners.clear()
    projectsListener?.()
    projectsListener = undefined
  },
  subscribeToBoardSyncStatus(boardId: string, listener: (status: Board['syncStatus']) => void) {
    const eventName = `board-sync:${boardId}`
    const handler = (event: Event) => listener((event as CustomEvent<Board['syncStatus']>).detail)
    window.addEventListener(eventName, handler)
    return () => window.removeEventListener(eventName, handler)
  },
}
