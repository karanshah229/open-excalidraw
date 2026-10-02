import { initializeApp } from 'firebase-admin/app'
import { getDatabase } from 'firebase-admin/database'
import { getFirestore } from 'firebase-admin/firestore'
import { onValueDeleted } from 'firebase-functions/v2/database'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { defineString } from 'firebase-functions/params'
import { mirrorCurrentPolicy } from './project-access.js'
export {
  manageProject,
  manageBoardAccess,
  listSharedProjects,
  createProjectBoard,
  mirrorProjectAccess,
  publishProjectBoard,
} from './project-access.js'

initializeApp()

const GRACE_PERIOD_MS = 30_000
const COMPACTION_LOCK_MS = 120_000

// These deploy-time parameters prevent an implicit fallback to a region that
// may be far from, or incompatible with, the triggering data store.
const rtdbFunctionRegion = defineString('RTDB_FUNCTION_REGION')
const firestoreFunctionRegion = defineString('FIRESTORE_FUNCTION_REGION')
const syncAccessFunctionRegion = defineString('SYNC_ACCESS_FUNCTION_REGION')

type ElementDeltaRecord = { id?: string; version?: number; versionNonce?: number; data?: string }

function mergeDeltas(baseElements: any[], records: ElementDeltaRecord[]): any[] {
  const elements = new Map<string, any>()
  for (const element of baseElements) if (element?.id) elements.set(element.id, { ...element })

  for (const record of records) {
    if (!record.id || typeof record.data !== 'string') continue
    let patch: any
    try {
      patch = JSON.parse(record.data)
    } catch {
      continue
    }
    if (!patch?.id || patch.id !== record.id) continue

    const existing = elements.get(patch.id)
    if (!existing) {
      if (
        typeof patch.type !== 'string' ||
        typeof patch.x !== 'number' ||
        typeof patch.y !== 'number' ||
        typeof patch.width !== 'number' ||
        typeof patch.height !== 'number'
      ) {
        continue
      }
      elements.set(patch.id, patch)
      continue
    }

    const version = Number(patch.version ?? record.version ?? 0)
    const nonce = Number(patch.versionNonce ?? record.versionNonce ?? 0)
    const existingVersion = Number(existing.version ?? 0)
    const existingNonce = Number(existing.versionNonce ?? 0)
    if (version > existingVersion || (version === existingVersion && nonce < existingNonce)) {
      elements.set(patch.id, { ...existing, ...patch })
    }
  }
  return Array.from(elements.values())
}

/**
 * Compacts an abandoned live room after a grace period. This is the durable
 * fallback for simultaneous crashes, where no browser remains to flush state.
 */
export const compactAbandonedCollaborationRoom = onValueDeleted(
  { ref: '/presence/{boardId}/{sessionId}', region: rtdbFunctionRegion, timeoutSeconds: 120 },
  async (event) => {
    const boardId = event.params.boardId
    const rtdb = getDatabase()
    const firestore = getFirestore()
    const presenceRef = rtdb.ref(`presence/${boardId}`)

    if ((await presenceRef.get()).exists()) return
    await new Promise<void>((resolve) => setTimeout(resolve, GRACE_PERIOD_MS))
    if ((await presenceRef.get()).exists()) return

    const lockRef = rtdb.ref(`system/compactionLocks/${boardId}`)
    const lock = await lockRef.transaction((current) => {
      if (current && Date.now() - Number(current.startedAt ?? 0) < COMPACTION_LOCK_MS) return
      return { startedAt: Date.now() }
    })
    if (!lock.committed) return

    const elementsRef = rtdb.ref(`boards/${boardId}/elements`)
    try {
      const deltaSnapshot = await elementsRef.get()
      if (!deltaSnapshot.exists()) return

      const records = Object.values((deltaSnapshot.val() ?? {}) as Record<string, ElementDeltaRecord>)

      const compacted = await firestore.runTransaction(async (transaction) => {
        const boardRef = firestore.doc(`boardShares/${boardId}`)
        const current = await transaction.get(boardRef)
        if (!current.exists) return false
        const currentData = current.data() ?? {}
        if (currentData.deletedAt || currentData.pending) return false
        if (currentData.projectId) {
          const parent = await transaction.get(firestore.doc(`projectShares/${currentData.projectId}`))
          if (parent.data()?.deletedAt || parent.data()?.pending) return false
        }
        const revision = Number(currentData.snapshotRevision ?? 0) + 1
        const scene = {
          ...(currentData.scene ?? {}),
          elements: mergeDeltas(currentData.scene?.elements ?? [], records),
        }
        const updatedAt = new Date().toISOString()
        transaction.update(boardRef, { scene, snapshotRevision: revision, updatedAt })
        transaction.set(firestore.doc(`boardShares/${boardId}/history/${String(revision).padStart(12, '0')}`), {
          revision,
          scene,
          reason: 'abandoned-room-compaction',
          createdAt: updatedAt,
        })
        return true
      })

      // A reconnect after the grace period must retain its live data. A newly
      // connected client also seeds full elements, so skipping this prune is safe.
      if (compacted && !(await presenceRef.get()).exists()) await elementsRef.remove()
    } finally {
      await lockRef.remove()
    }
  },
)

/** Mirrors Firestore sharing policy into RTDB because RTDB rules cannot query Firestore. */
export const mirrorBoardAccessToRtdb = onDocumentWritten(
  { document: 'boardShares/{boardId}', region: firestoreFunctionRegion },
  async (event) => {
    const boardId = event.params.boardId
    await mirrorCurrentPolicy('board', boardId)
  },
)

/**
 * Synchronously establishes RTDB access after an owner saves sharing policy.
 * The Firestore trigger above stays as an eventual-consistency repair path.
 */
export const syncBoardAccessToRtdb = onCall({ region: syncAccessFunctionRegion }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication is required.')
  const boardId = request.data?.boardId
  if (typeof boardId !== 'string' || !boardId) {
    throw new HttpsError('invalid-argument', 'A board ID is required.')
  }

  const board = await getFirestore().doc(`boardShares/${boardId}`).get()
  if (!board.exists) throw new HttpsError('not-found', 'Board sharing policy was not found.')
  const config = board.data() ?? {}
  if (config.ownerId !== request.auth.uid) {
    throw new HttpsError('permission-denied', 'Only the board owner can synchronize sharing access.')
  }

  await mirrorCurrentPolicy('board', boardId)
  return { mirrored: true }
})
