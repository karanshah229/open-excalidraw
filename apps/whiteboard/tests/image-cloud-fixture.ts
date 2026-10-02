import { createUserWithEmailAndPassword, signOut, signInAnonymously } from 'firebase/auth'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { getBytes, ref } from 'firebase/storage'
import { getFirebaseAuth, getFirebaseStorage, getFirestoreDb } from '../src/lib/firebase'
import { storeSceneAssets, restoreSceneAssets } from '../src/features/assets/scene-assets'
import { sharingService } from '../src/features/sharing/sharing-service'
import { workspaceApi, workspaceValue } from '../src/features/workspace/workspace-api'
import type { BoardScene } from '@agentic-whiteboard/storage'

export async function exerciseCloudAssets(dataURL: string) {
  // Auth initializes first: this also verifies later Storage and Firestore emulator connections.
  const auth = getFirebaseAuth()!
  const { user } = await createUserWithEmailAndPassword(auth, `images-${Date.now()}@example.com`, 'test-password')
  const db = getFirestoreDb()!
  const storage = getFirebaseStorage()!
  const scene: BoardScene = {
    elements: [{ id: 'image', type: 'image', fileId: 'asset', version: 1, isDeleted: false }],
    appState: {},
    files: { asset: { id: 'asset', dataURL, mimeType: 'image/png', created: 1 } },
  }
  await workspaceApi.activateCloudWorkspace(user.uid)
  const project = await workspaceApi.createProject('Cloud image regression')
  const board = await workspaceApi.createBoard(project.id, 'Private image')
  await workspaceApi.saveBoard({ ...board, scene })
  const privateRef = doc(db, 'users', user.uid, 'projects', project.id, 'boards', board.id)
  let privateScene: BoardScene | undefined
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = await getDoc(privateRef)
    if (snapshot.exists()) {
      privateScene = (workspaceValue(snapshot.data()) as any).scene
      if (privateScene?.files?.asset?.storagePath) break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!privateScene?.files?.asset?.storagePath) throw new Error('Private board failed to sync image to Storage')
  const restored = await restoreSceneAssets(privateScene)
  const sharedId = `shared-${board.id}`
  await setDoc(doc(db, 'boardShares', sharedId), {
    boardId: sharedId,
    boardName: 'Shared image',
    ownerId: user.uid,
    ownerName: 'Test',
    generalAccess: 'anyone_with_link',
    generalRole: 'editor',
    invitedEmails: [],
    collaborators: {},
    createdAt: '',
    updatedAt: '',
    scene: { elements: [], appState: {} },
  })
  await sharingService.updateSharedScene(sharedId, scene)
  const sharedSnapshot = (await getDoc(doc(db, 'boardShares', sharedId))).data()!
  // An upload error must reject instead of committing missing bytes.
  let missingFileRejected = false
  try {
    await storeSceneAssets({ ...scene, files: { asset: { ...scene.files!.asset, dataURL: '' } } }, 'boards/fail/assets')
  } catch {
    missingFileRejected = true
  }
  workspaceApi.deactivateCloudWorkspace()
  await signOut(auth)
  await signInAnonymously(auth)
  const shared = await sharingService.getSharedBoard(sharedId)
  let privateReadDenied = false
  try {
    await getBytes(ref(storage, privateScene.files.asset.storagePath))
  } catch (error: any) {
    privateReadDenied = error.code === 'storage/unauthorized'
  }
  return {
    privateInlineBytes: privateScene.files.asset.dataURL,
    privateRestored: restored.files!.asset.dataURL,
    sharedInlineBytes: sharedSnapshot.scene.files.asset.dataURL,
    sharedRestored: shared.config?.scene?.files?.asset?.dataURL,
    missingFileRejected,
    privateReadDenied,
  }
}
