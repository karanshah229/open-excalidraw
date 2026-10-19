export type BoardHistoryEntry = {
  versionId: string
  boardName: string
  sceneRevisionId: string
  sceneGeneration: number
  notesRevisionId: string | null
  branchId: string
  branchSequence: number
  contentSequence?: number
  actorUid: string
  origin: 'cloud' | 'offline-import'
  reason: string
  serverCreatedAt: string
  expiresAt: string
  capturedAt?: string
  current: boolean
}
export type BoardHistoryHead = {
  generation: number
  restoreFence: number
  currentVersionId: string | null
  currentBranchId: string | null
  historyEpoch: number
  boardName: string
  nameRevision: number
  notesRevisionId: string | null
  restoreOperationId: string | null
}
export type BoardHistoryRequest = {
  boardId: string
  operation: 'list' | 'manifest' | 'pages' | 'chunks' | 'notes' | 'restore-status' | 'receipt'
  captureMutationId?: string
  operationId?: string
  versionId?: string
  cursor?: string
  contextId?: string
  page?: number
  chunkIds?: string[]
}
export type BoardHistoryManifest = {
  contextId: string
  versionId: string | null
  revisionId: string
  generation: number
  boardName: string
  pageCount: number
  chunkCount: number
  candidateDigest: string
  notesPageCount: number
  expiresAt: string
}
export type BoardRestoreRequest = {
  boardId: string
  operationId: string
  versionId: string
  expectedGeneration: number
  expectedFence: number
}
export type BoardRestoreResult = {
  operationId: string
  state: 'completed'
  generation: number
  restoreFence: number
  versionId: string
  revisionId: string
}
