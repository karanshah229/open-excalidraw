import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const require = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
// Isolate this test from production Firebase and other running dev servers.
const live = process.argv.find((arg) => arg.startsWith('--live='))?.split('=')[1]
if (live && !['development', 'production'].includes(live))
  throw new Error('Use --live=development or --live=production')
const cloud = process.argv.includes('--cloud') || Boolean(live)
const { createServer, loadEnv } = await import(require.resolve('vite'))
Object.assign(
  process.env,
  live
    ? {
        ...loadEnv(live, fileURLToPath(new URL('../apps/whiteboard', import.meta.url)), 'VITE_'),
        VITE_USE_FIREBASE_EMULATOR: 'false',
      }
    : cloud
      ? {
          VITE_FIREBASE_API_KEY: 'emulator-only',
          VITE_FIREBASE_AUTH_DOMAIN: 'demo-image-persistence.firebaseapp.com',
          VITE_FIREBASE_PROJECT_ID: 'demo-image-persistence',
          VITE_FIREBASE_APP_ID: 'emulator-only',
          VITE_FIREBASE_STORAGE_BUCKET: 'demo-image-persistence.appspot.com',
          VITE_FIREBASE_DATABASE_URL: 'https://demo-image-persistence-default-rtdb.firebaseio.com',
          VITE_USE_FIREBASE_EMULATOR: 'true',
          VITE_FIREBASE_SYNC_ACCESS_FUNCTION_REGION: 'us-central1',
        }
      : { VITE_FIREBASE_API_KEY: '' },
)
const server = await createServer({
  root: fileURLToPath(new URL('../apps/whiteboard', import.meta.url)),
  server: { host: '127.0.0.1', port: 15179, strictPort: true, hmr: false },
})
await server.listen()
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const dataURL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII='
const fixtureDir = await mkdtemp(join(tmpdir(), 'image-e2e-'))
const fixturePath = join(fixtureDir, 'uploaded-image.png')
await writeFile(fixturePath, Buffer.from(dataURL.split(',')[1], 'base64'))
try {
  const page = await browser.newPage()
  // Only generated test boards are used here; allow reload while background
  // cloud sync settles after the deliberately metadata-only local snapshot.
  page.on('dialog', (dialog) => (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()))
  // Chromium cannot intercept the OS File System Access picker. Exercise
  // Excalidraw's supported HTML file-input fallback through the real toolbar.
  await page.evaluateOnNewDocument(() => {
    delete window.showOpenFilePicker
  })
  await page.goto('http://127.0.0.1:15179/', { waitUntil: 'domcontentloaded' })
  if (cloud) {
    const storageRequests = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/boardAsset'))
        storageRequests.push({
          method: request.method(),
          url: request.url(),
          operation: (() => {
            try {
              return JSON.parse(request.postData() || '{}').data?.operation
            } catch {
              return undefined
            }
          })(),
        })
    })
    const result = await page.evaluate(
      async ({ dataURL, live }) => {
        const { exerciseCloudAssets } = await import('/tests/image-cloud-fixture.ts')
        return exerciseCloudAssets(dataURL, live)
      },
      { dataURL, live },
    )
    assert.equal(result.privateInlineBytes, '')
    assert.equal(result.sharedInlineBytes, '')
    assert.equal(result.privateRestored, dataURL)
    assert.equal(result.sharedRestored, dataURL)
    assert.equal(result.missingFileRejected, true)
    assert.equal(result.privateReadDenied, true)
    assert.equal(result.privateGatewayReadDenied, true)
    assert.equal(
      storageRequests.filter((request) => request.operation === 'upload').length,
      2,
      'One initial upload per private/shared asset path',
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    const beforeMove = storageRequests.filter((request) => request.operation === 'upload').length
    const moved = await page.evaluate(async (id) => {
      const { moveSharedImage } = await import('/tests/image-cloud-fixture.ts')
      return moveSharedImage(id)
    }, result.sharedId)
    assert.equal(moved.x, 60)
    assert.equal(moved.fileId, 'asset')
    const movementUploads = storageRequests.filter((request) => request.operation === 'upload').length - beforeMove
    assert.equal(movementUploads, 0, 'Moving an existing image after reload must not upload its bytes again')
    await page.goto(`http://127.0.0.1:15179/boards/${result.sharedId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(window.__excalidrawAPI?.getFiles().asset?.dataURL))
    await page.click('[data-testid="toolbar-selection"]')
    // Let the initial auto-center and snapshot hydration settle before measuring.
    await new Promise((resolve) => setTimeout(resolve, 700))
    const beforeDragRequests = storageRequests.length
    for (let drag = 0; drag < 3; drag++) {
      const position = await page.evaluate(() => {
        const api = window.__excalidrawAPI
        const element = api.getSceneElements().find((el) => el.fileId === 'asset')
        const state = api.getAppState()
        return {
          sceneX: element.x,
          sceneY: element.y,
          x: (element.x + element.width / 2 + state.scrollX) * state.zoom.value + state.offsetLeft,
          y: (element.y + element.height / 2 + state.scrollY) * state.zoom.value + state.offsetTop,
        }
      })
      await page.mouse.move(position.x, position.y)
      await page.mouse.down()
      await page.mouse.move(position.x + 40, position.y + 25, { steps: 8 })
      await page.mouse.up()
      await page.waitForFunction(
        (oldX) => window.__excalidrawAPI.getSceneElements().find((el) => el.fileId === 'asset').x !== oldX,
        {},
        position.sceneX,
      )
      const expected = await page.evaluate(() => {
        const el = window.__excalidrawAPI.getSceneElements().find((el) => el.fileId === 'asset')
        return { x: el.x, y: el.y }
      })
      await page.waitForFunction(
        async ({ boardId, expected }) => {
          const { readSharedPosition } = await import('/tests/image-cloud-fixture.ts')
          const saved = await readSharedPosition(boardId)
          return saved.x === expected.x && saved.y === expected.y && saved.dataURL === ''
        },
        {},
        { boardId: result.sharedId, expected },
      )
    }
    const dragRequests = storageRequests.slice(beforeDragRequests)
    assert.equal(
      dragRequests.filter((request) => ['upload', 'read'].includes(request.operation)).length,
      0,
      'Real mouse drags must not upload or download image bytes',
    )
    console.log('PASS: real editor mouse drags persist positions with zero image upload/download calls')
    console.log('PASS: network asserts two initial uploads and zero uploads for three moves after reload')
    console.log(
      'PASS: private/shared cloud image round trips; Firestore excludes bytes; private access enforced; missing bytes reject',
    )
    const dialogBoardId = await page.evaluate(async (dataURL) => {
      const { createPrivateImageBoard } = await import('/tests/image-cloud-fixture.ts')
      return createPrivateImageBoard(dataURL)
    }, dataURL)
    await page.goto(`http://127.0.0.1:15179/boards/${dialogBoardId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(window.__excalidrawAPI?.getFiles().asset?.dataURL))
    await page.click('button[title="Share board"]')
    await page.waitForSelector('.google-share-dialog')
    // The merged sharing dialog saves policy changes once; unchanged Done only closes.
    await page.click('[aria-label="General access setting"]')
    await page.click('.google-share-dropdown-item:last-child')
    await page.waitForFunction(() => !document.querySelector('button.google-share-done-btn')?.disabled)

    const done = await page.$('button.google-share-done-btn')
    assert.ok(done, 'Sharing dialog exposes Done')
    await done.click()
    await page.waitForSelector('.google-share-dialog', { hidden: true })
    await page.waitForFunction(
      async (boardId) => {
        const { readSharedImagePath } = await import('/tests/image-cloud-fixture.ts')
        return (await readSharedImagePath(boardId))?.endsWith(`/boards/${boardId}/assets/asset`)
      },
      {},
      dialogBoardId,
    )
    console.log('PASS: real Share dialog includes image files in the shared cloud scene')
    await page.evaluate(async (boardId) => {
      const { persistMetadataOnlyLocalScene } = await import('/tests/image-cloud-fixture.ts')
      await persistMetadataOnlyLocalScene(boardId)
    }, dialogBoardId)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(window.__excalidrawAPI?.getFiles().asset?.dataURL))
    assert.equal(await page.evaluate(() => window.__excalidrawAPI.getFiles().asset.dataURL), dataURL)
    console.log('PASS: shared editor reload hydrates bytes when local files contain only Storage metadata')
    const lifecycle = await page.evaluate(async (boardId) => {
      const { exerciseAssetLifecycle } = await import('/tests/image-cloud-fixture.ts')
      return exerciseAssetLifecycle(boardId)
    }, dialogBoardId)
    assert.ok(
      Object.values(lifecycle).every((value) => value === true),
      JSON.stringify(lifecycle),
    )
    console.log(
      'PASS: image tombstones retain bytes; board/project soft delete denies private/shared reads; restore reuses bytes; direct Storage/token access blocked',
    )
  } else {
    const boardId = await page.evaluate(async () => {
      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
      const project = await workspaceApi.createProject('Image regression')
      return (await workspaceApi.createBoard(project.id, 'Uploaded image')).id
    })
    await page.goto(`http://127.0.0.1:15179/boards/${boardId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(window.__excalidrawAPI))
    const chooserPromise = page.waitForFileChooser()
    await page.click('[data-testid="toolbar-image"]')
    const chooser = await chooserPromise
    await chooser.accept([fixturePath])
    await page.waitForFunction(() => Boolean(window.__excalidrawAPI.getAppState().pendingImageElementId))
    await page.waitForFunction(() => Object.keys(window.__excalidrawAPI.getFiles()).length > 0)
    await page.mouse.click(400, 350)
    await page.waitForFunction(() =>
      window.__excalidrawAPI.getSceneElements().some((element) => element.type === 'image'),
    )
    const fileId = await page.evaluate(
      () => window.__excalidrawAPI.getSceneElements().find((element) => element.type === 'image').fileId,
    )
    const uploadedDataURL = await page.evaluate((id) => window.__excalidrawAPI.getFiles()[id].dataURL, fileId)
    await page.waitForFunction(
      async ({ id, fileId }) => {
        const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
        const board = await workspaceApi.loadBoard(id)
        return Boolean(board?.scene.files?.[fileId]?.dataURL)
      },
      {},
      { id: boardId, fileId },
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(window.__excalidrawAPI))
    const restored = await page.evaluate((id) => window.__excalidrawAPI.getFiles()[id]?.dataURL, fileId)
    assert.equal(restored, uploadedDataURL, 'Uploaded image bytes must be restored after reload')
    // Excalidraw can deliver file bytes after the element itself was saved.
    await page.evaluate(async () => {
      const { convertToExcalidrawElements } = await import('/node_modules/.vite/deps/@excalidraw_excalidraw.js')
      const api = window.__excalidrawAPI
      window.__setUserInteracted()
      api.updateScene({
        elements: [
          ...api.getSceneElements(),
          ...convertToExcalidrawElements(
            [
              {
                id: 'late-element',
                type: 'image',
                fileId: 'late-image',
                status: 'saved',
                x: 250,
                y: 100,
                width: 100,
                height: 100,
              },
            ],
            { regenerateIds: false },
          ),
        ],
      })
    })
    await page.waitForFunction(
      async (id) => {
        const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
        return (await workspaceApi.loadBoard(id))?.scene.elements.some((el) => el.fileId === 'late-image')
      },
      {},
      boardId,
    )
    await page.evaluate((dataURL) => {
      window.__excalidrawAPI.addFiles([{ id: 'late-image', dataURL, mimeType: 'image/png', created: 2 }])
    }, dataURL)
    await page.waitForFunction(
      async (id) => {
        const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
        return Boolean((await workspaceApi.loadBoard(id))?.scene.files?.['late-image']?.dataURL)
      },
      {},
      boardId,
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(window.__excalidrawAPI))
    assert.equal(await page.evaluate(() => window.__excalidrawAPI.getFiles()['late-image']?.dataURL), dataURL)
    console.log('PASS: uploaded images and later file-only changes survive save and page reload')
  }
} finally {
  await browser.close()
  await server.close()
  await rm(fixtureDir, { recursive: true })
}
