import { setWorkspaceIdentity } from '@agentic-whiteboard/storage'
import { createUserWithEmailAndPassword, signInAnonymously, signInWithCustomToken, type Auth } from 'firebase/auth'
import { doc, getDoc, getDocFromServer } from 'firebase/firestore'
import { get, ref, set } from 'firebase/database'
import { getFirebaseAuth, getFirebaseApp, getFirebaseRtdb, getFirestoreDb } from '../src/lib/firebase'
import { sharingService, type BoardShareConfig } from '../src/features/sharing/sharing-service'
import { workspaceApi } from '../src/features/workspace/workspace-api'
export { updateProfile, signOut, signInAnonymously } from 'firebase/auth'

function requireDemoEmulators() {
  if (
    import.meta.env.VITE_USE_FIREBASE_EMULATOR !== 'true' ||
    !getFirebaseApp()?.options.projectId?.startsWith('demo-') ||
    !['localhost', '127.0.0.1'].includes(location.hostname)
  )
    throw new Error('Regression owners must be provisioned in local demo emulators.')
}

/** Registered owners are required by project management; guests remain anonymous. */
export async function signInOwner(auth: Auth) {
  requireDemoEmulators()
  await auth.authStateReady()
  const credential = await createUserWithEmailAndPassword(
    auth,
    `regression-${crypto.randomUUID()}@example.com`,
    'fixture-password',
  )
  localStorage.removeItem('agentic-whiteboard:e2e-user')
  await workspaceApi.activateCloudWorkspace(credential.user.uid)
  return credential
}


/** Authenticate an isolated browser context as an existing fixture owner. */
export async function signInOwnerWithToken(auth: Auth, token: string) {
  requireDemoEmulators()
  const credential = await signInWithCustomToken(auth, token)
  await workspaceApi.activateCloudWorkspace(credential.user.uid)
  return credential
}

/** Keep local-byte recovery separate from automatic cloud revision changes. */
export function pauseCloudReplication() {
  requireDemoEmulators()
  const uid = getFirebaseAuth()!.currentUser?.uid
  if (!uid) throw new Error('A fixture owner must be signed in.')
  workspaceApi.deactivateCloudWorkspace()
  setWorkspaceIdentity(uid)
}

/** Seed the actual owned board and publish policy through the application callable. */
export async function seedSharedBoard(config: BoardShareConfig) {
  requireDemoEmulators()
  const auth = getFirebaseAuth()!
  await auth.authStateReady()
  if (!auth.currentUser || auth.currentUser.isAnonymous) await signInOwner(auth)
  const uid = auth.currentUser!.uid
  await workspaceApi.activateCloudWorkspace(uid)
  let board = await workspaceApi.loadBoard(config.boardId)
  if (!board) {
    const project = await workspaceApi.createProject(`Regression ${config.boardName}`)
    const timestamp = new Date().toISOString()
    board = await workspaceApi.saveBoard({
      id: config.boardId,
      projectId: project.id,
      name: config.boardName,
      scene: config.scene ?? { elements: [], appState: {} },
      active: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 0,
      baseRevision: 0,
      syncStatus: 'local-only',
      syncAttempts: 0,
      nextSyncAt: null,
      lastSyncError: null,
    })
  }
  await workspaceApi.flushCloud()
  await sharingService.saveShareConfig(
    { ...config, ownerId: uid, projectId: board.projectId },
    { workspaceFlushed: true },
  )
  // The initial scene was persisted through the owner workspace sync above.
  // Recommitting it here can race that first publication and stale its revision.
  const snapshot = await getDoc(doc(getFirestoreDb()!, 'boardShares', config.boardId))
  if (!snapshot.exists() || snapshot.data().pending) throw new Error('Regression board policy was not published.')
}

/** Prepare an isolated anonymous participant before navigating to the test board. */
export async function signInGuest() {
  requireDemoEmulators()
  const auth = getFirebaseAuth()!
  await auth.authStateReady()
  if (auth.currentUser && !auth.currentUser.isAnonymous)
    throw new Error('Guest fixture must use an isolated browser context.')
  if (!auth.currentUser) await signInAnonymously(auth)
}

/** Read the authoritative policy through the same Firebase module as the app. */
export async function readBoardSharePolicy(boardId: string) {
  requireDemoEmulators()
  return (await getDocFromServer(doc(getFirestoreDb()!, 'boardShares', boardId))).data()
}

/** Read RTDB session records through the app's Firebase bundle in browser tests. */
export async function readActiveSessionsForRegression(boardId: string) {
  requireDemoEmulators()
  const db = getFirebaseRtdb()!
  return (await get(ref(db, `activeSessions/${boardId}`))).val()
}

/** Replay an old session epoch to verify RTDB rules reject stale writes. */
export async function replayRegressionSession(boardId: string, sessionId: string, uid: string, epoch: number, elementId: string) {
  requireDemoEmulators()
  const db = getFirebaseRtdb()!
  const stalePresence = { uid, sessionId, connectionEpoch: epoch }
  const staleDelta = {
    id: elementId,
    version: 999,
    versionNonce: 1,
    lastModifiedBy: uid,
    sessionId,
    connectionEpoch: epoch,
    data: JSON.stringify({ id: elementId, type: 'rectangle', x: 0, y: 0, width: 40, height: 40, isDeleted: false, version: 999, versionNonce: 1 }),
  }
  return Promise.all([
    set(ref(db, `presence/${boardId}/${sessionId}`), stalePresence).then(() => 'allowed', (error) => error.code),
    set(ref(db, `boards/${boardId}/elements/${elementId}`), staleDelta).then(() => 'allowed', (error) => error.code),
  ])
}
