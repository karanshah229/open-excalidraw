import { addRxPlugin, createRxDatabase } from 'rxdb'
import { getRxStorageLocalstorage } from 'rxdb/plugins/storage-localstorage'
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie'
import { RxDBMigrationSchemaPlugin } from 'rxdb/plugins/migration-schema'
import type { RxDatabase, RxJsonSchema } from 'rxdb'

export type ProjectRole = 'owner' | 'editor' | 'viewer'
export type BoardSyncStatus = 'local-only' | 'synced' | 'sync-failed' | 'conflict'
export type ProjectMember = { principalId: string; role: ProjectRole }

export type Project = {
  id: string
  name: string
  ownerId: string
  members: ProjectMember[]
  createdAt: string
  updatedAt: string
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
  syncAttempts: number
  nextSyncAt: string | null
  lastSyncError: string | null
  scene?: BoardScene
}
export type BoardScene = { elements: Record<string, unknown>[]; appState: Record<string, unknown> }
export type BoardDocument = Board & { scene: BoardScene; formatVersion: 1 }
export type WorkspaceBootstrap = { project: Project; board: BoardDocument | null }

/** Product-level boundary for local, desktop, and cloud persistence adapters. */
export interface WorkspaceStore {
  bootstrap(): Promise<WorkspaceBootstrap>
  listProjects(): Promise<Project[]>
  claimLocalProjects(ownerId: string): Promise<string[]>
  createProject(name: string, ownerId: string): Promise<Project>
  listBoards(projectId: string): Promise<Board[]>
  createBoard(projectId: string, name: string): Promise<BoardDocument>
  loadBoard(boardId: string): Promise<BoardDocument | null>
  saveBoard(document: BoardDocument): Promise<BoardDocument>
  upsertProject(project: Project): Promise<void>
  upsertBoard(document: BoardDocument): Promise<void>
  updateBoardSyncStatus(boardId: string, syncStatus: BoardSyncStatus): Promise<void>
  markBoardSynced(boardId: string, revision: number): Promise<void>
  markBoardSyncFailed(boardId: string, error: string, nextSyncAt: string): Promise<void>
  markBoardConflict(boardId: string, error: string): Promise<void>
  requeueConflictedBoard(boardId: string, remoteRevision: number): Promise<void>
  listBoardsForSync(): Promise<Board[]>
  deleteBoard(boardId: string): Promise<void>
}

type RxCollections = { projects: unknown; boards: unknown }
const LOCAL_PRINCIPAL_ID = 'local-user'
const DATABASE_NAME = 'agentic-whiteboard-v2'
const LEGACY_DATABASE_NAME = 'agentic-whiteboard-v1'
const now = () => new Date().toISOString()
const newId = () => crypto.randomUUID()
const defaultScene = (): BoardScene => ({ elements: [], appState: { viewBackgroundColor: 'transparent' } })

addRxPlugin(RxDBMigrationSchemaPlugin)

const projectSchema: RxJsonSchema<Project> = {
  title: 'project schema',
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 100 },
    name: { type: 'string' },
    ownerId: { type: 'string' },
    members: { type: 'array', items: { type: 'object', additionalProperties: true } },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
  required: ['id', 'name', 'ownerId', 'members', 'createdAt', 'updatedAt'],
}

const boardSchema: RxJsonSchema<BoardDocument> = {
  title: 'board schema',
  version: 1,
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
      projects: { schema: projectSchema },
      boards: {
        schema: boardSchema,
        migrationStrategies: {
          1: (document: BoardDocument) => ({ ...document, active: document.active ?? true }),
        },
      },
    })
    await migrateLegacyLocalStorage(instance)
    return instance
  })
  return databasePromise
}

const plain = <T>(document: { toJSON: () => T }) => document.toJSON()
const toBoard = (document: BoardDocument): Board => {
  const { formatVersion: _formatVersion, ...board } = document
  return board
}

const normalizedBoard = (document: Omit<BoardDocument, 'revision' | 'baseRevision' | 'syncAttempts' | 'nextSyncAt' | 'lastSyncError'> & Partial<BoardDocument>): BoardDocument => ({
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
      projects: { schema: projectSchema },
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

    const [product, research, personal] = await Promise.all([
      this.createProject('Product design', LOCAL_PRINCIPAL_ID),
      this.createProject('Research', LOCAL_PRINCIPAL_ID),
      this.createProject('Personal', LOCAL_PRINCIPAL_ID),
    ])
    const [firstBoard] = await Promise.all([
      this.createBoard(product.id, 'Q3 Planning'),
      this.createBoard(product.id, 'Mobile flows'),
      this.createBoard(research.id, 'Research synthesis'),
      this.createBoard(personal.id, 'Untitled'),
    ])
    return { project: product, board: firstBoard }
  }

  async listProjects(): Promise<Project[]> {
    const db = await database()
    const documents = await (db.projects as any).find().exec()
    return documents
      .map(plain<Project>)
      .toSorted((left: Project, right: Project) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /** Assign offline bootstrap projects to the signed-in user before cloud sync. */
  async claimLocalProjects(ownerId: string): Promise<string[]> {
    const db = await database()
    const documents = await (db.projects as any).find({ selector: { ownerId: LOCAL_PRINCIPAL_ID } }).exec()

    await Promise.all(
      documents.map(async (document: any) => {
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

    return documents.map((document: any) => plain<Project>(document).id)
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
    const documents = await (db.boards as any).find({ selector: { projectId, active: true } }).exec()
    return documents
      .map((document: any) => toBoard(plain<BoardDocument>(document)))
      .toSorted((left: Board, right: Board) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async createBoard(projectId: string, name: string): Promise<BoardDocument> {
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
    return document ? plain<BoardDocument>(document) : null
  }

  async saveBoard(document: BoardDocument): Promise<BoardDocument> {
    const db = await database()
    const existingDocument = await (db.boards as any).findOne(document.id).exec()
    const current = existingDocument ? plain<BoardDocument>(existingDocument) : normalizedBoard(document)
    if (existingDocument && document.revision !== current.revision) {
      await existingDocument.incrementalPatch({
        syncStatus: 'conflict',
        nextSyncAt: null,
        lastSyncError: 'This board changed in another tab or device. Your local copy was preserved.',
      })
      throw new Error('BOARD_REVISION_CONFLICT')
    }
    const updated: BoardDocument = {
      ...document,
      active: document.active ?? current.active ?? true,
      updatedAt: now(),
      syncStatus: 'local-only',
      // React can still hold the pre-ACK document. Allocate the next revision
      // from IndexedDB so a completed sync can never be followed by a stale save.
      revision: current.revision + 1,
      baseRevision: current.baseRevision,
      syncAttempts: 0,
      nextSyncAt: null,
      lastSyncError: null,
    }
    if (existingDocument) await existingDocument.incrementalPatch(updated)
    else await (db.boards as any).insert(updated)
    return updated
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

  async listBoardsForSync(): Promise<Board[]> {
    const db = await database()
    const documents = await (db.boards as any).find().exec()
    return documents.map((document: any) => toBoard(plain<BoardDocument>(document)))
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

  async markBoardConflict(boardId: string, error: string): Promise<void> {
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (document) await document.incrementalPatch({ syncStatus: 'conflict', lastSyncError: error, nextSyncAt: null })
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
