import { initializeApp, deleteApp } from 'firebase/app'
import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions'
import { convertToExcalidrawElements } from '@excalidraw/excalidraw'
import { createUserWithEmailAndPassword, signOut, signInAnonymously } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { getBytes, getDownloadURL, ref } from 'firebase/storage'
import {
  getFirebaseAuth,
  getFirebaseStorage,
  getFirestoreDb,
  getFirebaseApp,
  getSyncAccessFunctionRegion,
} from '../src/lib/firebase'
import { storeSceneAssets, restoreSceneAssets, requestBoardAsset } from '../src/features/assets/scene-assets'
import { patchEmulatorDocument } from './emulator-document-fixture'
import { projectService } from '../src/features/sharing/project-service'
import { sharingService } from '../src/features/sharing/sharing-service'
import { workspaceApi } from '../src/features/workspace/workspace-api'
import type { BoardScene } from '@agentic-whiteboard/storage'

/** Independent durable reader: image regressions must inspect stored descriptors, not hydrated bytes. */
export async function persistedScene(boardId: string, legacy?: any): Promise<BoardScene> {
  const db = getFirestoreDb()!
  const head = (await getDoc(doc(db, 'boardScenes', boardId))).data()
  if (!head?.headRevisionId) {
    if (legacy) return legacy
    throw new Error('Missing committed scene head')
  }
  const revision = (await getDoc(doc(db, 'boardScenes', boardId, 'revisions', head.headRevisionId))).data()!
  const records: any[] = []
  for (let page = 0; page < revision.pageCount; page++) {
    const refs = (
      await getDoc(
        doc(db, 'boardScenes', boardId, 'revisions', head.headRevisionId, 'pages', String(page).padStart(6, '0')),
      )
    ).data()!.references
    for (const reference of refs) {
      const chunk = (await getDoc(doc(db, 'boardScenes', boardId, 'chunks', reference.chunkId))).data()!
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(chunk.payload))),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('')
      if (digest !== reference.digest || chunk.digest !== digest) throw new Error('Corrupt persisted image scene')
      records.push(...JSON.parse(chunk.payload))
    }
  }
  const scene: BoardScene = {
    elements: records
      .filter((r) => r.kind === 'element')
      .sort((a, b) => a.order - b.order)
      .map((r) => r.value),
    appState: records.find((r) => r.kind === 'appState').value,
  }
  if (records.find((r) => r.kind === 'header').value.hasFiles)
    scene.files = Object.fromEntries(records.filter((r) => r.kind === 'file').map((r) => [r.value.id, r.value]))
  return scene
}

export async function exerciseCloudAssets(dataURL: string, live?: string) {
  // Auth initializes first: this also verifies later Storage and Firestore emulator connections.
  const auth = getFirebaseAuth()!
  const { user } = live
    ? await signInAnonymously(auth)
    : await createUserWithEmailAndPassword(auth, `images-${Date.now()}@example.com`, 'test-password')
  const db = getFirestoreDb()!
  const storage = getFirebaseStorage()!
  const scene: BoardScene = {
    elements: convertToExcalidrawElements(
      [
        { id: 'image', type: 'image', fileId: 'asset', status: 'saved', x: 100, y: 100, width: 180, height: 120 },
      ] as any,
      { regenerateIds: false },
    ) as any,
    appState: {},
    files: { asset: { id: 'asset', dataURL, mimeType: 'image/png', created: 1 } },
  }
  await workspaceApi.activateCloudWorkspace(user.uid)
  const project = await workspaceApi.createProject('Cloud image regression')
  const board = await workspaceApi.createBoard(project.id, 'Private image')
  await workspaceApi.saveBoard({ ...board, scene })
  await workspaceApi.flushCloud()
  const privateRef = doc(db, 'users', user.uid, 'projects', project.id, 'boards', board.id)
  let privateScene: BoardScene | undefined
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = await getDoc(privateRef)
    if (snapshot.exists()) {
      privateScene = await persistedScene(board.id, snapshot.data().scene)
      if (privateScene?.files?.asset?.storagePath) break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!privateScene?.files?.asset?.storagePath) throw new Error('Private board failed to sync image to Storage')
  const restored = await restoreSceneAssets(privateScene)
  const sharedBoard = await workspaceApi.createBoard(project.id, 'Shared image')
  await workspaceApi.flushCloud()
  const sharedId = sharedBoard.id
  await sharingService.saveShareConfig({
    projectId: project.id,
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
  // Sharing an already-synced private board may receive metadata-only files.
  await sharingService.updateSharedScene(sharedId, privateScene)
  const sharedSnapshot = { scene: await persistedScene(sharedId) }
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
  let privateGatewayReadDenied = false
  try {
    await requestBoardAsset({ operation: 'read', storagePath: privateScene.files.asset.storagePath })
  } catch (error: any) {
    privateGatewayReadDenied = error.code === 'functions/permission-denied'
  }
  let privateReadDenied = false
  try {
    await getBytes(ref(storage, privateScene.files.asset.storagePath))
  } catch (error: any) {
    privateReadDenied = error.code === 'storage/unauthorized'
  }
  return {
    sharedId,
    privateInlineBytes: privateScene.files.asset.dataURL,
    privateRestored: restored.files!.asset.dataURL,
    sharedInlineBytes: sharedSnapshot.scene.files.asset.dataURL,
    sharedRestored: shared.config?.scene?.files?.asset?.dataURL,
    missingFileRejected,
    privateReadDenied,
    privateGatewayReadDenied,
  }
}

export async function moveSharedImage(boardId: string) {
  await getFirebaseAuth()!.authStateReady()
  const shared = await sharingService.getSharedBoard(boardId)
  const scene = shared.config!.scene!
  const file = scene.files!.asset
  // Position-only writes can also receive a cloud descriptor with no bytes.
  const descriptorScene = await storeSceneAssets(
    { ...scene, files: { asset: { ...file, dataURL: '' } } },
    `boards/${boardId}/assets`,
  )
  if (descriptorScene.files!.asset.storagePath !== file.storagePath) throw new Error('Lost upload receipt')
  // Simulate an older local snapshot whose cloud upload receipt was not saved.
  // The object already exists: metadata must prevent a duplicate upload.
  await storeSceneAssets(
    { ...scene, files: { asset: { ...file, storagePath: undefined } } },
    file.storagePath!.slice(0, file.storagePath!.lastIndexOf('/')),
  )
  for (let move = 1; move <= 3; move++) {
    scene.elements = scene.elements.map((element) => ({ ...element, x: move * 20, y: move * 10, version: move + 1 }))
    await sharingService.updateSharedScene(boardId, scene)
  }
  const snap = { scene: await persistedScene(boardId) }
  return { x: snap.scene.elements[0].x, fileId: snap.scene.elements[0].fileId }
}

export async function readSharedPosition(boardId: string) {
  const scene = await persistedScene(boardId)
  return { x: scene.elements[0].x, y: scene.elements[0].y, dataURL: scene.files.asset.dataURL }
}

export async function createPrivateImageBoard(dataURL: string) {
  const auth = getFirebaseAuth()!
  await auth.authStateReady()
  // Project-management callables deliberately reject anonymous identities.
  if (auth.currentUser?.isAnonymous && import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true') {
    await signOut(auth)
    await createUserWithEmailAndPassword(auth, `image-owner-${Date.now()}@example.com`, 'test-password')
  }
  // The application intentionally hides anonymous users from its account UI.
  // Use its existing development-only identity hook with the real test UID.
  localStorage.setItem(
    'agentic-whiteboard:e2e-user',
    JSON.stringify({ uid: auth.currentUser!.uid, displayName: 'Image regression' }),
  )
  await workspaceApi.activateCloudWorkspace(auth.currentUser!.uid)
  const project = await workspaceApi.createProject('Share dialog regression')
  const board = await workspaceApi.createBoard(project.id, 'Share an image')
  const scene: BoardScene = {
    elements: convertToExcalidrawElements([
      { type: 'image', fileId: 'asset', status: 'saved', x: 100, y: 100, width: 180, height: 120 },
    ] as any) as any,
    appState: {},
    files: { asset: { id: 'asset', dataURL, mimeType: 'image/png', created: 1 } },
  }
  await workspaceApi.saveBoard({ ...board, scene })
  await workspaceApi.flushCloud()
  return board.id
}

export async function readSharedImagePath(boardId: string) {
  return (await persistedScene(boardId)).files?.asset?.storagePath
}

export async function persistMetadataOnlyLocalScene(boardId: string) {
  const board = (await workspaceApi.loadBoard(boardId))!
  const storagePath = await readSharedImagePath(boardId)
  await workspaceApi.saveBoard({
    ...board,
    scene: { ...board.scene, files: { asset: { ...board.scene.files!.asset, dataURL: '', storagePath } } },
  })
}

export async function exerciseAssetLifecycle(boardId: string) {
  const board = (await workspaceApi.loadBoard(boardId))!
  workspaceApi.deactivateCloudWorkspace()
  const auth = getFirebaseAuth()!
  const db = getFirestoreDb()!
  const privateRef = doc(db, 'users', auth.currentUser!.uid, 'projects', board.projectId, 'boards', boardId)
  const shareRef = doc(db, 'boardShares', boardId)
  const projectRef = doc(db, 'users', auth.currentUser!.uid, 'projects', board.projectId)
  // Exercise the shared namespace separately: initial publication now reuses
  // its private receipt, whose uploads correctly remain owner-only.
  const sourceScene = await restoreSceneAssets(await persistedScene(boardId))
  const lifecycleScene = await storeSceneAssets(
    {
      ...sourceScene,
      files: {
        asset: { ...sourceScene.files!.asset, storagePath: undefined },
      },
    },
    `boards/${boardId}/assets`,
  )
  const sharedPath = lifecycleScene.files!.asset.storagePath!
  const privatePath = `users/${auth.currentUser!.uid}/boards/${boardId}/assets/asset`
  const read = (storagePath: string) => requestBoardAsset({ operation: 'read', storagePath })
  const denied = async (path: string) => {
    try {
      await read(path)
      return false
    } catch (error: any) {
      return error.code === 'functions/permission-denied'
    }
  }
  const visitorApp = initializeApp(getFirebaseApp()!.options, `asset-visitor-${Date.now()}`)
  const visitorFunctions = getFunctions(visitorApp, getSyncAccessFunctionRegion())
  if (import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true')
    connectFunctionsEmulator(visitorFunctions, window.location.hostname, 5001)
  const visitorAsset = httpsCallable(visitorFunctions, 'boardAsset')
  const visitorDenied = async (operation: string) => {
    try {
      await visitorAsset({ operation, storagePath: sharedPath })
      return false
    } catch (error: any) {
      return error.code === 'functions/permission-denied'
    }
  }
  const sharePolicy = async (generalAccess: 'restricted' | 'anyone_with_link', generalRole: 'viewer' | 'editor') =>
    projectService.boardAccess(boardId, board.projectId, 'share', {
      accessRevision: (await getDoc(shareRef)).data()?.accessRevision ?? 0,
      generalAccess,
      generalRole,
      invitedEmails: [],
      collaborators: {},
      inheritProjectAccess: false,
    })
  await sharePolicy('restricted', 'viewer')
  const restrictedDeniesVisitor = (await visitorDenied('read')) && (await visitorDenied('upload'))
  await sharePolicy('anyone_with_link', 'viewer')
  const publicViewerCanRead = Boolean((await visitorAsset({ operation: 'read', storagePath: sharedPath })).data)
  const publicViewerCannotUpload = await visitorDenied('upload')
  await sharePolicy('anyone_with_link', 'editor')
  const publicEditorCanReuseAsset = Boolean((await visitorAsset({ operation: 'upload', storagePath: sharedPath })).data)
  await sharePolicy('restricted', 'viewer')
  const revokedVisitorCannotRead = await visitorDenied('read')
  await deleteApp(visitorApp)
  const before = (await read(sharedPath)).dataURL
  const originalScene = await persistedScene(boardId)
  await sharingService.updateSharedScene(boardId, {
    ...originalScene,
    elements: originalScene.elements.map((el: any) => ({ ...el, isDeleted: true, version: Number(el.version) + 1 })),
  })
  const imageTombstoneRetainsBytes = (await read(sharedPath)).dataURL === before
  await sharingService.updateSharedScene(boardId, {
    ...originalScene,
    elements: originalScene.elements.map((el: any) => ({ ...el, isDeleted: false, version: Number(el.version) + 2 })),
  })
  const imageRestoreReusesBytes = (await read(sharedPath)).dataURL === before
  // Missing token metadata must not be regeneratable by a browser, even its owner.
  let directStorageDenied = false
  let tokenCreationDenied = false
  try {
    await getBytes(ref(getFirebaseStorage()!, sharedPath))
  } catch (error: any) {
    directStorageDenied = error.code === 'storage/unauthorized'
  }
  try {
    await getDownloadURL(ref(getFirebaseStorage()!, sharedPath))
  } catch (error: any) {
    tokenCreationDenied = error.code === 'storage/unauthorized'
  }
  try {
    await patchEmulatorDocument(privateRef.path, { active: false })
    const boardDeleteDeniesBoth = (await denied(privatePath)) && (await denied(sharedPath))
    await patchEmulatorDocument(privateRef.path, { active: true })
    await patchEmulatorDocument(shareRef.path, { deletedAt: null })
    const boardRestoreReusesBytes = (await read(sharedPath)).dataURL === before
    await patchEmulatorDocument(projectRef.path, { active: false })
    const projectDeleteDeniesBoth = (await denied(privatePath)) && (await denied(sharedPath))
    await patchEmulatorDocument(projectRef.path, { active: true })
    const projectRestoreReusesBytes = (await read(sharedPath)).dataURL === before
    await patchEmulatorDocument(shareRef.path, { active: false })
    const sharedDeleteDenied = await denied(sharedPath)
    await patchEmulatorDocument(shareRef.path, { active: true })
    return {
      restrictedDeniesVisitor,
      publicViewerCanRead,
      publicViewerCannotUpload,
      publicEditorCanReuseAsset,
      revokedVisitorCannotRead,
      imageTombstoneRetainsBytes,
      imageRestoreReusesBytes,
      directStorageDenied,
      tokenCreationDenied,
      boardDeleteDeniesBoth,
      projectDeleteDeniesBoth,
      boardRestoreReusesBytes,
      projectRestoreReusesBytes,
      sharedDeleteDenied,
    }
  } finally {
    await Promise.all([
      patchEmulatorDocument(privateRef.path, { active: true }),
      patchEmulatorDocument(projectRef.path, { active: true }),
      patchEmulatorDocument(shareRef.path, { active: true, deletedAt: null }),
    ])
  }
}
