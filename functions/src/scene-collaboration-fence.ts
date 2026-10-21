import type { Database } from 'firebase-admin/database'

export type AbandonedRoomFenceResult<T> =
  | { status: 'lock-contended' }
  | { status: 'active-sessions' }
  | { status: 'completed'; value: T }

/**
 * Locks an abandoned room, closes RTDB admission, and verifies both session
 * registries before invoking checkpoint/prune work. The gate is reopened only
 * after a transaction confirms this invocation still owns the lock.
 */
export async function runWithAbandonedRoomFence<T>(args: {
  rtdb: Database
  boardId: string
  lockToken: string
  lockDurationMs: number
  work: () => Promise<T>
}): Promise<AbandonedRoomFenceResult<T>> {
  const { rtdb, boardId, lockToken, lockDurationMs, work } = args
  const lockRef = rtdb.ref(`system/compactionLocks/${boardId}`)
  const maintenanceRef = rtdb.ref(`system/sceneMaintenance/${boardId}`)
  const lock = await lockRef.transaction((current) => {
    if (current && Date.now() - Number(current.startedAt ?? 0) < lockDurationMs) return
    return { startedAt: Date.now(), token: lockToken }
  })
  if (!lock.committed) return { status: 'lock-contended' }

  let gateClaimed = false
  try {
    // Claim gate ownership and close admission atomically. A later invocation
    // that takes an expired lock replaces this owner token; the old invocation
    // then cannot reopen the newer owner's gate in its finally block.
    const gate = await maintenanceRef.transaction((current) => {
      // A generation reset may hold a durable closed gate across invocations.
      // An abandoned-room checkpoint must never replace that owner and reopen it.
      if (current?.admissionClosed === true && current?.admissionOwner !== lockToken) return
      return {
        ...(current ?? {}),
        admissionClosed: true,
        admissionOwner: lockToken,
      }
    })
    if (!gate.committed) throw new Error(`Could not close scene admission gate for ${boardId}`)
    gateClaimed = gate.snapshot.child('admissionOwner').val() === lockToken

    const [presence, activeSessions] = await Promise.all([
      rtdb.ref(`presence/${boardId}`).get(),
      rtdb.ref(`activeSessions/${boardId}`).get(),
    ])
    if (presence.exists() || activeSessions.exists()) return { status: 'active-sessions' }

    return { status: 'completed', value: await work() }
  } finally {
    // Refresh only our own lock before cleanup. This prevents a slow invocation
    // from reopening the gate after another worker has taken an expired lock.
    // Warm both exact references first: a cold Admin RTDB transaction cache can
    // initially pass null even after another read observed the value.
    const [lockSnapshot, maintenanceSnapshot] = await Promise.all([lockRef.get(), maintenanceRef.get()])
    const ownership = lockSnapshot.child('token').val() === lockToken
      ? await lockRef.transaction((current) => {
          if (current == null) return null
          if (current?.token !== lockToken) return
          return {
            ...current,
            startedAt: Math.max(Date.now(), Number(current.startedAt ?? 0) + 1),
            renewalId: `${lockToken}:${Date.now()}:${Math.random()}`,
          }
        })
      : null
    if (ownership?.committed && ownership.snapshot.val()?.token === lockToken) {
      try {
        if (gateClaimed && maintenanceSnapshot.child('admissionOwner').val() === lockToken) {
          await maintenanceRef.transaction((current) => {
            if (current == null) return null
            if (current?.admissionOwner !== lockToken) return
            return { ...current, admissionClosed: false, admissionOwner: null }
          })
        }
      } finally {
        await lockRef.transaction((current) => {
          if (current == null) return null
          return current?.token === lockToken ? null : undefined
        })
      }
    }
  }
}
