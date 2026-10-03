import { RxDbWorkspaceStore, setWorkspaceIdentity } from '@agentic-whiteboard/storage'
import type { Board, BoardDocument, Project } from '@agentic-whiteboard/storage'
import { collection, doc, getDoc, getDocs, onSnapshot, query, runTransaction, setDoc, where } from 'firebase/firestore'
import { getFirestoreDb } from '../../lib/firebase'
import { restoreSceneAssets, storeSceneAssets } from '../assets/scene-assets'
import { sharingService } from '../sharing/sharing-service'
import { projectService, type VisibleProject } from '../sharing/project-service'
import { reconcileElementsLWW } from '../collaboration/reconcile'
import { cloudCall, pauseUntil } from '../account/cloud-api'

export type WorkspaceBoard = Board & {
  project: VisibleProject
  inheritProjectAccess?: boolean
  isPrivate?: boolean
  role?: 'owner' | 'editor' | 'viewer'
}
export const workspaceStore = new RxDbWorkspaceStore()
const workspaceRequests = new Map<string, Promise<{ projects: VisibleProject[]; boards: WorkspaceBoard[] }>>()

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
const SYNC_DEBOUNCE_MS = 150
const MIN_WRITE_INTERVAL_MS = 5_000
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

async function performWorkspaceSync(userId: string) {
  const generation = activation
  const db = getFirestoreDb()
  if (!db) return
  const [projects, boards] = await Promise.all([workspaceStore.listProjects(), workspaceStore.listBoardsForSync()])
  const now = new Date().toISOString()
  const unsyncedBoards = boards.filter(
    (board) =>
      (board.syncStatus === 'local-only' || board.syncStatus === 'sync-failed') &&
      (!board.nextSyncAt || board.nextSyncAt <= now),
  )
  const projectIds = new Set([...dirtyProjectIds, ...unsyncedBoards.map((board) => board.projectId)])

  for (const project of projects.filter((item) => projectIds.has(item.id))) {
    try {
      if (activation !== generation || activeUserId !== userId || project.ownerId !== userId) return
      const projectRef = doc(db, 'users', userId, 'projects', project.id)
      await runTransaction(db, async (transaction) => {
        const existing = await transaction.get(projectRef)
        if (!existing.exists()) transaction.set(projectRef, firestoreValue(project))
        else if (existing.data().deletedAt) throw new Error('Project was deleted.')
      })
      dirtyProjectIds.delete(project.id)
    } catch {
      dirtyProjectIds.add(project.id)
    }
  }

  for (const board of unsyncedBoards) {
    if (generation !== activation || activeUserId !== userId) return
    const wait = Math.max(0, nextWriteAt - Date.now())
    if (wait) await new Promise<void>((resolve) => window.setTimeout(resolve, wait))
    nextWriteAt = Date.now() + MIN_WRITE_INTERVAL_MS
    try {
      await withSyncLock(async () => {
        const current = await workspaceStore.loadBoard(board.id)
        if (!current || (current.syncStatus !== 'local-only' && current.syncStatus !== 'sync-failed')) return
        const ref = doc(db, 'users', userId, 'projects', current.projectId, 'boards', current.id)
        const assetRoot = `users/${userId}/boards/${current.id}/assets`
        const cloudScene = await storeSceneAssets(current.scene, assetRoot)
        let resolvedBoard = current
        // Server owns the commit/counters. A concurrent scene is reconciled locally
        // before retrying a new operation; direct SDK writes are denied by rules.
        const commit = (document: BoardDocument) =>
          cloudCall('commitCloudBoard', {
            mode: 'private',
            boardId: document.id,
            projectId: document.projectId,
            operationId: `private-${document.revision}-${document.updatedAt.replace(/[^0-9]/g, '')}`,
            baseRevision: document.baseRevision,
            document: firestoreValue(cloudBoard(document)),
          })
        try {
          await commit({ ...current, scene: cloudScene })
        } catch (error: any) {
          if (error.code !== 'functions/aborted') throw error
          const remoteSnapshot = await getDoc(ref)
          if (remoteSnapshot.exists() && remoteSnapshot.data().active === false && current.active)
            throw new Error('Board was deleted.', { cause: error })
          if (remoteSnapshot.exists()) {
            const remoteData = workspaceValue(remoteSnapshot.data()) as BoardDocument
            const remoteRevision = Number(remoteData.revision ?? 0)
            if (remoteRevision === current.baseRevision) throw error
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
              const mergedScene = await storeSceneAssets(resolvedBoard.scene, assetRoot)
              await commit({ ...resolvedBoard, baseRevision: remoteRevision, scene: mergedScene })
            }
          } else throw error
        }
        if (resolvedBoard !== current) {
          await workspaceStore.upsertBoard(resolvedBoard)
        }
        await workspaceStore.markBoardSynced(resolvedBoard.id, resolvedBoard.revision)
        window.dispatchEvent(new CustomEvent(`board-sync:${resolvedBoard.id}`, { detail: 'synced' }))
      })
    } catch (error) {
      const current = await workspaceStore.loadBoard(board.id)
      const nextAttempt = (current?.syncAttempts ?? 0) + 1
      await workspaceStore.markBoardSyncFailed(
        board.id,
        errorMessage(error),
        (error as any)?.code === 'functions/resource-exhausted' ? pauseUntil(error) : retryAt(nextAttempt),
      )
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
    if (generation !== activation || activeUserId !== userId) return
    for (const projectSnapshot of snapshot.docs) {
      const stored = projectSnapshot.data() as Project
      const project: Project = { ...stored, id: projectSnapshot.id, ownerId: userId }
      if (!project.deletedAt && (stored.ownerId !== userId || stored.id !== project.id))
        void projectService
          .manage(project.id, 'repair')
          .catch((error) => console.error('Legacy project repair failed:', error))
      void workspaceStore
        .upsertProject(project)
        .then(emitWorkspaceChange)
        .catch((error) => console.error('Cloud project restore failed:', error))
      if (project.deletedAt) {
        projectListeners.get(project.id)?.()
        projectListeners.delete(project.id)
        continue
      }
      if (projectListeners.has(project.id)) continue
      projectListeners.set(
        project.id,
        onSnapshot(
          query(collection(db, 'users', userId, 'projects', project.id, 'boards'), where('active', '==', true)),
          (boardSnapshot) => {
            if (generation !== activation || activeUserId !== userId) return
            for (const change of boardSnapshot.docChanges()) {
              const boardDocument = change.doc
              const remote = {
                ...(workspaceValue(boardDocument.data()) as BoardDocument),
                id: boardDocument.id,
                projectId: project.id,
                active: change.type === 'removed' ? false : true,
              }
              void (async () => {
                if (generation !== activation || activeUserId !== userId) return
                const normalized = cloudBoard(remote)
                if (!normalized.active) {
                  await workspaceStore.upsertBoard(normalized)
                  emitWorkspaceChange()
                  return
                }
                const known = await workspaceStore.loadBoard(remote.id)
                normalized.scene = await restoreSceneAssets(normalized.scene, known?.scene.files)
                const local = await workspaceStore.loadBoard(remote.id)
                if (local?.syncStatus === 'local-only' || local?.syncStatus === 'sync-failed') {
                  if (matchesCommittedVersion(local, normalized)) {
                    await workspaceStore.markBoardSynced(local.id, local.revision)
                    emitWorkspaceChange()
                  } else if (normalized.revision !== local.baseRevision && normalized.revision !== local.revision) {
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
                  emitWorkspaceChange()
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
}

export const workspaceApi = {
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
        .filter(() => uid || !projectId)
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
    // Permanent cloud deletion frees its slot; do not discard local data if cleanup fails.
    if (activeUserId && getFirestoreDb()) await cloudCall('purgeCloudBoard', { boardId })
    await workspaceStore.deleteBoard(boardId)
    // A deleted cloud board must not be recreated by the sync outbox.
    await workspaceStore.markBoardSynced(boardId, (await workspaceStore.loadBoard(boardId))?.revision ?? 0)
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
      const previous = await workspaceStore.loadBoard(document.id)
      const saved = await workspaceStore.saveBoard(document)
      emitWorkspaceChange()
      // Keep accepting local edits without resetting a server-requested retry delay.
      if (
        previous?.syncStatus === 'sync-failed' &&
        previous.nextSyncAt &&
        Date.parse(previous.nextSyncAt) > Date.now()
      ) {
        await workspaceStore.markBoardSyncFailed(
          document.id,
          previous.lastSyncError ?? 'Cloud sync paused',
          previous.nextSyncAt,
        )
        queueSync()
        return {
          ...saved,
          syncStatus: 'sync-failed' as const,
          nextSyncAt: previous.nextSyncAt,
          lastSyncError: previous.lastSyncError,
        }
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
    const claimedProjectIds = await workspaceStore.claimLocalProjects(userId)
    claimedProjectIds.forEach((projectId) => dirtyProjectIds.add(projectId))
    subscribeToRemoteWorkspace(userId)
    emitWorkspaceChange()
    const boards = await workspaceStore.listBoardsForSync()
    if (
      boards.some((board) => board.syncStatus === 'local-only' || board.syncStatus === 'sync-failed') ||
      dirtyProjectIds.size
    )
      queueSync()
  },
  deactivateCloudWorkspace() {
    activation++
    if (syncTimer) window.clearTimeout(syncTimer)
    syncTimer = undefined
    dirtyProjectIds.clear()
    activeUserId = null
    setWorkspaceIdentity(null)
    emitWorkspaceChange()
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
