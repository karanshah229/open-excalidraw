import { createUserWithEmailAndPassword, signInAnonymously } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { getFirebaseAuth, getFirestoreDb } from '../src/lib/firebase'
import { workspaceApi, workspaceValue } from '../src/features/workspace/workspace-api'

export async function createFormatBoard(format: string, cloud: boolean, live: boolean) {
  if (cloud) {
    const auth = getFirebaseAuth()!
    await auth.authStateReady()
    if (!auth.currentUser) {
      if (live) await signInAnonymously(auth)
      else await createUserWithEmailAndPassword(auth, `formats-${Date.now()}@example.com`, 'test-password')
    }
    localStorage.setItem(
      'agentic-whiteboard:e2e-user',
      JSON.stringify({
        uid: auth.currentUser!.uid,
        displayName: 'Format E2E',
      }),
    )
    await workspaceApi.activateCloudWorkspace(auth.currentUser!.uid)
  }
  const project = await workspaceApi.createProject(`Format E2E ${format}`)
  const board = await workspaceApi.createBoard(project.id, `Upload ${format}`)
  return board.id
}

export async function readFormatScene(boardId: string, shared: boolean) {
  const db = getFirestoreDb()!
  if (shared) return (await getDoc(doc(db, 'boardShares', boardId))).data()?.scene
  const board = (await workspaceApi.loadBoard(boardId))!
  const uid = getFirebaseAuth()!.currentUser!.uid
  const snapshot = await getDoc(doc(db, 'users', uid, 'projects', board.projectId, 'boards', boardId))
  return snapshot.exists() ? (workspaceValue(snapshot.data()) as any).scene : undefined
}

// Remove cached bytes to make the following reload prove gateway/Storage restoration.
export async function removeFormatCache(boardId: string, shared: boolean) {
  const board = (await workspaceApi.loadBoard(boardId))!
  const scene = await readFormatScene(boardId, shared)
  if (!scene?.files || Object.values(scene.files).some((file: any) => file.dataURL || !file.storagePath))
    throw new Error('Expected a metadata-only cloud scene before clearing cached bytes')
  await workspaceApi.saveBoard({ ...board, scene })
}
