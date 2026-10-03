import { doc, getDoc, setDoc } from 'firebase/firestore'
import { getFirebaseAuth, getFirestoreDb } from '../src/lib/firebase'
import { workspaceApi } from '../src/features/workspace/workspace-api'

export async function tombstoneProject(boardId: string, deleted: boolean) {
  const board = (await workspaceApi.loadBoard(boardId))!
  await setDoc(
    doc(getFirestoreDb()!, 'users', getFirebaseAuth()!.currentUser!.uid, 'projects', board.projectId),
    { deletedAt: deleted ? '2026-10-03T08:28:00.000Z' : null },
    { merge: true },
  )
}

export async function savePendingImage(boardId: string, dataURL: string) {
  const board = (await workspaceApi.loadBoard(boardId))!
  return workspaceApi.saveBoard({
    ...board,
    scene: {
      ...board.scene,
      elements: board.scene.elements.map((element) => ({ ...element, x: 240, version: Number(element.version) + 1 })),
      files: { ...board.scene.files, pending: { id: 'pending', dataURL, mimeType: 'image/png', created: 2 } },
    },
  })
}

export async function inspectDeletedProject(boardId: string) {
  const board = (await workspaceApi.loadBoard(boardId))!
  const projectRef = doc(getFirestoreDb()!, 'users', getFirebaseAuth()!.currentUser!.uid, 'projects', board.projectId)
  const [project, remote] = await Promise.all([getDoc(projectRef), getDoc(doc(projectRef, 'boards', boardId))])
  return {
    status: board.syncStatus,
    retry: board.nextSyncAt,
    error: board.lastSyncError,
    localImage: board.scene.files?.asset?.dataURL,
    pendingImage: board.scene.files?.pending?.dataURL,
    projectDeletedAt: project.data()?.deletedAt,
    remoteX: remote.data()?.scene?.elements[0]?.x,
    remotePendingPath: remote.data()?.scene?.files?.pending?.storagePath,
  }
}
