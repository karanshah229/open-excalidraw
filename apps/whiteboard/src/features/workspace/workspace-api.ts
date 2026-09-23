import { RxDbWorkspaceStore } from '@agentic-whiteboard/storage'
import type { Board, BoardDocument, Project } from '@agentic-whiteboard/storage'
import { collection, doc, getDocs, onSnapshot, setDoc } from 'firebase/firestore'
import { getFirestoreDb } from '../../lib/firebase'

export type WorkspaceBoard = Board & { project: Project }
export const workspaceStore = new RxDbWorkspaceStore()

let activeUserId: string | null = null
let syncTimer: number | undefined
const projectListeners = new Map<string, () => void>()
let projectsListener: (() => void) | undefined

/** Firestore rejects undefined at any depth; Excalidraw deliberately uses it for optional fields. */
function firestoreValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined).map(firestoreValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, firestoreValue(item)]),
    )
  }
  return value
}

async function updateSyncStatus(boardId: string, syncStatus: Board['syncStatus']) {
  await workspaceStore.updateBoardSyncStatus(boardId, syncStatus)
  window.dispatchEvent(new CustomEvent(`board-sync:${boardId}`, { detail: syncStatus }))
}

function queueSync() {
  if (!activeUserId || syncTimer) return
  syncTimer = window.setTimeout(() => {
    syncTimer = undefined
    void syncWorkspace(activeUserId!)
  }, 150)
}

async function syncWorkspace(userId: string) {
  const db = getFirestoreDb()
  if (!db) return
  const { projects, boards } = await workspaceApi.listWorkspace()
  const unsyncedBoards = boards.filter((board) => board.syncStatus === 'local-only')

  await Promise.all(projects.map((project) => setDoc(doc(db, 'users', userId, 'projects', project.id), project)))
  await Promise.all(
    unsyncedBoards.map(async (board) => {
      try {
        const { project: _project, ...document } = board
        const ref = doc(db, 'users', userId, 'projects', board.projectId, 'boards', board.id)
        await setDoc(ref, firestoreValue({ ...document, syncStatus: 'synced' }))
        await updateSyncStatus(board.id, 'synced')
      } catch {
        await updateSyncStatus(board.id, 'sync-failed')
      }
    }),
  )
}

async function downloadWorkspace(userId: string) {
  const db = getFirestoreDb()
  if (!db) return
  const projectSnapshots = await getDocs(collection(db, 'users', userId, 'projects'))
  await Promise.all(
    projectSnapshots.docs.map(async (projectSnapshot) => {
      const project = projectSnapshot.data() as Project
      await workspaceStore.upsertProject(project)
      const boardSnapshots = await getDocs(collection(db, 'users', userId, 'projects', project.id, 'boards'))
      await Promise.all(
        boardSnapshots.docs.map(async (boardSnapshot) => {
          const remote = boardSnapshot.data() as BoardDocument
          const local = await workspaceStore.loadBoard(remote.id)
          if (!local || remote.updatedAt > local.updatedAt) await workspaceStore.upsertBoard({ ...remote, syncStatus: 'synced' })
        }),
      )
    }),
  )
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
        onSnapshot(collection(db, 'users', userId, 'projects', project.id, 'boards'), (boardSnapshot) => {
          for (const boardDocument of boardSnapshot.docs) {
            const remote = boardDocument.data() as BoardDocument
            void (async () => {
              const local = await workspaceStore.loadBoard(remote.id)
              if (!local || remote.updatedAt > local.updatedAt) await workspaceStore.upsertBoard({ ...remote, syncStatus: 'synced' })
              await updateSyncStatus(remote.id, 'synced')
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
    queueSync()
    return project
  },
  async deleteBoard(boardId: string) {
    await workspaceStore.deleteBoard(boardId)
    queueSync()
  },
  loadBoard: (boardId: string): Promise<BoardDocument | null> => workspaceStore.loadBoard(boardId),
  async loadBoardWithProject(boardId: string): Promise<{ document: BoardDocument; project: Project } | null> {
    await workspaceStore.bootstrap()
    const document = await workspaceStore.loadBoard(boardId)
    if (!document) return null
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
    if (!document) return null
    const trimmed = name.trim() || 'Untitled'
    const updated: BoardDocument = {
      ...document,
      name: trimmed,
    }
    await workspaceStore.saveBoard(updated)
    queueSync()
    return updated
  },
  async saveBoard(document: BoardDocument) {
    await workspaceStore.saveBoard(document)
    if (activeUserId) await updateSyncStatus(document.id, 'pending-sync')
    queueSync()
  },
  async activateCloudWorkspace(userId: string) {
    activeUserId = userId
    await workspaceStore.bootstrap()
    await downloadWorkspace(userId)
    subscribeToRemoteWorkspace(userId)
    const { boards } = await workspaceApi.listWorkspace()
    if (boards.some((board) => board.syncStatus === 'local-only')) queueSync()
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
