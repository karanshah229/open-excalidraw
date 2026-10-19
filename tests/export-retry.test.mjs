import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp } = require('firebase-admin/app')
const { getStorage } = require('firebase-admin/storage')
const adminApp = initializeApp({ projectId: 'demo-regression', storageBucket: 'demo-regression.appspot.com' }, 'export-retry')

if (process.env.GCLOUD_PROJECT !== 'demo-regression') throw new Error('Requires isolated regression emulators')
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
try {
  const page = await browser.newPage()
  await page.goto(process.env.E2E_BASE_URL)
  const fixture = await page.evaluate(async () => {
    const { signInOwner, pauseCloudReplication } = await import('/tests/regression-fixture.ts')
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { workspaceApi, workspaceStore } = await import('/src/features/workspace/workspace-api.ts')
    const { convertToExcalidrawElements } = await import('/tests/frame-reload-fixture.ts')
    const { sceneService } = await import('/src/features/scenes/scene-service.ts')
    await signInOwner(getFirebaseAuth())
    const project = await workspaceApi.createProject('Export retry')
    const board = await workspaceApi.createBoard(project.id, 'Missing image')
    const scene = {
      elements: convertToExcalidrawElements([
        { type: 'image', fileId: 'missing', status: 'saved', x: 0, y: 0, width: 100, height: 100 },
      ]),
      appState: {},
      files: {
        missing: {
          id: 'missing',
          mimeType: 'image/png',
          created: 1,
          dataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=',
        },
      },
    }
    await workspaceStore.saveBoard({ ...board, scene })
    await workspaceApi.flushCloud()
    const committed = await sceneService.load(board.id)
    const storagePath = committed.scene.files.missing.storagePath
    if (!storagePath) throw new Error('Image upload did not produce a cloud asset reference.')
    pauseCloudReplication()
    const localBoard = await workspaceStore.loadBoard(board.id)
    const localScene = {
      ...localBoard.scene,
      files: { ...localBoard.scene.files, missing: { ...localBoard.scene.files.missing, dataURL: '' } },
    }
    await workspaceStore.saveBoard({ ...localBoard, scene: localScene })
    return { boardId: board.id, projectId: project.id, storagePath }
  })
  // Admin SDK access is intentionally outside browser rules. This simulates a
  // valid asset that was removed from Storage after its scene was committed.
  await getStorage(adminApp).bucket().file(fixture.storagePath).delete()
  const result = await page.evaluate(async ({ boardId, projectId }) => {
    const { workspaceStore } = await import('/src/features/workspace/workspace-api.ts')
    const { exportBoards } = await import('/src/features/workspace/export-boards.ts')
    const failed = await exportBoards({ projectId, formats: ['excalidraw'] })
    const local = await workspaceStore.loadBoard(boardId)
    local.scene.files.missing.dataURL =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII='
    await workspaceStore.saveBoard(local)
    const retried = await exportBoards({ projectId, formats: ['excalidraw'], previous: failed })
    return { failed: failed.failures, files: retried.fileNames, failures: retried.failures }
  }, fixture)
  console.log('EXPORT RETRY DIAGNOSTIC', JSON.stringify(result))
  assert.equal(result.failed.length, 1, 'Missing cloud bytes must fail the initial export')
  assert.equal(result.files.length, 1, 'Retry must use the restored local bytes')
  assert.deepEqual(result.failures, [])
  console.log('PASS export retry preserves restored local image bytes while validating current board access')
} finally {
  await browser.close()
}
