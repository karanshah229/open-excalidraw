import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions'
import { getFirebaseApp, getSyncAccessFunctionRegion } from '../../lib/firebase'
import type { BoardDocument, Project } from '@agentic-whiteboard/storage'
import type { BoardShareConfig, ShareAccessLevel, ShareRole } from './sharing-service'

export type ProjectPolicy = {
  accessRevision?: number
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
let functions: ReturnType<typeof getFunctions> | undefined
export async function projectCall<T>(name: string, data: Record<string, unknown>): Promise<T> {
  if (!navigator.onLine) throw new Error('Connect to the internet to update cloud projects and sharing.')
  const app = getFirebaseApp()
  if (!app) throw new Error('Sign in to use cloud sharing.')
  if (!functions) {
    const region = getSyncAccessFunctionRegion()
    if (!region) throw new Error('Sharing service region is not configured.')
    functions = getFunctions(app, region)
    if (import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true') {
      connectFunctionsEmulator(
        functions,
        window.location.hostname,
        Number(import.meta.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT || 5001),
      )
    }
  }
  return (await httpsCallable<Record<string, unknown>, T>(functions, name)(data)).data
}
export const projectService = {
  manage: (projectId: string, action: 'share' | 'rename' | 'delete' | 'repair', extra: Record<string, unknown> = {}) =>
    projectCall<{ ok: boolean; policy?: ProjectPolicy }>('manageProject', { projectId, action, ...extra }),
  boardAccess: (
    boardId: string,
    projectId: string,
    action: 'share' | 'private' | 'inherit' | 'delete',
    policy?: Omit<ProjectPolicy, 'generalRole'> & { generalRole: BoardShareConfig['generalRole'] },
  ) =>
    projectCall<{ ok: boolean; policy: BoardShareConfig }>('manageBoardAccess', {
      boardId,
      projectId,
      action,
      ...(policy ? { policy, expectedRevision: policy.accessRevision ?? 0 } : {}),
    }),
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
