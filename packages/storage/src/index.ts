import { boardHistoryStore, setBoardHistoryIdentity, type HistorySaveOptions } from './board-history'
import { mergeBoardScenes } from './scene-merge'
export { mergeBoardScenes } from './scene-merge'
export * from './board-history'
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
  cloudVersionId?: string
  cloudRestoreFence?: number
  cloudNameRevision?: number
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
  /** Server-authored compact tombstones; these are metadata, never Excalidraw elements. */
  deletionLedger?: Array<{
    id: string
    version: number
    versionNonce: number
    firstObservedDeletedAt: string
    compacted: boolean
  }>
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
  saveBoard(document: BoardDocument, options?: HistorySaveOptions): Promise<BoardDocument>
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
    options?: { expectedCloudRevisionId: string | undefined; cloudVersionId?: string; cloudRestoreFence?: number; cloudNameRevision?: number; cloudBoardName?: string },
  ): Promise<void>
  applyCloudBoardScene(
    boardId: string,
    scene: BoardScene,
    cloudRevisionId: string,
    cloudGeneration: number,
    options?: { expectedCloudRevisionId: string | undefined; cloudVersionId?: string; cloudRestoreFence?: number; cloudNameRevision?: number; cloudBoardName?: string; legacyGenerationAdvance?: boolean },
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
  setBoardHistoryIdentity(userId)
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
  version: 3,
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
    cloudVersionId: { type: 'string' },
    cloudRestoreFence: { type: 'number', minimum: 0 },
    cloudNameRevision: { type: 'number', minimum: 0 },
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
          3: (document: BoardDocument) => document,
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

    const claimedProjects = new Set(legitimateDocs.map((document: any) => plain<Project>(document).id))
    const allBoards = await (db.boards as any).find().exec()
    await boardHistoryStore.claimLocalBoards(
      allBoards.map(plain<BoardDocument>).filter((board: BoardDocument) => claimedProjects.has(board.projectId)).map((board: BoardDocument) => board.id),
      ownerId,
    )
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

    return [...claimedProjects] as string[]
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
    const documents = await (db.boards as any).find({ selector: { projectId } }).exec()
    const boards = new Map<string, BoardDocument>(documents.map((document: any) => {
      const board = plain<BoardDocument>(document)
      return [board.id, board]
    }))
    for (const document of await boardHistoryStore.listCurrentDocuments())
      if (document.projectId === projectId) boards.set(document.id, document)
    return [...boards.values()].filter((board) => board.active).map(toBoard)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
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
    const committed = await boardHistoryStore.initialize(document)
    await this.projectCommittedBoard(committed.document).catch(() => undefined)
    return committed.document
  }

  async loadBoard(boardId: string): Promise<BoardDocument | null> {
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    const committed = await boardHistoryStore.getCommittedContent(boardId)
    if (!document && !committed) return null
    const board = committed?.document ?? plain<BoardDocument>(document)
    const parent = (await this.listProjects(true)).find((project) => project.id === board.projectId)
    if (!parent) return null
    if (!committed) return board
    await this.projectCommittedBoard(committed.document).catch(() => undefined)
    return committed.document
  }

  async saveBoard(document: BoardDocument, options?: HistorySaveOptions): Promise<BoardDocument> {
    if (!(await this.listProjects(true)).some((project) => project.id === document.projectId))
      throw new Error('Project is unavailable.')
    const db = await database()
    const existing = await (db.boards as any).findOne(document.id).exec()
    if (existing && !(await boardHistoryStore.getCommittedContent(document.id)))
      await boardHistoryStore.initialize(plain<BoardDocument>(existing))
    const committed = await boardHistoryStore.save(document, options)
    // Once the native transaction succeeds, a projection failure cannot turn a
    // durable save into an apparent failure. Authoritative reads repair it later.
    await this.projectCommittedBoard(committed.document).catch(() => undefined)
    return committed.document
  }

  private async projectCommittedBoard(document: BoardDocument): Promise<void> {
    const db = await database()
    const existing = await (db.boards as any).findOne(document.id).exec()
    if (existing) await existing.incrementalModify((current: BoardDocument) =>
      current.revision > document.revision ? current : document)
    else await (db.boards as any).insert(document)
  }

  private async reconcileProjectedBoard(boardId: string): Promise<void> {
    const db = await database()
    const existing = await (db.boards as any).findOne(boardId).exec()
    if (existing) await boardHistoryStore.reconcileDocument(plain<BoardDocument>(existing))

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
    await this.reconcileProjectedBoard(document.id)
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
    await this.reconcileProjectedBoard(metadata.id)
  }

  async listBoardsForSync(includeDeletedProjects?: boolean): Promise<Board[]> {
    const db = await database()
    const documents = await (db.boards as any).find().exec()
    const projects = new Set((await this.listProjects(includeDeletedProjects)).map((project) => project.id))
    const boards = new Map<string, BoardDocument>(documents.map((document: any) => {
      const board = plain<BoardDocument>(document)
      return [board.id, board]
    }))
    for (const document of await boardHistoryStore.listCurrentDocuments()) boards.set(document.id, document)
    return [...boards.values()].filter((board) => projects.has(board.projectId)).map(toBoard)
  }

  async deleteBoard(boardId: string): Promise<void> {
    await this.loadBoard(boardId)
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
    await this.reconcileProjectedBoard(boardId)
  }

  async updateBoardSyncStatus(boardId: string, syncStatus: BoardSyncStatus): Promise<void> {
    await this.loadBoard(boardId)
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (document) await document.incrementalPatch({ syncStatus })
    await this.reconcileProjectedBoard(boardId)
  }

  async markBoardSynced(boardId: string, revision: number): Promise<void> {
    await this.loadBoard(boardId)
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (document) {
      const current = plain<BoardDocument>(document)
      // A project tombstone can arrive while an earlier write is being acknowledged.
      if (current.syncStatus === 'sync-blocked') {
        await document.incrementalPatch({ baseRevision: Math.max(current.baseRevision, revision) })
        await this.reconcileProjectedBoard(boardId)
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
        await this.reconcileProjectedBoard(boardId)
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
    await this.reconcileProjectedBoard(boardId)
  }

  /** Atomic ACK: a slow save must never overwrite edits made while it was uploading. */
  async acknowledgeBoardScene(
    boardId: string,
    revision: number,
    scene: BoardScene,
    cloudRevisionId: string,
    cloudGeneration: number,
    options?: { expectedCloudRevisionId: string | undefined; cloudVersionId?: string; cloudRestoreFence?: number; cloudNameRevision?: number; cloudBoardName?: string },
  ): Promise<void> {
    await this.loadBoard(boardId)
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (!document) return
    const pendingRename = (await boardHistoryStore.listOutbox(boardId))
      .some((entry) => !entry.headAcknowledged && entry.changedFields.name)
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
        scene: blocked || headChanged ? current.scene : laterEdits ? mergeBoardScenes(current.scene, scene) : scene,
        name: blocked || headChanged || laterEdits || pendingRename ? current.name : options?.cloudBoardName ?? current.name,
        cloudRevisionId: headChanged || blocked ? current.cloudRevisionId : cloudRevisionId,
        cloudGeneration: headChanged || blocked ? current.cloudGeneration : cloudGeneration,
        cloudVersionId: headChanged || blocked ? current.cloudVersionId : options?.cloudVersionId ?? current.cloudVersionId,
        cloudRestoreFence: headChanged || blocked ? current.cloudRestoreFence : options?.cloudRestoreFence ?? current.cloudRestoreFence,
        cloudNameRevision: headChanged || blocked ? current.cloudNameRevision : options?.cloudNameRevision ?? current.cloudNameRevision,
        cloudScenePending: false,
        baseRevision: Math.max(current.baseRevision, revision),
        syncStatus: blocked ? current.syncStatus : laterEdits ? 'local-only' : 'synced',
        syncAttempts: laterEdits || blocked ? current.syncAttempts : 0,
        nextSyncAt: laterEdits || blocked ? current.nextSyncAt : null,
        lastSyncError: laterEdits || blocked ? current.lastSyncError : null,
      }
    })
    await this.reconcileProjectedBoard(boardId)
  }

  /** Apply an active board's cloud head without erasing pending local changes. */
  async applyCloudBoardScene(
    boardId: string,
    scene: BoardScene,
    cloudRevisionId: string,
    cloudGeneration: number,
    options?: { expectedCloudRevisionId: string | undefined; cloudVersionId?: string; cloudRestoreFence?: number; cloudNameRevision?: number; cloudBoardName?: string; legacyGenerationAdvance?: boolean },
  ): Promise<void> {
    await this.loadBoard(boardId)
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (!document) return
    const pendingRename = (await boardHistoryStore.listOutbox(boardId))
      .some((entry) => !entry.headAcknowledged && entry.changedFields.name)
    await document.incrementalModify((current: BoardDocument) => {
      if (current.syncStatus === 'sync-blocked') return current
      if (current.cloudRevisionId === cloudRevisionId && !current.cloudScenePending && current.syncStatus === 'synced')
        return {
          ...current,
          cloudGeneration,
          cloudVersionId: options?.cloudVersionId ?? current.cloudVersionId,
          cloudRestoreFence: options?.cloudRestoreFence ?? current.cloudRestoreFence,
          cloudNameRevision: options?.cloudNameRevision ?? current.cloudNameRevision,
          name: pendingRename ? current.name : options?.cloudBoardName ?? current.name,
        }
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
        scene: pending ? mergeBoardScenes(current.scene, scene) : scene,
        cloudRevisionId,
        cloudGeneration,
        cloudVersionId: options?.cloudVersionId ?? current.cloudVersionId,
        cloudRestoreFence: options?.cloudRestoreFence ?? current.cloudRestoreFence,
        cloudNameRevision: options?.cloudNameRevision ?? current.cloudNameRevision,
        cloudScenePending: false,
        name: pendingRename ? current.name : options?.cloudBoardName ?? current.name,
        // Hydration advances the local optimistic token, never substitutes another device's token.
        revision: current.revision + 1,
        baseRevision: pending ? current.baseRevision : current.revision + 1,
      }
    })
    const updated = await (db.boards as any).findOne(boardId).exec()
    if (updated) {
      const value = plain<BoardDocument>(updated)
      const local = await boardHistoryStore.getCommittedContent(boardId)
      if (!local || (local.document.cloudGeneration ?? 1) === (value.cloudGeneration ?? 1))
        await this.reconcileProjectedBoard(boardId)
      else if (options?.legacyGenerationAdvance)
        await boardHistoryStore.reconcileDocument(value, { allowLegacyGenerationAdvance: true })
    }
  }

  async markBoardConflict(boardId: string, error: string, expectedGeneration?: number): Promise<void> {
    await this.loadBoard(boardId)
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (!document) return
    await document.incrementalModify((current: BoardDocument) => {
      if (current.syncStatus === 'sync-blocked') return current
      if (expectedGeneration !== undefined && (current.cloudGeneration ?? 1) !== expectedGeneration) return current
      return { ...current, syncStatus: 'conflict', nextSyncAt: null, lastSyncError: error }
    })
    await this.reconcileProjectedBoard(boardId)
  }

  async markBoardSyncFailed(boardId: string, error: string, nextSyncAt: string): Promise<void> {
    await this.loadBoard(boardId)
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
    await this.reconcileProjectedBoard(boardId)
  }

  async markBoardSyncBlocked(boardId: string, error: string): Promise<void> {
    await this.loadBoard(boardId)
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (document)
      await document.incrementalPatch({ syncStatus: 'sync-blocked', lastSyncError: error, nextSyncAt: null })
    await this.reconcileProjectedBoard(boardId)
  }

  async resumeBoardSync(boardId: string): Promise<void> {
    await this.loadBoard(boardId)
    const db = await database()
    const document = await (db.boards as any).findOne(boardId).exec()
    if (document)
      await document.incrementalPatch({
        syncStatus: 'local-only',
        syncAttempts: 0,
        nextSyncAt: null,
        lastSyncError: null,
      })
    await this.reconcileProjectedBoard(boardId)
  }

  async requeueConflictedBoard(boardId: string, remoteRevision: number): Promise<void> {
    await this.loadBoard(boardId)
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
    await this.reconcileProjectedBoard(boardId)
  }
}
