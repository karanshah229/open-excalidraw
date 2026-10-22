/** RTDB security regression: a closed maintenance gate admits no new session or scene writes. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIREBASE_DATABASE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error('RTDB maintenance fence tests require disposable demo-regression Auth/RTDB emulators.')
}
const require = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase/app')
const { getAuth, connectAuthEmulator, signInAnonymously, signOut } = require('firebase/auth')
const { getDatabase, connectDatabaseEmulator, ref, set, remove, onDisconnect, goOffline, goOnline, onValue } = require('firebase/database')
const { initializeApp: initializeAdminApp, deleteApp: deleteAdminApp } = createRequire(new URL('../functions/package.json', import.meta.url))('firebase-admin/app')
const { getDatabase: getAdminDatabase } = createRequire(new URL('../functions/package.json', import.meta.url))('firebase-admin/database')
const { getFirestore: getAdminFirestore, Timestamp } = createRequire(new URL('../functions/package.json', import.meta.url))('firebase-admin/firestore')
const { runWithAbandonedRoomFence } = await import('../functions/lib/scene-collaboration-fence.js')
const { pruneCheckpointedRecords } = await import('../functions/lib/scene-compaction-cleanup.js')
const { mintSceneConnectionEpochForSession } = await import('../functions/lib/scene-connection-epoch.js')

const projectId = 'demo-regression'
const boardId = `maintenance-fence-${Date.now()}`
const adminApp = initializeAdminApp({ projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` }, `fence-admin-${Date.now()}`)
const adminDb = getAdminDatabase(adminApp)
const adminFirestore = getAdminFirestore(adminApp)
const clientApp = initializeApp({ apiKey: 'demo-key', authDomain: `${projectId}.firebaseapp.com`, projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` }, `fence-client-${Date.now()}`)
const auth = getAuth(clientApp)
connectAuthEmulator(auth, 'http://127.0.0.1:49099', { disableWarnings: true })
const credential = await signInAnonymously(auth)
const uid = credential.user.uid
const db = getDatabase(clientApp)
connectDatabaseEmulator(db, '127.0.0.1', 49000)
const boardPath = `boards/${boardId}/elements`
const presencePath = `presence/${boardId}`
const activePath = `activeSessions/${boardId}`
const gatePath = `system/sceneMaintenance/${boardId}/admissionClosed`
let currentEpoch = ''
const presenceRecord = (connectionEpoch, sceneGeneration = 1) => ({ userId: uid, sessionId: uid, connectionEpoch, sceneGeneration, displayName: 'Tester', color: '#000', lastSeen: Date.now() })
const deltaRecord = (connectionEpoch, version = 1) => ({ id: 'element-1', version, versionNonce: version, lastModifiedBy: uid, sessionId: uid, connectionEpoch, data: JSON.stringify({ version }) })
const denied = async (promise, message) => assert.rejects(promise, (error) => error?.code === 'PERMISSION_DENIED' || error?.code === 'database/permission-denied', message)

try {
  await adminDb.ref(`boardAccess/${boardId}`).set({ ownerId: uid, ownerActive: true, projectId: `fence-project-${boardId}`, publicRead: true, publicWrite: false, blocked: false })
  const firstEpoch = await mintSceneConnectionEpochForSession({ uid }, boardId, uid, 1, adminDb)
  currentEpoch = firstEpoch.connectionEpoch
  await assert.rejects(
    mintSceneConnectionEpochForSession({ uid: 'unauthorized-user' }, boardId, uid, 1, adminDb),
    (error) => error?.code === 'permission-denied',
    'callable must deny users without current board write access',
  )
  await set(ref(db, `${presencePath}/${uid}`), presenceRecord(currentEpoch))
  await set(ref(db, `${activePath}/${uid}`), { userId: uid, sessionId: uid, sceneGeneration: 1, joinedAt: Date.now(), lastSeen: Date.now() })
  await adminDb.ref(`${presencePath}/other-user`).set({ userId: 'other-user', sessionId: 'other-user', displayName: 'Other', color: '#fff', lastSeen: Date.now() })
  await adminDb.ref(`${activePath}/other-user`).set({ userId: 'other-user', sessionId: 'other-user', joinedAt: Date.now(), lastSeen: Date.now() })
  await set(ref(db, `${boardPath}/element-1`), deltaRecord(currentEpoch))

  // A reconnect rotates a server-owned token. Even if queued old presence is
  // replayed after the rotation, rules deny it and its following delta.
  const secondEpoch = await mintSceneConnectionEpochForSession({ uid }, boardId, uid, 1, adminDb)
  assert.equal(secondEpoch.generation, firstEpoch.generation + 1)
  currentEpoch = secondEpoch.connectionEpoch
  await denied(set(ref(db, `${boardPath}/element-1`), deltaRecord(firstEpoch.connectionEpoch, 2)), 'reconnect must reject a queued delta from the prior epoch')
  await denied(set(ref(db, `${presencePath}/${uid}`), presenceRecord(firstEpoch.connectionEpoch)), 'reconnect must reject a queued old presence replay')
  await set(ref(db, `${presencePath}/${uid}`), presenceRecord(currentEpoch))
  await set(ref(db, `${boardPath}/element-1`), deltaRecord(currentEpoch, 2))

  // A pre-fence session may have an epoch token but no admissionEpoch field.
  // It remains valid only until the first maintenance fence advances the board epoch.
  const admissionBoard = `${boardId}-admission-epoch`
  const admissionSession = 'legacy-session'
  await adminDb.ref(`boardAccess/${admissionBoard}`).set({
    ownerId: uid, ownerActive: true, projectId: `project-${admissionBoard}`, blocked: false,
  })
  await adminDb.ref(`boards/${admissionBoard}`).update({ generation: 1, restoreFence: 0 })
  const legacyEpoch = await mintSceneConnectionEpochForSession({ uid }, admissionBoard, admissionSession, 1, adminDb)
  const legacyEpochRef = adminDb.ref(`system/sceneConnectionEpochs/${admissionBoard}/${admissionSession}`)
  await legacyEpochRef.child('admissionEpoch').remove()
  const admissionPresenceRef = ref(db, `presence/${admissionBoard}/${admissionSession}`)
  const generationPresenceRef = ref(db, `presence/${admissionBoard}/generations/1/${admissionSession}`)
  const admissionDeltaRef = ref(db, `boards/${admissionBoard}/elements/legacy-element`)
  const legacyPresence = (lastSeen = Date.now()) => ({
    ...presenceRecord(legacyEpoch.connectionEpoch), sessionId: admissionSession, lastSeen,
  })
  const legacyDelta = (version = 1) => ({
    ...deltaRecord(legacyEpoch.connectionEpoch, version), id: 'legacy-element', sessionId: admissionSession,
  })
  const generationPresence = (connectionEpoch, lastSeen = Date.now()) => ({
    ...legacyPresence(lastSeen), connectionEpoch, generation: 1, restoreFence: 0,
  })
  await set(admissionPresenceRef, legacyPresence())
  await set(generationPresenceRef, generationPresence(legacyEpoch.connectionEpoch))
  // The pre-fence compatibility case is an existing presence/epoch record;
  // scene deltas use the strict current write contract.
  await remove(admissionPresenceRef)
  await remove(generationPresenceRef)

  let closedAdmissionEpoch
  const firstAdmissionFence = await runWithAbandonedRoomFence({
    rtdb: adminDb,
    boardId: admissionBoard,
    lockToken: `epoch-fence-${boardId}`,
    lockDurationMs: 120_000,
    work: async () => {
      const gate = (await adminDb.ref(`system/sceneMaintenance/${admissionBoard}`).get()).val()
      closedAdmissionEpoch = gate.admissionEpoch
      assert.equal(gate.admissionClosed, true)
      assert.equal(closedAdmissionEpoch, 1, 'the first fence advances the admission epoch from its implicit zero')
      await adminDb.ref(`presence/${admissionBoard}/${admissionSession}`).set(legacyPresence())
      await adminDb.ref(`presence/${admissionBoard}/generations/1/${admissionSession}`).set(generationPresence(legacyEpoch.connectionEpoch))
      await denied(set(admissionPresenceRef, legacyPresence(Date.now() + 1)), 'old token must be denied while admission is closed')
      await denied(set(generationPresenceRef, generationPresence(legacyEpoch.connectionEpoch, Date.now() + 1)), 'old token must not recreate generation-scoped presence while admission is closed')
      await denied(set(admissionDeltaRef, legacyDelta(2)), 'old token delta must be denied while admission is closed')
      await assert.rejects(
        mintSceneConnectionEpochForSession({ uid }, admissionBoard, admissionSession, 1, adminDb),
        (error) => error?.code === 'unavailable',
        'minting a connection while admission is closed must fail',
      )
      await adminDb.ref(`presence/${admissionBoard}/${admissionSession}`).remove()
      await adminDb.ref(`presence/${admissionBoard}/generations/1/${admissionSession}`).remove()
      return 'old-token-rejected-while-closed'
    },
  })
  assert.deepEqual(firstAdmissionFence, { status: 'completed', value: 'old-token-rejected-while-closed' })
  const reopenedGate = (await adminDb.ref(`system/sceneMaintenance/${admissionBoard}`).get()).val()
  assert.equal(reopenedGate.admissionClosed, false)
  assert.equal(reopenedGate.admissionEpoch, closedAdmissionEpoch, 'reopening must preserve the advanced epoch')
  await adminDb.ref(`presence/${admissionBoard}/${admissionSession}`).set(legacyPresence())
  await adminDb.ref(`presence/${admissionBoard}/generations/1/${admissionSession}`).set(generationPresence(legacyEpoch.connectionEpoch))
  await denied(set(admissionPresenceRef, legacyPresence(Date.now() + 1)), 'pre-fence token must remain denied after reopening')
  await denied(set(generationPresenceRef, generationPresence(legacyEpoch.connectionEpoch, Date.now() + 1)), 'old token must not recreate generation-scoped presence after reopening')
  await denied(set(admissionDeltaRef, legacyDelta(2)), 'pre-fence delta must remain denied after reopening')
  const postFenceEpoch = await mintSceneConnectionEpochForSession({ uid }, admissionBoard, admissionSession, 1, adminDb)
  assert.equal((await legacyEpochRef.get()).val().admissionEpoch, closedAdmissionEpoch)
  await set(admissionPresenceRef, {
    ...legacyPresence(), connectionEpoch: postFenceEpoch.connectionEpoch,
  })
  await set(generationPresenceRef, generationPresence(postFenceEpoch.connectionEpoch))
  await set(admissionDeltaRef, {
    ...legacyDelta(2), connectionEpoch: postFenceEpoch.connectionEpoch,
  })

  // Model the generation-reset admission transition: the same monotonic epoch
  // advances before the room generation changes, fencing the prior session.
  await adminDb.ref(`system/sceneMaintenance/${admissionBoard}`).update({
    admissionClosed: true,
    admissionEpoch: closedAdmissionEpoch + 1,
  })
  await adminDb.ref(`boards/${admissionBoard}/generation`).set(2)
  await denied(set(admissionPresenceRef, {
    ...legacyPresence(Date.now() + 2), connectionEpoch: postFenceEpoch.connectionEpoch,
  }), 'pre-reset token must be denied during the generation reset gate')
  await denied(set(admissionDeltaRef, {
    ...legacyDelta(3), connectionEpoch: postFenceEpoch.connectionEpoch,
  }), 'pre-reset delta must be denied during the generation reset gate')
  await assert.rejects(
    mintSceneConnectionEpochForSession({ uid }, admissionBoard, admissionSession, 2, adminDb),
    (error) => error?.code === 'unavailable',
    'generation reset must not mint a token while its gate is closed',
  )
  await adminDb.ref(`system/sceneMaintenance/${admissionBoard}`).update({ admissionClosed: false })
  const postResetEpoch = await mintSceneConnectionEpochForSession({ uid }, admissionBoard, admissionSession, 2, adminDb)
  assert.equal((await legacyEpochRef.get()).val().admissionEpoch, closedAdmissionEpoch + 1)
  assert.equal((await adminDb.ref(`system/sceneMaintenance/${admissionBoard}/admissionEpoch`).get()).val(), closedAdmissionEpoch + 1)
  await set(admissionPresenceRef, {
    ...legacyPresence(), sceneGeneration: 2, connectionEpoch: postResetEpoch.connectionEpoch,
  })
  await set(admissionDeltaRef, {
    ...legacyDelta(3), connectionEpoch: postResetEpoch.connectionEpoch, generation: 2,
  })
  console.log('PASS monotonic admission epochs fence legacy, closed-gate, and pre-reset sessions')

  const generationBoard = `${boardId}-session-generation`
  await adminDb.ref(`boardAccess/${generationBoard}`).set({ ownerId: uid, ownerActive: true, projectId: `project-${generationBoard}`, blocked: false })
  const generationSession = ref(db, `activeSessions/${generationBoard}/${uid}`)
  const sessionRecord = (sceneGeneration) => ({ userId: uid, sessionId: uid, sceneGeneration, joinedAt: Date.now(), lastSeen: Date.now() })
  await set(generationSession, sessionRecord(1))
  await adminDb.ref(`boards/${generationBoard}/generation`).set(2)
  await denied(set(generationSession, sessionRecord(1)), 'stale active-session rejoin must be rejected after generation reset')
  await set(generationSession, sessionRecord(2))
  await remove(generationSession)
  await adminDb.ref(`${presencePath}/${uid}`).remove()
  await denied(set(ref(db, `${boardPath}/element-1`), deltaRecord(currentEpoch, 3)), 'scene writes must be rejected when the session has no current presence')
  await denied(set(ref(db, `${presencePath}/${uid}`), presenceRecord(firstEpoch.connectionEpoch)), 'stale presence must remain rejected after disconnect cleanup')
  const thirdEpoch = await mintSceneConnectionEpochForSession({ uid }, boardId, uid, 1, adminDb)
  currentEpoch = thirdEpoch.connectionEpoch
  await set(ref(db, `${presencePath}/${uid}`), presenceRecord(currentEpoch))

  await adminDb.ref(gatePath).set(true)
  assert.equal((await adminDb.ref(gatePath).get()).val(), true, 'the rule-visible Admin namespace must contain the closed gate')
  await denied(set(ref(db, `${presencePath}/new-session`), { userId: uid, sessionId: 'new-session', displayName: 'Tester', color: '#000', lastSeen: Date.now() }), 'closed gate must reject joining a new presence session')
  await denied(set(ref(db, `${activePath}/new-session`), { userId: uid, sessionId: 'new-session', joinedAt: Date.now(), lastSeen: Date.now() }), 'closed gate must reject a new active session')
  await denied(set(ref(db, `${boardPath}/element-2`), { ...deltaRecord(currentEpoch), id: 'element-2' }), 'closed gate must reject scene delta creation')
  await denied(set(ref(db, `${boardPath}/element-1`), deltaRecord(currentEpoch, 3)), 'closed gate must reject scene delta updates')

  // Cleanup must remain available to the owner of the exact session, including onDisconnect.
  await remove(ref(db, `${presencePath}/${uid}`))
  await remove(ref(db, `${activePath}/${uid}`))
  await denied(remove(ref(db, `${presencePath}/other-user`)), 'closed gate must not permit removing another user’s presence')
  await denied(remove(ref(db, `${activePath}/other-user`)), 'closed gate must not permit removing another user’s active session')
  assert.equal((await adminDb.ref(`${presencePath}/other-user`).get()).exists(), true)
  assert.equal((await adminDb.ref(`${activePath}/other-user`).get()).exists(), true)
  // Scene element deletion remains blocked while closed to avoid racing the compactor.
  await denied(remove(ref(db, `${boardPath}/element-1`)), 'closed gate must reject scene element deletion')
  assert.equal((await adminDb.ref(`${boardPath}/element-1`).get()).exists(), true)

  const activeBoard = `${boardId}-active`
  await adminDb.ref(`activeSessions/${activeBoard}/other`).set({ userId: 'other', sessionId: 'other' })
  let activeWorkRan = false
  const activeResult = await runWithAbandonedRoomFence({
    rtdb: adminDb,
    boardId: activeBoard,
    lockToken: `active-${boardId}`,
    lockDurationMs: 120_000,
    work: async () => { activeWorkRan = true },
  })
  assert.equal(activeResult.status, 'active-sessions')
  assert.equal(activeWorkRan, false, 'active session must abort before checkpoint/prune')
  assert.equal((await adminDb.ref(`system/sceneMaintenance/${activeBoard}/admissionClosed`).get()).val(), false, JSON.stringify({
    maintenance: (await adminDb.ref(`system/sceneMaintenance/${activeBoard}`).get()).val(),
    lock: (await adminDb.ref(`system/compactionLocks/${activeBoard}`).get()).val(),
  }))
  assert.equal((await adminDb.ref(`system/compactionLocks/${activeBoard}`).get()).exists(), false)

  const successBoard = `${boardId}-success`
  const successElementRef = adminDb.ref(`boards/${successBoard}/elements/item`)
  const capturedElement = { id: 'item', version: 1, versionNonce: 1, data: '{"id":"item"}' }
  await successElementRef.set(capturedElement)
  const successResult = await runWithAbandonedRoomFence({
    rtdb: adminDb,
    boardId: successBoard,
    lockToken: `success-${boardId}`,
    lockDurationMs: 120_000,
    work: async () => {
      const successGate = adminDb.ref(`system/sceneMaintenance/${successBoard}/admissionClosed`)
      assert.equal((await successGate.get()).val(), true, 'admission must stay closed during checkpoint/prune')
      await denied(set(ref(db, `presence/${successBoard}/late-session`), { userId: uid, sessionId: 'late-session', displayName: 'Tester', color: '#000', lastSeen: Date.now() }), 'closed gate must reject a join while checkpointing')
      await pruneCheckpointedRecords(
        adminDb.ref(`boards/${successBoard}/elements`),
        adminDb.ref(`presence/${successBoard}`),
        { item: capturedElement },
      )
      assert.equal((await successGate.get()).val(), true, 'gate must remain closed through pruning')
      return 'checkpointed-and-pruned'
    },
  })
  assert.deepEqual(successResult, { status: 'completed', value: 'checkpointed-and-pruned' })
  assert.equal((await adminDb.ref(`system/sceneMaintenance/${successBoard}/admissionClosed`).get()).val(), false)
  assert.equal((await adminDb.ref(`boards/${successBoard}/elements/item`).get()).exists(), false)
  assert.equal((await adminDb.ref(`system/compactionLocks/${successBoard}`).get()).exists(), false)

  const failureBoard = `${boardId}-failure`
  await assert.rejects(runWithAbandonedRoomFence({
    rtdb: adminDb,
    boardId: failureBoard,
    lockToken: `failure-${boardId}`,
    lockDurationMs: 120_000,
    work: async () => {
      assert.equal((await adminDb.ref(`system/sceneMaintenance/${failureBoard}/admissionClosed`).get()).val(), true)
      throw new Error('injected checkpoint failure')
    },
  }), /injected checkpoint failure/)
  assert.equal((await adminDb.ref(`system/sceneMaintenance/${failureBoard}/admissionClosed`).get()).val(), false)
  assert.equal((await adminDb.ref(`system/compactionLocks/${failureBoard}`).get()).exists(), false)

  const contendedBoard = `${boardId}-contended`
  await adminDb.ref(`system/compactionLocks/${contendedBoard}`).set({ startedAt: Date.now(), token: 'valid-owner' })
  await adminDb.ref(`system/sceneMaintenance/${contendedBoard}`).set({ admissionClosed: true, admissionOwner: 'valid-owner' })
  const contendedResult = await runWithAbandonedRoomFence({
    rtdb: adminDb,
    boardId: contendedBoard,
    lockToken: `contender-${boardId}`,
    lockDurationMs: 120_000,
    work: async () => assert.fail('contending invocation must not perform work'),
  })
  assert.equal(contendedResult.status, 'lock-contended')
  assert.equal((await adminDb.ref(`system/sceneMaintenance/${contendedBoard}/admissionClosed`).get()).val(), true)
  assert.equal((await adminDb.ref(`system/sceneMaintenance/${contendedBoard}/admissionOwner`).get()).val(), 'valid-owner')

  const resetOwnedBoard = `${boardId}-generation-reset`
  await adminDb.ref(`system/sceneMaintenance/${resetOwnedBoard}`).set({
    admissionClosed: true, admissionOwner: 'reset-token', resetOperationId: 'reset-1',
  })
  let resetProtectedWorkRan = false
  await assert.rejects(runWithAbandonedRoomFence({
    rtdb: adminDb,
    boardId: resetOwnedBoard,
    lockToken: 'compactor-token',
    lockDurationMs: 180_000,
    work: async () => { resetProtectedWorkRan = true },
  }), /Could not close scene admission gate/)
  assert.equal(resetProtectedWorkRan, false, 'compactor cannot replace a durable reset gate')
  assert.equal((await adminDb.ref(`system/sceneMaintenance/${resetOwnedBoard}`).get()).child('admissionOwner').val(), 'reset-token')

  const crashedBoard = `${boardId}-crashed-compaction`
  const expiredOwner = `expired-${boardId}`
  await adminDb.ref(`system/compactionLocks/${crashedBoard}`).set({ startedAt: Date.now() - 180_001, token: expiredOwner })
  await adminDb.ref(`system/sceneMaintenance/${crashedBoard}`).set({ admissionClosed: true, admissionOwner: expiredOwner, admissionEpoch: 4 })
  await adminFirestore.doc(`boardScenes/${crashedBoard}`).set({ maintenanceAdmission: 'closed', maintenanceEpoch: 7 })
  await adminFirestore.doc(`boardScenes/${crashedBoard}/maintenance/control`).set({
    admission: 'closed', epoch: 7, token: expiredOwner, abandonedRoomOwner: expiredOwner,
    leaseUntil: Timestamp.fromMillis(Date.now() - 1),
  })
  const recoveryResult = await runWithAbandonedRoomFence({
    rtdb: adminDb, firestore: adminFirestore, boardId: crashedBoard,
    lockToken: `recovery-${boardId}`, lockDurationMs: 180_000,
    work: async () => {
      const [head, control, gate] = await Promise.all([
        adminFirestore.doc(`boardScenes/${crashedBoard}`).get(),
        adminFirestore.doc(`boardScenes/${crashedBoard}/maintenance/control`).get(),
        adminDb.ref(`system/sceneMaintenance/${crashedBoard}`).get(),
      ])
      assert.equal(head.data().maintenanceAdmission, 'open')
      assert.equal(head.data().maintenanceEpoch, 8)
      assert.equal(control.data().admission, 'open')
      assert.equal(control.data().epoch, 8)
      assert.equal(gate.child('admissionClosed').val(), true, 'replacement closes RTDB before resuming work')
      assert.equal(gate.child('admissionOwner').val(), `recovery-${boardId}`)
      assert.equal(gate.child('admissionEpoch').val(), 5, 'recovery advances the RTDB epoch before reopening Firestore')
      return 'recovered-expired-firestore-fence'
    },
  })
  assert.deepEqual(recoveryResult, { status: 'completed', value: 'recovered-expired-firestore-fence' })
  assert.equal((await adminFirestore.doc(`boardScenes/${crashedBoard}`).get()).data().maintenanceAdmission, 'open')
  assert.equal((await adminDb.ref(`system/sceneMaintenance/${crashedBoard}/admissionClosed`).get()).val(), false)

  const epochRecordRef = `system/sceneConnectionEpochs/${boardId}/${uid}`
  await adminDb.ref(gatePath).set(false)
  await onDisconnect(ref(db, `${epochRecordRef}/token`)).remove()
  goOffline(db)
  let tokenRemoved = false
  for (let attempt = 0; attempt < 30; attempt++) {
    const epochRecord = (await adminDb.ref(epochRecordRef).get()).val()
    if (epochRecord && !epochRecord.token) {
      assert.equal(epochRecord.generation, thirdEpoch.generation, 'disconnect invalidates token but preserves monotonic generation')
      tokenRemoved = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(tokenRemoved, true, 'onDisconnect must remove the old admission token before a reconnect can replay queued writes')

  // Reconnect after onDisconnect. Previously queued presence and deltas must
  // remain unauthorized until a fresh server epoch is minted.
  goOnline(db)
  await new Promise((resolve, reject) => {
    const unsubscribe = onValue(ref(db, '.info/connected'), (snapshot) => {
      if (snapshot.val() === true) {
        unsubscribe()
        resolve()
      }
    }, reject)
    setTimeout(() => {
      unsubscribe()
      reject(new Error('RTDB did not reconnect after goOnline'))
    }, 5000)
  })
  await denied(set(ref(db, `${presencePath}/${uid}`), presenceRecord(thirdEpoch.connectionEpoch)), 'onDisconnect must fence replayed stale presence after reconnection')
  await denied(set(ref(db, `${boardPath}/element-1`), deltaRecord(thirdEpoch.connectionEpoch, 4)), 'onDisconnect must fence replayed stale deltas after reconnection')
  const fourthEpoch = await mintSceneConnectionEpochForSession({ uid }, boardId, uid, 1, adminDb)
  await set(ref(db, `${presencePath}/${uid}`), presenceRecord(fourthEpoch.connectionEpoch))
  await set(ref(db, `${boardPath}/element-1`), deltaRecord(fourthEpoch.connectionEpoch, 4))

  // A still-connected but stale tab cannot mint or use an epoch after the room advances.
  await adminDb.ref(`boards/${boardId}/generation`).set(2)
  await assert.rejects(
    mintSceneConnectionEpochForSession({ uid }, boardId, uid, 1, adminDb),
    (error) => error?.code === 'failed-precondition' && error?.details?.reason === 'scene-generation-mismatch',
    'server must reject stale scene generations after reset',
  )
  await denied(set(ref(db, `${boardPath}/element-1`), deltaRecord(fourthEpoch.connectionEpoch, 5)),
    'a previously minted generation-1 token must be fenced when the RTDB room advances')
  const currentGenerationEpoch = await mintSceneConnectionEpochForSession({ uid }, boardId, uid, 2, adminDb)
  await set(ref(db, `${presencePath}/${uid}`), presenceRecord(currentGenerationEpoch.connectionEpoch, 2))
  await set(ref(db, `${boardPath}/element-1`), deltaRecord(currentGenerationEpoch.connectionEpoch, 5))

  console.log(JSON.stringify({ passed: [
    'valid current-epoch deltas succeed; reconnect rejects stale epochs and missing-presence sessions',
    'server epoch callable denies unauthorized callers and fenced replay cannot restore old presence/deltas',
    'closed gate rejects presence joins, active-session joins, and scene create/update/delete',
    'closed gate permits exact self-removal only for presence and active session',
    'active session observed after gate close aborts before checkpoint/prune and reopens gate',
    'gate stays closed while checkpoint/prune work runs and reopens after success',
    'gate reopens and owned lock releases after checkpoint failure',
    'lock contender does not reopen another valid owner’s gate',
    'abandoned-room worker refuses to replace a generation-reset-owned RTDB gate',
    'onDisconnect removes only the active token, preserves generation, and fences stale writes after reconnect',
    'old-generation sessions cannot mint a new epoch or write after room generation advances',
    'expired Firestore fence recovery replaces the RTDB owner and advances both admission epochs',
  ] }, null, 2))
} finally {
  await adminDb.ref(`system/sceneMaintenance/${boardId}`).remove()
  await adminFirestore.recursiveDelete(adminFirestore.doc(`boardScenes/${boardId}-crashed-compaction`))
  await adminDb.ref(`boardAccess/${boardId}`).remove()
  await adminDb.ref(`boards/${boardId}`).remove()
  await adminDb.ref(`presence/${boardId}`).remove()
  await adminDb.ref(`activeSessions/${boardId}`).remove()
  await adminDb.ref(`system/sceneConnectionEpochs/${boardId}`).remove()
  await adminDb.ref(`activeSessions/${boardId}-active`).remove()
  for (const suffix of ['active', 'success', 'failure', 'contended']) {
    await adminDb.ref(`system/sceneMaintenance/${boardId}-${suffix}`).remove()
    await adminDb.ref(`system/compactionLocks/${boardId}-${suffix}`).remove()
    await adminDb.ref(`boards/${boardId}-${suffix}`).remove()
    await adminDb.ref(`presence/${boardId}-${suffix}`).remove()
    await adminDb.ref(`activeSessions/${boardId}-${suffix}`).remove()
  }
  goOffline(db)
  await signOut(auth)
  await Promise.all([deleteApp(clientApp), deleteAdminApp(adminApp)])
}
