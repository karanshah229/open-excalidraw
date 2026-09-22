import { RxDbWorkspaceStore } from '@agentic-whiteboard/storage'
import type { Board, BoardDocument, Project } from '@agentic-whiteboard/storage'

export type WorkspaceBoard = Board & { project: Project }
export const workspaceStore = new RxDbWorkspaceStore()

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
  createBoard: (projectId: string, name: string) => workspaceStore.createBoard(projectId, name),
  createProject: (name: string) => workspaceStore.createProject(name, 'local-user'),
  deleteBoard: (boardId: string) => workspaceStore.deleteBoard(boardId),
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
    return updated
  },
  saveBoard: (document: BoardDocument) => workspaceStore.saveBoard(document),
}
