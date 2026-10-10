import { addRxPlugin, createRxDatabase } from 'rxdb'
import { getRxStorageLocalstorage } from 'rxdb/plugins/storage-localstorage'
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie'
import { RxDBMigrationSchemaPlugin } from 'rxdb/plugins/migration-schema'
import type { RxDatabase, RxJsonSchema } from 'rxdb'

export type ProjectRole = 'owner' | 'editor' | 'viewer'
export type BoardSyncStatus = 'local-only' | 'synced' | 'sync-failed' | 'sync-blocked' | 'conflict'
export type ProjectMember = { principalId: string; role: ProjectRole }

export type Project = {
  id: string
  name: string
  ownerId: string
  members: ProjectMember[]
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
  revision?: number
}
export type Board = {
  id: string
  projectId: string
  name: string
  active: boolean
  createdAt: string
  updatedAt: string
  syncStatus: BoardSyncStatus
  /** Monotonic local revision used to detect concurrent full-scene writes. */
  revision: number
  /** Cloud revision from which this local edit was made. */
  baseRevision: number
  /** Canonical cloud head identity; independent of this device's local revision. */
  cloudRevisionId?: string
  cloudGeneration?: number
  /** Metadata discovered, but no complete local scene has been hydrated yet. */
  cloudScenePending?: boolean
  syncAttempts: number
  nextSyncAt: string | null
  lastSyncError: string | null
  scene?: BoardScene
}
export type BoardFile = {
  id: string
  dataURL: string
  mimeType: string
  created: number
  lastRetrieved?: number
  storagePath?: string
}
export type BoardScene = {
  elements: Record<string, unknown>[]
  appState: Record<string, unknown>
  /** Includes deleted elements' assets so undo remains possible. */
  files?: Record<string, BoardFile>
}
export type BoardDocument = Board & { scene: BoardScene; formatVersion: 1 }
export type WorkspaceBootstrap = { project: Project | null; board: BoardDocument | null }

/** Product-level boundary for local, desktop, and cloud persistence adapters. */
export interface WorkspaceStore {
  bootstrap(): Promise<WorkspaceBootstrap>
  listProjects(includeDeleted?: boolean): Promise<Project[]>
  claimLocalProjects(ownerId: string): Promise<string[]>
  createProject(name: string, ownerId: string): Promise<Project>
  listBoards(projectId: string): Promise<Board[]>
  createBoard(projectId: string, name: string): Promise<BoardDocument>
  loadBoard(boardId: string): Promise<BoardDocument | null>
  saveBoard(document: BoardDocument): Promise<BoardDocument>
  upsertProject(project: Project): Promise<void>
  upsertBoard(document: BoardDocument): Promise<void>
  upsertBoardMetadata(document: BoardDocument): Promise<void>
  updateBoardSyncStatus(boardId: string, syncStatus: BoardSyncStatus): Promise<void>
  markBoardSynced(boardId: string, revision: number): Promise<void>
  acknowledgeBoardScene(
    boardId: string,
    revision: number,
    scene: BoardScene,
    cloudRevisionId: string,
    cloudGeneration: number,
    options?: { expectedCloudRevisionId: string | undefined },
  ): Promise<void>
  applyCloudBoardScene(
    boardId: string,
    scene: BoardScene,
    cloudRevisionId: string,
    cloudGeneration: number,
    options?: { expectedCloudRevisionId: string | undefined },
  ): Promise<void>
  markBoardConflict(boardId: string, error: string, expectedGeneration?: number): Promise<void>
  markBoardSyncFailed(boardId: string, error: string, nextSyncAt: string): Promise<void>
  markBoardSyncBlocked(boardId: string, error: string): Promise<void>
  resumeBoardSync(boardId: string): Promise<void>
  requeueConflictedBoard(boardId: string, remoteRevision: number): Promise<void>
  listBoardsForSync(includeDeletedProjects?: boolean): Promise<Board[]>
  deleteBoard(boardId: string): Promise<void>
}

type RxCollections = { projects: unknown; boards: unknown }
const LOCAL_PRINCIPAL_ID = 'local-user'
let workspaceIdentity = LOCAL_PRINCIPAL_ID
export function setWorkspaceIdentity(userId: string | null) {
  workspaceIdentity = userId ?? LOCAL_PRINCIPAL_ID
}
const DATABASE_NAME = 'agentic-whiteboard-v2'
const LEGACY_DATABASE_NAME = 'agentic-whiteboard-v1'
const now = () => new Date().toISOString()
const newId = () => crypto.randomUUID()
const defaultScene = (): BoardScene => ({ elements: [], appState: { viewBackgroundColor: 'transparent' } })

addRxPlugin(RxDBMigrationSchemaPlugin)

const projectSchema: RxJsonSchema<Project> = {
  title: 'project schema',
  version: 1,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 100 },
    name: { type: 'string' },
    ownerId: { type: 'string' },
    members: { type: 'array', items: { type: 'object', additionalProperties: true } },
    deletedAt: { type: ['string', 'null'] },
    revision: { type: 'number' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
  required: ['id', 'name', 'ownerId', 'members', 'createdAt', 'updatedAt'],
}

const boardSchema: RxJsonSchema<BoardDocument> = {
  title: 'board schema',
  version: 2,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 100 },
    projectId: { type: 'string' },
    name: { type: 'string' },
    active: { type: 'boolean' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    syncStatus: { type: 'string' },
    revision: { type: 'number', minimum: 0 },
    baseRevision: { type: 'number', minimum: 0 },
    cloudRevisionId: { type: 'string' },
    cloudGeneration: { type: 'number', minimum: 0 },
    cloudScenePending: { type: 'boolean' },
    syncAttempts: { type: 'number', minimum: 0 },
    nextSyncAt: { type: ['string', 'null'] },
    lastSyncError: { type: ['string', 'null'] },
    formatVersion: { type: 'number' },
    scene: { type: 'object', additionalProperties: true },
  },
  required: [
    'id',
    'projectId',
    'name',
    'active',
    'createdAt',
    'updatedAt',
    'syncStatus',
    'revision',
    'baseRevision',
    'syncAttempts',
    'nextSyncAt',
    'lastSyncError',
    'formatVersion',
    'scene',
  ],
}

let databasePromise: Promise<RxDatabase<RxCollections>> | undefined

const database = () => {
  databasePromise ??= createRxDatabase<RxCollections>({
    name: DATABASE_NAME,
    storage: getRxStorageDexie(),
    multiInstance: true,
    // Closes a stale instance left behind by Vite hot reload without weakening
    // RxDB's production duplicate-database safety checks.
    closeDuplicates: true,
  }).then(async (instance) => {
    await instance.addCollections({
      projects: {
        schema: projectSchema,
        migrationStrategies: {
          1: (project: Project) => ({
            ...project,
            deletedAt: project.deletedAt ?? null,
            revision: project.revision ?? 0,
          }),
        },
      },
      boards: {
        schema: boardSchema,
        migrationStrategies: {
          1: (document: BoardDocument) => ({ ...document, active: document.active ?? true }),
          2: (document: BoardDocument) => document,
        },
      },
    })
    await migrateLegacyLocalStorage(instance)
    return instance
  })
  return databasePromise
}

function mergeSceneElements(local: BoardScene, remote: BoardScene): BoardScene {
  const elements = new Map<string, Record<string, unknown>>()
  for (const element of local.elements) elements.set(String(element.id), element)
  for (const element of remote.elements) {
    const current = elements.get(String(element.id))
    if (
      !current ||
      Number(element.version ?? 0) > Number(current.version ?? 0) ||
      (Number(element.version ?? 0) === Number(current.version ?? 0) &&
        Number(element.versionNonce ?? 0) < Number(current.versionNonce ?? 0))
    )
      elements.set(String(element.id), element)
  }
  return { ...remote, ...local, elements: [...elements.values()], files: { ...remote.files, ...local.files } }
}

const plain = <T>(document: { toJSON: () => T }) => document.toJSON()
const toBoard = (document: BoardDocument): Board => {
  const { formatVersion: _formatVersion, ...board } = document
  return board
}

const normalizedBoard = (
  document: Omit<BoardDocument, 'revision' | 'baseRevision' | 'syncAttempts' | 'nextSyncAt' | 'lastSyncError'> &
    Partial<BoardDocument>,
): BoardDocument => ({
  ...document,
  active: document.active ?? true,
  syncStatus: document.syncStatus === 'synced' ? 'synced' : 'local-only',
  revision: document.revision ?? 0,
  baseRevision: document.baseRevision ?? document.revision ?? 0,
  syncAttempts: document.syncAttempts ?? 0,
  nextSyncAt: document.nextSyncAt ?? null,
  lastSyncError: document.lastSyncError ?? null,
})

/** One-time, non-destructive import of the previous RxDB localStorage store. */
async function migrateLegacyLocalStorage(instance: RxDatabase<RxCollections>) {
  const existing = await (instance.boards as any).findOne().exec()
  if (existing) return
  const legacy = await createRxDatabase<RxCollections>({
    name: LEGACY_DATABASE_NAME,
    storage: getRxStorageLocalstorage(),
    multiInstance: false,
  })
  try {
    const { active: _active, ...legacyProperties } = boardSchema.properties
    await legacy.addCollections({
      projects: {
        schema: {
          ...projectSchema,
          version: 0,
          properties: Object.fromEntries(
            Object.entries(projectSchema.properties).filter(([key]) => key !== 'deletedAt' && key !== 'revision'),
          ),
        },
      },
      boards: {
        schema: {
          ...boardSchema,
          version: 0,
          properties: legacyProperties,
          required: ['id', 'projectId', 'name', 'createdAt', 'updatedAt', 'syncStatus', 'formatVersion', 'scene'],
        },
      },
    })
    const [projects, boards] = await Promise.all([
      (legacy.projects as any).find().exec(),
      (legacy.boards as any).find().exec(),
    ])
    await Promise.all(projects.map((project: any) => (instance.projects as any).insert(plain<Project>(project))))
    await Promise.all(boards.map((board: any) => (instance.boards as any).insert(normalizedBoard(plain<any>(board)))))
  } catch {
    // A missing or incompatible legacy store must not block a new workspace.
  } finally {
    await legacy.close()
  }
}

export class RxDbWorkspaceStore implements WorkspaceStore {
  private bootstrapPromise?: Promise<WorkspaceBootstrap>

  bootstrap() {
    this.bootstrapPromise ??= this.bootstrapInternal()
    return this.bootstrapPromise
  }

  private async bootstrapInternal(): Promise<WorkspaceBootstrap> {
    const projects = await this.listProjects()
    if (projects.length > 0) {
      const project = projects[0]
      const boards = await this.listBoards(project.id)
      const board = boards[0] ? await this.loadBoard(boards[0].id) : null
      return { project, board }
    }

    return { project: null, board: null }
  }

  async listProjects(includeDeleted?: boolean): Promise<Project[]> {
    const db = await database()
    const documents = await (db.projects as any).find().exec()
    return documents
      .map(plain<Project>)
      .filter((project: Project) => project.ownerId === workspaceIdentity && (includeDeleted || !project.deletedAt))
      .toSorted((left: Project, right: Project) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /** Assign offline user-created projects to the signed-in user before cloud sync. */
  async claimLocalProjects(ownerId: string): Promise<string[]> {
    const db = await database()
    const documents = await (db.projects as any).find({ selector: { ownerId: LOCAL_PRINCIPAL_ID } }).exec()

    const legitimateDocs: any[] = documents

    await Promise.all(
      legitimateDocs.map(async (document: any) => {
        const project = plain<Project>(document)
        const members = project.members.map((member) =>
          member.principalId === LOCAL_PRINCIPAL_ID ? { ...member, principalId: ownerId } : member,
        )
        if (!members.some((member) => member.principalId === ownerId && member.role === 'owner')) {
          members.unshift({ principalId: ownerId, role: 'owner' })
        }
        await document.incrementalPatch({ ownerId, members, updatedAt: now() })
      }),
    )

    return legitimateDocs.map((document: any) => plain<Project>(document).id)
  }

  async createProject(name: string, ownerId: string): Promise<Project> {
    const timestamp = now()
    const project: Project = {
      id: newId(),
      name: name.trim() || 'Untitled project',
      ownerId,
      members: [{ principalId: ownerId, role: 'owner' }],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const db = await database()
    await (db.projects as any).insert(project)
    return project
  }

  async listBoards(projectId: string): Promise<Board[]> {
    const db = await database()
    if (!(await this.listProjects()).some((project) => project.id === projectId)) return []
    const documents = await (db.boards as any).find({ selector: { projectId, active: true } }).exec()
    return documents
      .map((document: any) => toBoard(plain<BoardDocument>(document)))
      .toSorted((left: Board, right: Board) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async createBoard(projectId: string, name: string): Promise<BoardDocument> {
    const parent = (await this.listProjects()).find((project) => project.id === projectId)
    if (!parent) throw new Error('Project is unavailable.')
    const timestamp = now()
    const document: BoardDocument = {
      id: newId(),
      projectId,
      name: name.trim() || 'Untitled',
      active: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      syncStatus: 'local-only',
      revision: 0,
      baseRevision: 0,
      syncAttempts: 0,
      nextSyncAt: null,
      lastSyncError: null,
      formatVersion: 1,
      scene: defaultScene(),
    }
    const db = await database()
    await (db.boards as any).insert(document)
    return document
  }

  async loadBoard(boardId: string): Promise<BoardDocument | null> {
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (!document) return null
    const board = plain<BoardDocument>(document)
    const parent = (await this.listProjects(true)).find((project) => project.id === board.projectId)
    return parent ? board : null
  }

  async saveBoard(document: BoardDocument): Promise<BoardDocument> {
    if (!(await this.listProjects(true)).some((project) => project.id === document.projectId))
      throw new Error('Project is unavailable.')
    const db = await database()
    let existingDocument = await (db.boards as any).findOne(document.id).exec()
    const update = (current: BoardDocument): BoardDocument => {
      if (current.active === false) throw new Error('Board was deleted.')
      if (current.cloudScenePending || document.cloudScenePending)
        throw new Error('Load the complete board before saving.')
      if ((document.cloudGeneration ?? 1) !== (current.cloudGeneration ?? 1))
        throw new Error('BOARD_GENERATION_CONFLICT')
      const stale = document.revision < current.revision
      const protectedStatus = current.syncStatus === 'sync-blocked' || current.syncStatus === 'conflict'
      return {
        ...current,
        ...document,
        // Cloud identities belong to the latest atomic local state, not the React snapshot.
        cloudRevisionId: current.cloudRevisionId,
        cloudGeneration: current.cloudGeneration,
        cloudScenePending: current.cloudScenePending,
        scene: stale ? mergeSceneElements(document.scene, current.scene) : document.scene,
        name: stale ? current.name : document.name,
        active: current.active,
        updatedAt: now(),
        syncStatus: protectedStatus ? current.syncStatus : 'local-only',
        revision: Math.max(current.revision ?? 0, document.revision ?? 0) + 1,
        baseRevision: current.baseRevision,
        syncAttempts: protectedStatus ? current.syncAttempts : 0,
        nextSyncAt: null,
        lastSyncError: protectedStatus ? current.lastSyncError : null,
      }
    }
    if (!existingDocument) {
      try {
        const inserted = await (db.boards as any).insert(update(normalizedBoard(document)))
        return plain<BoardDocument>(inserted)
      } catch (error) {
        existingDocument = await (db.boards as any).findOne(document.id).exec()
        if (!existingDocument) throw error
      }
    }
    const updated = await existingDocument.incrementalModify(update)
    return plain<BoardDocument>(updated)
  }

  async upsertProject(project: Project): Promise<void> {
    const db = await database()
    const existing = await (db.projects as any).findOne(project.id).exec()
    if (existing) await existing.incrementalPatch(project)
    else await (db.projects as any).insert(project)
  }

  async upsertBoard(document: BoardDocument): Promise<void> {
    const db = await database()
    const existing = await (db.boards as any).findOne(document.id).exec()
    const normalized = normalizedBoard(document)
    if (existing) await existing.incrementalPatch(normalized)
    else await (db.boards as any).insert(normalized)
  }

  /** Metadata discovery must not erase a scene/save that arrived after its network read. */
  async upsertBoardMetadata(metadata: BoardDocument): Promise<void> {
    const db = await database()
    const document = await (db.boards as any).findOne(metadata.id).exec()
    if (!document) {
      try {
        await (db.boards as any).insert(normalizedBoard(metadata))
        return
      } catch (error) {
        // Another tab can create it after findOne; continue through the atomic merge.
        const created = await (db.boards as any).findOne(metadata.id).exec()
        if (!created) throw error
      }
    }
    const currentDocument = document ?? (await (db.boards as any).findOne(metadata.id).exec())
    if (!currentDocument) return
    await currentDocument.incrementalModify((current: BoardDocument) => {
      const pending = current.syncStatus !== 'synced'
      if (pending && !metadata.active)
        return {
          ...current,
          syncStatus: 'sync-blocked',
          lastSyncError: 'Board was deleted. Local changes are retained.',
          nextSyncAt: null,
        }
      return {
        ...current,
        name: pending ? current.name : metadata.name,
        active: metadata.active,
        createdAt: metadata.createdAt,
        updatedAt: pending ? current.updatedAt : metadata.updatedAt,
      }
    })
  }

  async listBoardsForSync(includeDeletedProjects?: boolean): Promise<Board[]> {
    const db = await database()
    const documents = await (db.boards as any).find().exec()
    const projects = new Set((await this.listProjects(includeDeletedProjects)).map((project) => project.id))
    return documents
      .map((document: any) => toBoard(plain<BoardDocument>(document)))
      .filter((board: Board) => projects.has(board.projectId))
  }

  async deleteBoard(boardId: string): Promise<void> {
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (!document) return
    const current = plain<BoardDocument>(document)
    await document.incrementalPatch({
      active: false,
      updatedAt: now(),
      syncStatus: 'local-only',
      revision: current.revision + 1,
      syncAttempts: 0,
      nextSyncAt: null,
      lastSyncError: null,
    })
  }

  async updateBoardSyncStatus(boardId: string, syncStatus: BoardSyncStatus): Promise<void> {
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (document) await document.incrementalPatch({ syncStatus })
  }

  async markBoardSynced(boardId: string, revision: number): Promise<void> {
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (document) {
      const current = plain<BoardDocument>(document)
      // A project tombstone can arrive while an earlier write is being acknowledged.
      if (current.syncStatus === 'sync-blocked') {
        await document.incrementalPatch({ baseRevision: Math.max(current.baseRevision, revision) })
        return
      }
      // Sync runs asynchronously. A newer local edit may have been saved while
      // the cloud acknowledgement for `revision` was in flight. In that case
      // acknowledge the committed base without replacing the newer local
      // revision; otherwise the editor's next optimistic write sees a stale
      // revision and fails with BOARD_REVISION_CONFLICT.
      if (current.revision > revision) {
        await document.incrementalPatch({
          baseRevision: Math.max(current.baseRevision, revision),
          syncStatus: current.syncStatus === 'sync-failed' ? 'sync-failed' : 'local-only',
        })
        return
      }
      await document.incrementalPatch({
        syncStatus: 'synced',
        baseRevision: revision,
        revision,
        syncAttempts: 0,
        nextSyncAt: null,
        lastSyncError: null,
      })
    }
  }

  /** Atomic ACK: a slow save must never overwrite edits made while it was uploading. */
  async acknowledgeBoardScene(
    boardId: string,
    revision: number,
    scene: BoardScene,
    cloudRevisionId: string,
    cloudGeneration: number,
    options?: { expectedCloudRevisionId: string | undefined },
  ): Promise<void> {
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (!document) return
    await document.incrementalModify((current: BoardDocument) => {
      if (current.cloudGeneration !== undefined && current.cloudGeneration !== cloudGeneration) return current
      const laterEdits = current.revision > revision
      const blocked = current.syncStatus === 'sync-blocked' || current.syncStatus === 'conflict'
      const headChanged =
        options &&
        current.cloudRevisionId !== options.expectedCloudRevisionId &&
        current.cloudRevisionId !== cloudRevisionId
      return {
        ...current,
        scene: blocked || headChanged ? current.scene : laterEdits ? mergeSceneElements(current.scene, scene) : scene,
        cloudRevisionId: headChanged || blocked ? current.cloudRevisionId : cloudRevisionId,
        cloudGeneration: headChanged || blocked ? current.cloudGeneration : cloudGeneration,
        cloudScenePending: false,
        baseRevision: Math.max(current.baseRevision, revision),
        syncStatus: blocked ? current.syncStatus : laterEdits ? 'local-only' : 'synced',
        syncAttempts: laterEdits || blocked ? current.syncAttempts : 0,
        nextSyncAt: laterEdits || blocked ? current.nextSyncAt : null,
        lastSyncError: laterEdits || blocked ? current.lastSyncError : null,
      }
    })
  }

  /** Apply an active board's cloud head without erasing pending local changes. */
  async applyCloudBoardScene(
    boardId: string,
    scene: BoardScene,
    cloudRevisionId: string,
    cloudGeneration: number,
    options?: { expectedCloudRevisionId: string | undefined },
  ): Promise<void> {
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (!document) return
    await document.incrementalModify((current: BoardDocument) => {
      if (
        (current.cloudRevisionId === cloudRevisionId && !current.cloudScenePending) ||
        current.syncStatus === 'sync-blocked'
      )
        return current
      if (options && current.cloudRevisionId !== options.expectedCloudRevisionId) return current
      const pending = current.syncStatus !== 'synced'
      if (
        pending &&
        (current.cloudGeneration === undefined ? cloudGeneration > 1 : current.cloudGeneration !== cloudGeneration)
      ) {
        return {
          ...current,
          syncStatus: 'conflict',
          lastSyncError: 'Board was restored or replaced. Local changes are retained for explicit recovery.',
        }
      }
      return {
        ...current,
        scene: pending ? mergeSceneElements(current.scene, scene) : scene,
        cloudRevisionId,
        cloudGeneration,
        cloudScenePending: false,
        // Hydration advances the local optimistic token, never substitutes another device's token.
        revision: current.revision + 1,
        baseRevision: pending ? current.baseRevision : current.revision + 1,
      }
    })
  }

  async markBoardConflict(boardId: string, error: string, expectedGeneration?: number): Promise<void> {
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (!document) return
    await document.incrementalModify((current: BoardDocument) => {
      if (current.syncStatus === 'sync-blocked') return current
      if (expectedGeneration !== undefined && (current.cloudGeneration ?? 1) !== expectedGeneration) return current
      return { ...current, syncStatus: 'conflict', nextSyncAt: null, lastSyncError: error }
    })
  }

  async markBoardSyncFailed(boardId: string, error: string, nextSyncAt: string): Promise<void> {
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (document) {
      const current = plain<BoardDocument>(document)
      await document.incrementalPatch({
        syncStatus: 'sync-failed',
        syncAttempts: current.syncAttempts + 1,
        nextSyncAt,
        lastSyncError: error,
      })
    }
  }

  async markBoardSyncBlocked(boardId: string, error: string): Promise<void> {
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (document)
      await document.incrementalPatch({ syncStatus: 'sync-blocked', lastSyncError: error, nextSyncAt: null })
  }

  async resumeBoardSync(boardId: string): Promise<void> {
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (document)
      await document.incrementalPatch({
        syncStatus: 'local-only',
        syncAttempts: 0,
        nextSyncAt: null,
        lastSyncError: null,
      })
  }

  async requeueConflictedBoard(boardId: string, remoteRevision: number): Promise<void> {
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (!document) return
    const current = plain<BoardDocument>(document)
    await document.incrementalPatch({
      syncStatus: 'local-only',
      baseRevision: remoteRevision,
      revision: Math.max(current.revision, remoteRevision) + 1,
      syncAttempts: 0,
      nextSyncAt: null,
      lastSyncError: null,
      updatedAt: now(),
    })
  }
}
