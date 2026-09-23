import { createRxDatabase } from 'rxdb'
import { getRxStorageLocalstorage } from 'rxdb/plugins/storage-localstorage'
import type { RxDatabase, RxJsonSchema } from 'rxdb'

export type ProjectRole = 'owner' | 'editor' | 'viewer'
export type BoardSyncStatus = 'local-only' | 'pending-sync' | 'syncing' | 'synced' | 'sync-failed'
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
  createdAt: string
  updatedAt: string
  syncStatus: BoardSyncStatus
  scene?: BoardScene
}
export type BoardScene = { elements: Record<string, unknown>[]; appState: Record<string, unknown> }
export type BoardDocument = Board & { scene: BoardScene; formatVersion: 1 }
export type WorkspaceBootstrap = { project: Project; board: BoardDocument }

/** Product-level boundary for local, desktop, and cloud persistence adapters. */
export interface WorkspaceStore {
  bootstrap(): Promise<WorkspaceBootstrap>
  listProjects(): Promise<Project[]>
  createProject(name: string, ownerId: string): Promise<Project>
  listBoards(projectId: string): Promise<Board[]>
  createBoard(projectId: string, name: string): Promise<BoardDocument>
  loadBoard(boardId: string): Promise<BoardDocument | null>
  saveBoard(document: BoardDocument): Promise<void>
  upsertProject(project: Project): Promise<void>
  upsertBoard(document: BoardDocument): Promise<void>
  updateBoardSyncStatus(boardId: string, syncStatus: BoardSyncStatus): Promise<void>
  deleteBoard(boardId: string): Promise<void>
}

type RxCollections = { projects: unknown; boards: unknown }
const LOCAL_PRINCIPAL_ID = 'local-user'
const DATABASE_NAME = 'agentic-whiteboard-v1'
const now = () => new Date().toISOString()
const newId = () => crypto.randomUUID()
const defaultScene = (): BoardScene => ({ elements: [], appState: { viewBackgroundColor: 'transparent' } })

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
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 100 },
    projectId: { type: 'string' },
    name: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    syncStatus: { type: 'string' },
    formatVersion: { type: 'number' },
    scene: { type: 'object', additionalProperties: true },
  },
  required: ['id', 'projectId', 'name', 'createdAt', 'updatedAt', 'syncStatus', 'formatVersion', 'scene'],
}

let databasePromise: Promise<RxDatabase<RxCollections>> | undefined

const database = () => {
  databasePromise ??= createRxDatabase<RxCollections>({
    name: DATABASE_NAME,
    storage: getRxStorageLocalstorage(),
    multiInstance: true,
    // Closes a stale instance left behind by Vite hot reload without weakening
    // RxDB's production duplicate-database safety checks.
    closeDuplicates: true,
  }).then(async (instance) => {
    await instance.addCollections({ projects: { schema: projectSchema }, boards: { schema: boardSchema } })
    return instance
  })
  return databasePromise
}

const plain = <T>(document: { toJSON: () => T }) => document.toJSON()
const toBoard = (document: BoardDocument): Board => {
  const { formatVersion: _formatVersion, ...board } = document
  return board
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
      const board = boards[0]
        ? await this.loadBoard(boards[0].id)
        : await this.createBoard(project.id, 'Untitled diagram')
      if (!board) throw new Error('The initial board could not be loaded.')
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
    const documents = await (db.boards as any).find({ selector: { projectId } }).exec()
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
      createdAt: timestamp,
      updatedAt: timestamp,
      syncStatus: 'local-only',
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

  async saveBoard(document: BoardDocument): Promise<void> {
    const db = await database()
    const existing = await (db.boards as any).findOne(document.id).exec()
    const updated = { ...document, updatedAt: now(), syncStatus: 'local-only' as const }
    if (existing) await existing.incrementalPatch(updated)
    else await (db.boards as any).insert(updated)
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
    if (existing) await existing.incrementalPatch(document)
    else await (db.boards as any).insert(document)
  }

  async deleteBoard(boardId: string): Promise<void> {
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (document) await document.remove()
  }

  async updateBoardSyncStatus(boardId: string, syncStatus: BoardSyncStatus): Promise<void> {
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (document) await document.incrementalPatch({ syncStatus })
  }
}
