import { cloudCall } from '../account/cloud-api'
import type { BoardDocument, Project } from '@agentic-whiteboard/storage'
import type { BoardShareConfig, ShareAccessLevel, ShareRole } from './sharing-service'

export type ProjectPolicy = {
  generalAccess: ShareAccessLevel
  generalRole: ShareRole
  collaborators: Record<string, { email: string; role: ShareRole; addedAt: string }>
  invitedEmails: string[]
  inheritProjectAccess?: boolean
}
export type VisibleProject = Project & {
  role?: 'owner' | ShareRole
  isShared?: boolean
  ownerName?: string
  archived?: boolean
  sharePolicy?: ProjectPolicy
}
export type VisibleBoard = BoardDocument & { inheritProjectAccess?: boolean; role?: 'owner' | ShareRole }
export async function projectCall<T>(name: string, data: Record<string, unknown>): Promise<T> {
  if (!navigator.onLine) throw new Error('Connect to the internet to update cloud projects and sharing.')
  return cloudCall<T>(name, data)
}
export const projectService = {
  manage: (projectId: string, action: 'share' | 'rename' | 'delete' | 'repair', extra: Record<string, unknown> = {}) =>
    projectCall('manageProject', { projectId, action, ...extra }),
  boardAccess: (
    boardId: string,
    projectId: string,
    action: 'share' | 'private' | 'inherit' | 'delete',
    policy?: ProjectPolicy,
  ) => projectCall('manageBoardAccess', { boardId, projectId, action, ...(policy ? { policy } : {}) }),
  list: (projectId?: string, includeOwnedPolicies = false, includeDirectBoards = false) =>
    projectCall<{
      projects: VisibleProject[]
      boards: VisibleBoard[]
      directBoards?: (VisibleBoard & { project: VisibleProject })[]
      ownedPolicies?: { projects: (ProjectPolicy & { projectId: string })[]; boards: BoardShareConfig[] }
    }>('listSharedProjects', {
      ...(projectId ? { projectId } : {}),
      ...(includeOwnedPolicies ? { includeOwnedPolicies } : {}),
      ...(includeDirectBoards ? { includeDirectBoards } : {}),
    }),
  createBoard: (projectId: string, name: string) =>
    projectCall<BoardDocument>('createProjectBoard', { projectId, name, boardId: crypto.randomUUID() }),
}
