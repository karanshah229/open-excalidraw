export interface CollaboratorPresence {
  userId: string
  sessionId: string
  displayName: string
  color: string
  avatarUrl?: string
  isAnonymous: boolean
  cursor?: { x: number; y: number } | null
  selectedElementIds?: string[]
  lastSeen: number
}

export interface ElementDeltaRecord {
  id: string
  version: number
  versionNonce: number
  lastModifiedBy: string
  updatedAt: number
  data: string
}

export interface CollabSnapshot {
  elements: any[]
  appState: Record<string, unknown>
  version: number
  updatedAt: string
}

export interface CollabUser {
  uid: string
  sessionId: string
  displayName: string
  color: string
  avatarUrl?: string
  isAnonymous: boolean
}
