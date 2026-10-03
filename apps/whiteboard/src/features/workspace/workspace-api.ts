import { RxDbWorkspaceStore } from '@agentic-whiteboard/storage'
import type { Board, BoardDocument, Project } from '@agentic-whiteboard/storage'
import { collection, doc, getDoc, getDocs, onSnapshot, query, runTransaction, where } from 'firebase/firestore'
import { getFirestoreDb } from '../../lib/firebase'
import { restoreSceneAssets, storeSceneAssets } from '../assets/scene-assets'
import { reconcileElementsLWW } from '../collaboration/reconcile'

export type WorkspaceBoard = Board & { project: Project }
export const workspaceStore = new RxDbWorkspaceStore()

let activeUserId: string | null = null
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
  const boards = (await workspaceStore.listBoardsForSync()).filter((board) => board.projectId === projectId)
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
  const boards = (await workspaceStore.listBoardsForSync()).filter(
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

/** A reload may happen after Firestore committed a write but before the local ACK was recorded. */
const matchesCommittedVersion = (local: BoardDocument, remote: BoardDocument) =>
  local.revision === remote.revision && local.updatedAt === remote.updatedAt

async function syncWorkspace(userId: string, targetBoardId?: string) {
  const db = getFirestoreDb()
  if (!db) return
  const [projects, boards] = await Promise.all([workspaceStore.listProjects(), workspaceStore.listBoardsForSync()])
  const now = new Date().toISOString()
  const unsyncedBoards = boards.filter(
    (board) =>
      (!targetBoardId || board.id === targetBoardId) &&
      (board.syncStatus === 'local-only' || board.syncStatus === 'sync-failed') &&
      (!board.nextSyncAt || board.nextSyncAt <= now),
  )
  const projectIds = new Set([
    ...(targetBoardId ? [] : dirtyProjectIds),
    ...unsyncedBoards.map((board) => board.projectId),
  ])

  for (const project of projects.filter((item) => projectIds.has(item.id))) {
    try {
      const projectRef = doc(db, 'users', userId, 'projects', project.id)
      await runTransaction(db, async (transaction) => {
        const remote = await transaction.get(projectRef)
        if (isProjectDeleted(remote.data())) throw new DeletedProjectError(PROJECT_DELETED_MESSAGE)
        // Preserve server-owned fields, including deletion metadata.
        transaction.set(projectRef, firestoreValue(project) as Record<string, unknown>, { merge: true })
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
    const wait = Math.max(0, nextWriteAt - Date.now())
    if (wait) await new Promise<void>((resolve) => window.setTimeout(resolve, wait))
    nextWriteAt = Date.now() + MIN_WRITE_INTERVAL_MS
    try {
      await withSyncLock(async () => {
        const current = await workspaceStore.loadBoard(board.id)
        if (!current || (current.syncStatus !== 'local-only' && current.syncStatus !== 'sync-failed')) return
        const ref = doc(db, 'users', userId, 'projects', current.projectId, 'boards', current.id)
        const assetRoot = `users/${userId}/boards/${current.id}/assets`
        const cloudScene = await storeSceneAssets(current.scene, assetRoot, current.projectId)
        let resolvedBoard = current
        await runTransaction(db, async (transaction) => {
          const parent = await transaction.get(doc(db, 'users', userId, 'projects', current.projectId))
          if (isProjectDeleted(parent.data())) throw new DeletedProjectError(PROJECT_DELETED_MESSAGE)
          const remoteSnapshot = await transaction.get(ref)
          if (remoteSnapshot.exists()) {
            const remoteData = workspaceValue(remoteSnapshot.data()) as BoardDocument
            const remoteRevision = Number(remoteData.revision ?? 0)
            if (remoteRevision !== current.baseRevision) {
              remoteData.scene = await restoreSceneAssets(remoteData.scene, current.scene.files)
              // Element-level LWW reconciliation
              const mergedElements = reconcileElementsLWW(
                current.scene?.elements ?? [],
                remoteData.scene?.elements ?? [],
              )
              const nextRev = Math.max(current.revision, remoteRevision) + 1
              resolvedBoard = {
                ...current,
                revision: nextRev,
                baseRevision: nextRev,
                scene: {
                  ...current.scene,
                  elements: mergedElements,
                  files: { ...remoteData.scene.files, ...current.scene.files },
                },
                updatedAt: new Date().toISOString(),
              }
              const mergedScene = await storeSceneAssets(resolvedBoard.scene, assetRoot, current.projectId)
              transaction.set(ref, firestoreValue(cloudBoard({ ...resolvedBoard, scene: mergedScene })))
              return
            }
          }
          transaction.set(ref, firestoreValue(cloudBoard({ ...current, scene: cloudScene })))
        })
        if (resolvedBoard !== current) {
          await workspaceStore.upsertBoard(resolvedBoard)
        }
        await workspaceStore.markBoardSynced(resolvedBoard.id, resolvedBoard.revision)
        window.dispatchEvent(new CustomEvent(`board-sync:${resolvedBoard.id}`, { detail: 'synced' }))
      })
    } catch (error) {
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
      if (isProjectDeleted(projectSnapshot.data())) {
        await blockProjectSync(project.id)
        return
      }
      await resumeProjectSync(project.id)
      await workspaceStore.upsertProject(project)
      const boardSnapshots = await getDocs(
        query(collection(db, 'users', userId, 'projects', project.id, 'boards'), where('active', '==', true)),
      )
      await Promise.all(
        boardSnapshots.docs.map(async (boardSnapshot) => {
          const remote = cloudBoard(workspaceValue(boardSnapshot.data()) as BoardDocument)
          const known = await workspaceStore.loadBoard(remote.id)
          remote.scene = await restoreSceneAssets(remote.scene, known?.scene.files)
          const local = await workspaceStore.loadBoard(remote.id)
          if (local?.syncStatus === 'local-only' || local?.syncStatus === 'sync-failed') {
            if (matchesCommittedVersion(local, remote)) {
              await workspaceStore.markBoardSynced(remote.id, remote.revision)
            } else {
              // Element-level LWW reconciliation
              const mergedElements = reconcileElementsLWW(local.scene?.elements ?? [], remote.scene?.elements ?? [])
              const mergedBoard: BoardDocument = {
                ...local,
                revision: Math.max(local.revision, remote.revision) + 1,
                scene: {
                  ...local.scene,
                  elements: mergedElements,
                  files: { ...remote.scene.files, ...local.scene.files },
                },
              }
              await workspaceStore.upsertBoard(mergedBoard)
              queueSync()
            }
          } else if (!local || remote.revision >= local.revision) {
            await workspaceStore.upsertBoard(remote)
          }
        }),
      )
    }),
  )
}

function subscribeToRemoteWorkspace(userId: string) {
  const db = getFirestoreDb()
  if (!db || projectsListener) return
  projectsListener = onSnapshot(collection(db, 'users', userId, 'projects'), (snapshot) => {
    projectUpdates = projectUpdates
      .catch(console.error)
      .then(async () => {
        for (const projectSnapshot of snapshot.docs) {
          if (activeUserId !== userId) return
          const project = projectSnapshot.data() as Project
          if (isProjectDeleted(projectSnapshot.data())) {
            if (!deletedProjectIds.has(project.id)) await blockProjectSync(project.id)
            continue
          }
          await resumeProjectSync(project.id)
          await workspaceStore.upsertProject(project)
          if (projectListeners.has(project.id)) continue
          projectListeners.set(
            project.id,
            onSnapshot(
              query(collection(db, 'users', userId, 'projects', project.id, 'boards'), where('active', '==', true)),
              (boardSnapshot) => {
                for (const change of boardSnapshot.docChanges()) {
                  if (deletedProjectIds.has(project.id)) return
                  const boardDocument = change.doc
                  const remote = {
                    ...(workspaceValue(boardDocument.data()) as BoardDocument),
                    active: change.type === 'removed' ? false : true,
                  }
                  void (async () => {
                    const normalized = cloudBoard(remote)
                    const known = await workspaceStore.loadBoard(remote.id)
                    if (normalized.active)
                      normalized.scene = await restoreSceneAssets(normalized.scene, known?.scene.files)
                    if (deletedProjectIds.has(project.id)) return
                    const local = await workspaceStore.loadBoard(remote.id)
                    if (local?.syncStatus === 'local-only' || local?.syncStatus === 'sync-failed') {
                      if (normalized.revision !== local.baseRevision && normalized.revision !== local.revision) {
                        // Element-level LWW reconciliation
                        const mergedElements = reconcileElementsLWW(
                          local.scene?.elements ?? [],
                          normalized.scene?.elements ?? [],
                        )
                        const mergedBoard: BoardDocument = {
                          ...local,
                          revision: Math.max(local.revision, normalized.revision) + 1,
                          scene: {
                            ...local.scene,
                            elements: mergedElements,
                            files: { ...normalized.scene.files, ...local.scene.files },
                          },
                        }
                        await workspaceStore.upsertBoard(mergedBoard)
                        queueSync()
                      }
                    } else if (!local || normalized.revision >= local.revision) {
                      await workspaceStore.upsertBoard(normalized)
                      await updateSyncStatus(remote.id, 'synced')
                    }
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

export const workspaceApi = {
  /** Sharing must bind to a committed parent before the gateway can authorize its images. */
  async ensureCloudBoardSynced(boardId: string, userId: string) {
    const local = await workspaceStore.loadBoard(boardId)
    if (!local) return
    if (!local.active) throw new Error('A deleted board cannot be shared.')
    await syncWorkspace(userId, boardId)
    const db = getFirestoreDb()
    if (!db) throw new Error('Firestore is required to share this board.')
    const snapshot = await getDoc(doc(db, 'users', userId, 'projects', local.projectId, 'boards', boardId))
    if (!snapshot.exists() || snapshot.data().active === false) {
      throw new Error('Wait for this board to sync before sharing it.')
    }
  },
  async listWorkspace(): Promise<{ projects: Project[]; boards: WorkspaceBoard[] }> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return { projects: [], boards: [] }
    }
    await workspaceStore.bootstrap()
    const projects = (await workspaceStore.listProjects()).filter((project) => !deletedProjectIds.has(project.id))
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
    const userChanged = activeUserId !== userId
    if (userChanged) deletedProjectIds.clear()
    activeUserId = userId
    await workspaceStore.bootstrap()
    if (userChanged) {
      for (const board of await workspaceStore.listBoardsForSync()) {
        if (board.syncStatus === 'sync-blocked') deletedProjectIds.add(board.projectId)
      }
    }
    await downloadWorkspace(userId)
    const claimedProjectIds = await workspaceStore.claimLocalProjects(userId)
    claimedProjectIds.forEach((projectId) => dirtyProjectIds.add(projectId))
    subscribeToRemoteWorkspace(userId)
    const { boards } = await workspaceApi.listWorkspace()
    if (
      boards.some((board) => board.syncStatus === 'local-only' || board.syncStatus === 'sync-failed') ||
      dirtyProjectIds.size
    )
      queueSync()
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
