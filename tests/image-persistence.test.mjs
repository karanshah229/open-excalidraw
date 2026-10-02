import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const require = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
// Isolate this test from production Firebase and other running dev servers.
const cloud = process.argv.includes('--cloud')
Object.assign(
  process.env,
  cloud
    ? {
        VITE_FIREBASE_API_KEY: 'emulator-only',
        VITE_FIREBASE_AUTH_DOMAIN: 'demo-image-persistence.firebaseapp.com',
        VITE_FIREBASE_PROJECT_ID: 'demo-image-persistence',
        VITE_FIREBASE_APP_ID: 'emulator-only',
        VITE_FIREBASE_STORAGE_BUCKET: 'demo-image-persistence.appspot.com',
        VITE_FIREBASE_DATABASE_URL: 'https://demo-image-persistence-default-rtdb.firebaseio.com',
        VITE_USE_FIREBASE_EMULATOR: 'true',
      }
    : { VITE_FIREBASE_API_KEY: '' },
)
const { createServer } = await import(require.resolve('vite'))
const server = await createServer({
  root: fileURLToPath(new URL('../apps/whiteboard', import.meta.url)),
  server: { host: '127.0.0.1', port: 15179, strictPort: true },
})
await server.listen()
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const dataURL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII='
try {
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:15179/', { waitUntil: 'domcontentloaded' })
  if (cloud) {
    const result = await page.evaluate(async (dataURL) => {
      const { exerciseCloudAssets } = await import('/tests/image-cloud-fixture.ts')
      return exerciseCloudAssets(dataURL)
    }, dataURL)
    assert.equal(result.privateInlineBytes, '')
    assert.equal(result.sharedInlineBytes, '')
    assert.equal(result.privateRestored, dataURL)
    assert.equal(result.sharedRestored, dataURL)
    assert.equal(result.missingFileRejected, true)
    assert.equal(result.privateReadDenied, true)
    console.log(
      'PASS: private/shared cloud image round trips; Firestore excludes bytes; private access enforced; missing bytes reject',
    )
  } else {
    const boardId = await page.evaluate(async () => {
      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
      const project = await workspaceApi.createProject('Image regression')
      return (await workspaceApi.createBoard(project.id, 'Uploaded image')).id
    })
    await page.goto(`http://127.0.0.1:15179/boards/${boardId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await page.evaluate(async (dataURL) => {
      const { convertToExcalidrawElements } = await import('/node_modules/.vite/deps/@excalidraw_excalidraw.js')
      const api = window.__excalidrawAPI
      window.__setUserInteracted()
      api.addFiles([{ id: 'uploaded-image', dataURL, mimeType: 'image/png', created: 1 }])
      api.updateScene({
        elements: convertToExcalidrawElements(
          [
            {
              id: 'image-element',
              type: 'image',
              fileId: 'uploaded-image',
              status: 'saved',
              x: 100,
              y: 100,
              width: 100,
              height: 100,
            },
          ],
          { regenerateIds: false },
        ),
      })
    }, dataURL)
    await page.waitForFunction(
      async (id) => {
        const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
        const board = await workspaceApi.loadBoard(id)
        return board?.scene.elements.some((element) => element.fileId === 'uploaded-image')
      },
      {},
      boardId,
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(window.__excalidrawAPI))
    const restored = await page.evaluate(() => window.__excalidrawAPI.getFiles()['uploaded-image']?.dataURL)
    assert.equal(restored, dataURL, 'Uploaded image bytes must be restored after reload')
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
}
