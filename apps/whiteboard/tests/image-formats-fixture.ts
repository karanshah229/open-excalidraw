import { createUserWithEmailAndPassword, signInAnonymously } from 'firebase/auth'
import { getFirebaseAuth } from '../src/lib/firebase'
import { workspaceApi } from '../src/features/workspace/workspace-api'
import { sceneService } from '../src/features/scenes/scene-service'
import { readHistorySnapshot } from '../src/features/history/history-service'
import { boardHistoryStore } from '@agentic-whiteboard/storage'

export { boardHistoryStore, workspaceApi }

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
  if (cloud) {
    // The test immediately navigates to cloud history after returning. Drain
    // the initial owner sync and establish the canonical head first so a
    // snapshot cannot race board publication/migration.
    await workspaceApi.flushCloud()
    await sceneService.ensure(board.id, project.id)
  }
  return board.id
}

export async function readFormatScene(boardId: string, shared: boolean) {
  void shared // Both private and link-shared history v1 scenes use the authorized gateway.
  return (await readHistorySnapshot(boardId, undefined, false, false)).scene
}

// Remove cached bytes to make the following reload prove gateway/Storage restoration.
export async function removeFormatCache(boardId: string, shared: boolean) {
  const board = (await workspaceApi.loadBoard(boardId))!
  const scene = await readFormatScene(boardId, shared)
  if (!scene?.files || Object.values(scene.files).some((file: any) => file.dataURL || !file.storagePath))
    throw new Error('Expected a metadata-only cloud scene before clearing cached bytes')
  await workspaceApi.saveBoard({ ...board, scene })
}
