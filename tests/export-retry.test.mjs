import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'

if (process.env.GCLOUD_PROJECT !== 'demo-regression') throw new Error('Requires isolated regression emulators')
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
try {
  const page = await browser.newPage()
  await page.goto(process.env.E2E_BASE_URL)
  const result = await page.evaluate(async () => {
    const { signInOwner, pauseCloudReplication } = await import('/tests/regression-fixture.ts')
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { workspaceApi, workspaceStore } = await import('/src/features/workspace/workspace-api.ts')
    const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
    const { convertToExcalidrawElements } = await import('/tests/frame-reload-fixture.ts')
    const { exportBoards } = await import('/src/features/workspace/export-boards.ts')
    const { user } = await signInOwner(getFirebaseAuth())
    const project = await workspaceApi.createProject('Export retry')
    const board = await workspaceApi.createBoard(project.id, 'Missing image')
    await workspaceApi.flushCloud()
    await sharingService.saveShareConfig(await sharingService.getShareConfig(board.id))
    // Restore local bytes without a competing automatic cloud commit. Conflict
    // exports are covered separately by the account-export browser scenarios.
    pauseCloudReplication()
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
          dataURL: '',
          storagePath: `users/${user.uid}/boards/${board.id}/assets/missing`,
        },
      },
    }
    await sharingService.updateSharedScene(board.id, scene)
    await workspaceStore.saveBoard({ ...(await workspaceStore.loadBoard(board.id)), scene })
    const failed = await exportBoards({ projectId: project.id, formats: ['excalidraw'] })
    const local = await workspaceStore.loadBoard(board.id)
    local.scene.files.missing.dataURL =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII='
    await workspaceStore.saveBoard(local)
    const retried = await exportBoards({ projectId: project.id, formats: ['excalidraw'], previous: failed })
    return { failed: failed.failures, files: retried.fileNames, failures: retried.failures }
  })
  assert.equal(result.failed.length, 1, 'Missing cloud bytes must fail the initial export')
  assert.equal(result.files.length, 1, 'Retry must use the restored local bytes')
  assert.deepEqual(result.failures, [])
  console.log('PASS export retry preserves restored local image bytes while validating current board access')
} finally {
  await browser.close()
}
