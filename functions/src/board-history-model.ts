import { HttpsError } from 'firebase-functions/v2/https'
import { getFirestore, Timestamp, type DocumentData, type Transaction } from 'firebase-admin/firestore'
import type { SceneActor } from './scene-access.js'

export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const historyId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value))
    throw new HttpsError('invalid-argument', 'Invalid history identifier.')
  return value
}
export function assertContentWritable(head: DocumentData, generation?: unknown, fence?: unknown) {
  if (head.historyCleanupLeaseUntil?.toMillis?.() > Date.now())
    throw new HttpsError('unavailable', 'Board history cleanup is in progress. Retry shortly.')
  if (head.restoreOperationId) throw new HttpsError('unavailable', 'Board restoration is in progress.')
  if (generation !== undefined && generation !== head.generation)
    throw new HttpsError('aborted', 'This board was restored.', { generation: head.generation })
  if (fence !== undefined && fence !== (head.restoreFence ?? 0))
    throw new HttpsError('aborted', 'The board restore fence changed.', { restoreFence: head.restoreFence ?? 0 })
}

/** Call only after all transaction reads. It atomically binds the complete content tuple to the head. */
export function publishContentVersion(
  tx: Transaction,
  boardId: string,
  head: DocumentData,
  actor: SceneActor,
  mutationId: string,
  patch: DocumentData,
  reason: string,
) {
  const db = getFirestore(),
    now = Timestamp.fromMillis(Math.max(Date.now(), (head.historyAcceptedAt?.toMillis?.() ?? 0) + 1)),
    versionId = mutationId,
    branchId = patch.currentBranchId ?? head.currentBranchId ?? `initial_${head.generation}`,
    sequence = (head.contentSequence ?? 0) + 1,
    branchSequence = patch.branchSequence ?? (head.branchSequence ?? 0) + 1
  const version = {
    sceneRevisionId: patch.headRevisionId ?? head.headRevisionId,
    sceneGeneration: patch.generation ?? head.generation,
    boardName: patch.boardName ?? head.boardName ?? 'Untitled board',
    notesRevisionId: Object.hasOwn(patch, 'notesRevisionId') ? patch.notesRevisionId : (head.notesRevisionId ?? null),
    branchId,
    branchSequence,
    contentSequence: sequence,
    parentVersionId: patch.parentVersionId ?? head.currentVersionId ?? null,
    actorUid: actor.uid,
    mutationId,
    reason,
    origin: 'cloud',
    serverCreatedAt: now,
    expiresAt: Timestamp.fromMillis(now.toMillis() + HISTORY_RETENTION_MS),
    ...(patch.restoreOf ? { restoreOf: patch.restoreOf, replacedHeadVersionId: head.currentVersionId ?? null } : {}),
  }
  tx.create(db.doc(`boardScenes/${boardId}/versions/${versionId}`), version)
  if (!head.currentBranchId && !patch.currentBranchId)
    tx.create(db.doc(`boardScenes/${boardId}/branches/${branchId}`), {
      generation: head.generation,
      kind: 'canonical',
      parentBranchId: null,
      forkSequence: null,
      forkVersionId: null,
      ancestorCeilings: {},
      createdAt: now,
    })
  const next: DocumentData = {
    ...patch,
    currentVersionId: versionId,
    currentBranchId: branchId,
    contentSequence: sequence,
    branchSequence,
    historyAcceptedAt: now,
    boardName: version.boardName,
    notesRevisionId: version.notesRevisionId,
    historyEpoch: patch.historyEpoch ?? head.historyEpoch ?? 0,
    branchCeilings: patch.branchCeilings ?? head.branchCeilings ?? { [branchId]: Number.MAX_SAFE_INTEGER },
    restoreFence: patch.restoreFence ?? head.restoreFence ?? 0,
    updatedAt: new Date(now.toMillis()).toISOString(),
  }
  // Publication-only fields belong on versions, not on the content head.
  delete next.parentVersionId
  delete next.restoreOf
  tx.update(db.doc(`boardScenes/${boardId}`), next)
  return { versionId, contentSequence: sequence, branchId, branchSequence }
}

/** Eligibility uses branch ancestry, never upload timestamps or mutable flags on chunks. */
export async function eligibleVersion(boardId: string, head: DocumentData, version: DocumentData, tx?: Transaction) {
  const db = getFirestore()
  const read = async (branchId: string) => {
    const ref = db.doc(`boardScenes/${boardId}/branches/${historyId(branchId)}`)
    return (tx ? await tx.get(ref) : await ref.get()).data()
  }
  if (head.branchCeilings && Object.hasOwn(head.branchCeilings, version.branchId))
    return version.branchSequence <= head.branchCeilings[version.branchId]
  let branchId = head.branchCeilings ? null : head.currentBranchId,
    ceiling = Infinity
  const visited = new Set<string>()
  while (branchId && visited.size < 100) {
    if (visited.has(branchId)) throw new HttpsError('failed-precondition', 'Corrupt history lineage.')
    visited.add(branchId)
    if (version.branchId === branchId) return version.branchSequence <= ceiling
    const branch = await read(branchId)
    if (!branch) return false
    ceiling = branch.forkSequence ?? Infinity
    branchId = branch.parentBranchId
  }
  if (branchId) throw new HttpsError('resource-exhausted', 'History lineage requires compaction before it can be read.')
  if (version.origin === 'offline-import') {
    const branch = await read(version.branchId)
    return (
      branch?.kind === 'local-import' &&
      branch.admittedHistoryEpoch === (head.historyEpoch ?? 0) &&
      branch.generation === head.generation
    )
  }
  return false
}
export function versionExpired(version: DocumentData, now = Date.now()) {
  return !version.expiresAt || version.expiresAt.toMillis() <= now
}

/** Compact a selected branch's immutable ancestor ceilings for constant-size lineage reads. */
export async function ancestorBranchPrefixes(boardId: string, branchId: string, sequence: number, tx: Transaction) {
  const db = getFirestore(),
    prefixes: Record<string, number> = { [branchId]: sequence },
    seen = new Set<string>()
  let current: string | null = branchId
  while (current && seen.size < 1000) {
    if (seen.has(current)) throw new HttpsError('failed-precondition', 'Corrupt history lineage.')
    seen.add(current)
    const branch = (await tx.get(db.doc(`boardScenes/${boardId}/branches/${current}`))).data()
    if (!branch) throw new HttpsError('failed-precondition', 'Missing history branch.')
    if (branch.ancestorCeilings) {
      Object.assign(prefixes, branch.ancestorCeilings)
      current = null
      break
    }
    current = branch.parentBranchId ?? null
    if (current) prefixes[current] = branch.forkSequence
  }
  if (current || Buffer.byteLength(JSON.stringify(prefixes)) > 128 * 1024)
    throw new HttpsError('resource-exhausted', 'History ancestry exceeds the bounded branch index.')
  return prefixes
}
