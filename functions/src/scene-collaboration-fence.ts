import type { Database } from 'firebase-admin/database'
import type { Firestore } from 'firebase-admin/firestore'

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
  firestore?: Firestore
  work: () => Promise<T>
}): Promise<AbandonedRoomFenceResult<T>> {
  const { rtdb, boardId, lockToken, lockDurationMs, firestore, work } = args
  const lockRef = rtdb.ref(`system/compactionLocks/${boardId}`)
  const maintenanceRef = rtdb.ref(`system/sceneMaintenance/${boardId}`)
  const lock = await lockRef.transaction((current) => {
    if (current && Date.now() - Number(current.startedAt ?? 0) < lockDurationMs) return
    return { startedAt: Date.now(), token: lockToken }
  })
  if (!lock.committed) return { status: 'lock-contended' }

  let gateClaimed = false
  try {
    let recoveredOwner: string | null = null
    if (firestore) {
      const oldGate = (await maintenanceRef.get()).val()
      const oldOwner = oldGate?.admissionOwner
      if (oldGate?.admissionClosed === true && typeof oldOwner === 'string' && oldOwner !== lockToken) {
        const headRef = firestore.doc(`boardScenes/${boardId}`)
        const controlRef = firestore.doc(`boardScenes/${boardId}/maintenance/control`)
        const [controlSnapshot, headSnapshot] = await Promise.all([controlRef.get(), headRef.get()])
        const control = controlSnapshot.data(), head = headSnapshot.data()
        if (
          control?.admission === 'closed' && control.abandonedRoomOwner === oldOwner &&
          typeof control.leaseUntil?.toMillis === 'function' && control.leaseUntil.toMillis() <= Date.now() &&
          Number.isSafeInteger(control.epoch) && head?.maintenanceAdmission === 'closed' &&
          head.maintenanceEpoch === control.epoch
        ) recoveredOwner = oldOwner
      }
    }
    // Take over the still-closed RTDB gate before reopening Firestore. This keeps
    // RTDB admission continuously closed throughout cross-store crash recovery.
    const gate = await maintenanceRef.transaction((current) => {
      // A generation reset may hold a durable closed gate across invocations.
      // An abandoned-room checkpoint must never replace that owner.
      if (
        current?.admissionClosed === true && current?.admissionOwner !== lockToken &&
        current?.admissionOwner !== recoveredOwner
      ) return
      if (current?.admissionClosed === true && current?.admissionOwner === lockToken) return current
      const admissionEpoch = Number.isSafeInteger(current?.admissionEpoch) && current.admissionEpoch >= 0
        ? current.admissionEpoch + 1
        : 1
      return {
        ...(current ?? {}),
        admissionClosed: true,
        admissionOwner: lockToken,
        admissionEpoch,
      }
    })
    if (!gate.committed) throw new Error(`Could not close scene admission gate for ${boardId}`)
    gateClaimed = gate.snapshot.child('admissionOwner').val() === lockToken

    if (recoveredOwner && firestore) {
      const headRef = firestore.doc(`boardScenes/${boardId}`)
      const controlRef = firestore.doc(`boardScenes/${boardId}/maintenance/control`)
      const recovered = await firestore.runTransaction(async (tx) => {
        const control = (await tx.get(controlRef)).data(), head = (await tx.get(headRef)).data()
        if (
          control?.admission !== 'closed' || control?.abandonedRoomOwner !== recoveredOwner ||
          typeof control.leaseUntil?.toMillis !== 'function' || control.leaseUntil.toMillis() > Date.now() ||
          !Number.isSafeInteger(control.epoch) || head?.maintenanceAdmission !== 'closed' ||
          head.maintenanceEpoch !== control.epoch
        ) return false
        const nextEpoch = control.epoch + 1
        tx.update(controlRef, {
          admission: 'open', epoch: nextEpoch, token: null, abandonedRoomOwner: null,
          leaseUntil: null, jobId: null, phase: null, recoveredAt: new Date(), updatedAt: new Date(),
        })
        tx.update(headRef, { maintenanceAdmission: 'open', maintenanceEpoch: nextEpoch })
        return true
      })
      if (!recovered) {
        await maintenanceRef.transaction((current) => {
          if (current?.admissionOwner !== lockToken) return
          return { ...current, admissionClosed: true, admissionOwner: recoveredOwner }
        })
        gateClaimed = false
        throw new Error(`Expired Firestore compaction fence changed during recovery for ${boardId}`)
      }
    }

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
        if (firestore) {
          const headRef = firestore.doc(`boardScenes/${boardId}`)
          const controlRef = firestore.doc(`boardScenes/${boardId}/maintenance/control`)
          await firestore.runTransaction(async (tx) => {
            const control = (await tx.get(controlRef)).data(), head = (await tx.get(headRef)).data()
            if (
              control?.admission !== 'closed' || control?.abandonedRoomOwner !== lockToken ||
              !Number.isSafeInteger(control.epoch) || head?.maintenanceAdmission !== 'closed' ||
              head.maintenanceEpoch !== control.epoch
            ) return
            tx.update(controlRef, {
              admission: 'open', token: null, abandonedRoomOwner: null, leaseUntil: null,
              jobId: null, phase: null, updatedAt: new Date(),
            })
            tx.update(headRef, { maintenanceAdmission: 'open', maintenanceEpoch: control.epoch })
          })
        }
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
