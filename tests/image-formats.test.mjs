import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const require = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
const { createServer, loadEnv } = await import(require.resolve('vite'))
const liveArg = process.argv.find((arg) => arg.startsWith('--live='))
if (liveArg && liveArg !== '--live=development') throw new Error('Live format tests support development only')
const live = Boolean(liveArg)
const cloud = process.argv.includes('--cloud') || live
const productionBundle = process.argv.includes('--production-bundle')
const selected = process.argv.find((arg) => arg.startsWith('--format='))?.slice(9)
const formats = ['png', 'jpg', 'svg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'jfif']
if (selected && !formats.includes(selected)) throw new Error(`Unknown format ${selected}`)
const root = fileURLToPath(new URL('../apps/whiteboard', import.meta.url))
Object.assign(
  process.env,
  live
    ? {
        ...loadEnv('development', root, 'VITE_'),
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
const mode = (live ? 'development' : cloud ? 'emulators' : 'local') + (productionBundle ? '-production-bundle' : '')
const port = Number(process.env.FORMAT_TEST_PORT) || (live ? 15183 : cloud ? 15182 : 15181) + (productionBundle ? 4 : 0)
const baseURL = `http://127.0.0.1:${port}`
const reportDir = fileURLToPath(new URL(`../.system_generated/image-formats/${mode}/`, import.meta.url))
await mkdir(reportDir, { recursive: true })
const server = await createServer({
  root,
  // Keep test optimization independent of the long-running developer server.
  cacheDir: fileURLToPath(
    new URL(
      `../apps/whiteboard/node_modules/.vite-image-formats-${productionBundle ? 'production' : 'development'}`,
      import.meta.url,
    ),
  ),
  ...(productionBundle
    ? {
        resolve: { conditions: ['module', 'browser', 'production'] },
      }
    : {}),
  server: { host: '127.0.0.1', port, strictPort: true },
})
let browser
const results = []
const startedAt = new Date().toISOString()
let browserVersion

// Inspect actual rendered canvas pixels, rather than accepting an image element with missing bytes.
async function rendered(page) {
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('canvas')).some((canvas) => {
        try {
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
          let green = 0
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] < 90 && pixels[i + 1] > 140 && pixels[i + 2] < 140 && pixels[i + 3] > 200) green++
            if (green > 100) return true
          }
        } catch {
          /* Non-2D canvases are irrelevant. */
        }
        return false
      }),
    { timeout: 20000 },
  )
}
async function cloudSaved(page, boardId, fileId, shared, expectedPosition) {
  await page.waitForFunction(
    async ({ boardId, fileId, shared, expectedPosition }) => {
      const { readFormatScene } = await import('/tests/image-formats-fixture.ts')
      const scene = await readFormatScene(boardId, shared)
      const file = scene?.files?.[fileId]
      const element = scene?.elements?.find((el) => el.fileId === fileId)
      return (
        file?.storagePath &&
        file.dataURL === '' &&
        element &&
        (!expectedPosition || (element.x === expectedPosition.x && element.y === expectedPosition.y))
      )
    },
    { timeout: live ? 90000 : 30000, polling: 500 },
    { boardId, fileId, shared, expectedPosition },
  )
}
try {
  await server.listen()
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  })
  browserVersion = await browser.version()
  for (const format of selected ? [selected] : formats) {
    const start = Date.now()
    const result = { format, status: 'failed', checks: [], network: {}, errors: [] }
    const page = await browser.newPage()
    const calls = []
    const probe = await browser.newPage()
    try {
      await probe.setContent('<input type="file">')
      await (
        await probe.$('input')
      ).uploadFile(fileURLToPath(new URL(`./fixtures/image-formats/pattern.${format}`, import.meta.url)))
      result.selectedFile = await probe.$eval('input', (input) => {
        const file = input.files[0]
        return { name: file.name, type: file.type, size: file.size }
      })
    } finally {
      await probe.close()
    }
    page.setDefaultTimeout(30000)
    await page.setViewport({ width: 1280, height: 900 })
    page.on('dialog', (dialog) => (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()))
    page.on('pageerror', (error) => result.errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('Failed to save share config on done:'))
        result.sharingError = message.text()
    })
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/boardAsset') && request.method() === 'POST') {
        try {
          calls.push(JSON.parse(request.postData()).data.operation)
        } catch {
          /* preflight */
        }
      }
    })
    await page.evaluateOnNewDocument(() => {
      delete window.showOpenFilePicker
    })
    try {
      await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' })
      const boardId = await page.evaluate(
        async ({ format, cloud, live }) => {
          const { createFormatBoard } = await import('/tests/image-formats-fixture.ts')
          return createFormatBoard(format, cloud, live)
        },
        { format, cloud, live },
      )
      result.boardId = boardId
      await page.goto(`${baseURL}/boards/${boardId}`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => Boolean(window.__excalidrawAPI))
      const chooserPromise = page.waitForFileChooser()
      await page.click('[data-testid="toolbar-image"]')
      await (
        await chooserPromise
      ).accept([fileURLToPath(new URL(`./fixtures/image-formats/pattern.${format}`, import.meta.url))])
      await page.waitForFunction(
        () =>
          Boolean(window.__excalidrawAPI.getAppState().pendingImageElementId) ||
          document.body.innerText.includes('Unsupported file type.'),
      )
      assert.equal(
        await page.evaluate(() => document.body.innerText.includes('Unsupported file type.')),
        false,
        `Image picker rejected ${format} (${result.selectedFile?.type}) as Unsupported file type`,
      )
      await page.waitForFunction(
        () => {
          const canvas = document.querySelector('canvas.interactive')
          return canvas && getComputedStyle(canvas).cursor === 'move'
        },
        { timeout: 5000 },
      )
      result.checks.push('move cursor while placing image')
      await page.mouse.click(450, 380)
      await page.waitForFunction(() => {
        const api = window.__excalidrawAPI
        const el = api.getSceneElements().find((el) => el.type === 'image')
        return Boolean(el && api.getFiles()[el.fileId]?.dataURL)
      })
      assert.equal(await page.evaluate(() => window.__excalidrawAPI.getAppState().pendingImageElementId), null)
      assert.notEqual(await page.$eval('canvas.interactive', (canvas) => getComputedStyle(canvas).cursor), 'wait')
      result.checks.push('placement completes and wait cursor clears')
      const uploaded = await page.evaluate(() => {
        const api = window.__excalidrawAPI
        const element = api.getSceneElements().find((el) => el.type === 'image')
        return { fileId: element.fileId, ...api.getFiles()[element.fileId] }
      })
      assert.ok(uploaded.dataURL?.startsWith('data:image/'))
      result.fileId = uploaded.fileId
      result.storedMimeType = uploaded.mimeType
      result.checks.push('real image-picker upload')
      await rendered(page)
      result.checks.push('image visibly renders')
      await page.waitForFunction(
        async ({ boardId, fileId }) => {
          const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
          return Boolean((await workspaceApi.loadBoard(boardId))?.scene.files?.[fileId]?.dataURL)
        },
        {},
        { boardId, fileId: uploaded.fileId },
      )
      if (cloud) {
        await cloudSaved(page, boardId, uploaded.fileId, false)
        await page.evaluate(async (boardId) => {
          const { removeFormatCache } = await import('/tests/image-formats-fixture.ts')
          await removeFormatCache(boardId, false)
        }, boardId)
      }
      const beforeReload = calls.length
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForFunction((id) => Boolean(window.__excalidrawAPI?.getFiles()[id]?.dataURL), {}, uploaded.fileId)
      assert.equal(
        await page.evaluate((id) => window.__excalidrawAPI.getFiles()[id].dataURL, uploaded.fileId),
        uploaded.dataURL,
      )
      await rendered(page)
      result.checks.push(
        cloud ? 'private cloud reload with cached bytes removed' : 'local reload retains exact stored bytes',
      )
      if (cloud) {
        assert.ok(calls.slice(beforeReload).includes('read'), 'Reload must actually fetch stored image bytes')
        await page.click('button[title="Share board"]')
        await page.waitForSelector('.google-share-dialog')
        await page.click('button.google-share-done-btn')
        await page.waitForSelector('.google-share-dialog', { hidden: true })
        assert.ok(!result.sharingError, result.sharingError)
        await cloudSaved(page, boardId, uploaded.fileId, true)
        result.checks.push('Share dialog persists image without inline Firestore bytes')
        await page.evaluate(async (boardId) => {
          const { removeFormatCache } = await import('/tests/image-formats-fixture.ts')
          await removeFormatCache(boardId, true)
        }, boardId)
        const beforeSharedReload = calls.length
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.waitForFunction(
          (id) => Boolean(window.__excalidrawAPI?.getFiles()[id]?.dataURL),
          {},
          uploaded.fileId,
        )
        assert.equal(
          await page.evaluate((id) => window.__excalidrawAPI.getFiles()[id].dataURL, uploaded.fileId),
          uploaded.dataURL,
        )
        assert.ok(calls.slice(beforeSharedReload).includes('read'), 'Shared reload must fetch stored bytes')
        await rendered(page)
        result.checks.push('shared cloud reload with cached bytes removed')
      }
      await page.click('[data-testid="toolbar-selection"]')
      // Allow initial centering and hydration to finish before measuring a real pointer drag.
      await new Promise((resolve) => setTimeout(resolve, 700))
      const position = await page.evaluate((id) => {
        const api = window.__excalidrawAPI
        const el = api.getSceneElements().find((el) => el.fileId === id)
        const s = api.getAppState()
        return {
          sceneX: el.x,
          x: (el.x + el.width / 2 + s.scrollX) * s.zoom.value + s.offsetLeft,
          y: (el.y + el.height / 2 + s.scrollY) * s.zoom.value + s.offsetTop,
        }
      }, uploaded.fileId)
      const beforeMove = calls.length
      await page.mouse.move(position.x, position.y)
      await page.mouse.down()
      await page.mouse.move(position.x + 90, position.y + 60, { steps: 10 })
      await page.mouse.up()
      await page.waitForFunction(
        ({ id, x }) => window.__excalidrawAPI.getSceneElements().find((el) => el.fileId === id)?.x !== x,
        {},
        { id: uploaded.fileId, x: position.sceneX },
      )
      const expectedPosition = await page.evaluate((id) => {
        const el = window.__excalidrawAPI.getSceneElements().find((el) => el.fileId === id)
        return { x: el.x, y: el.y }
      }, uploaded.fileId)
      if (cloud) await cloudSaved(page, boardId, uploaded.fileId, true, expectedPosition)
      else
        await page.waitForFunction(
          async ({ boardId, fileId, expectedPosition }) => {
            const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
            const el = (await workspaceApi.loadBoard(boardId))?.scene.elements.find((el) => el.fileId === fileId)
            return el?.x === expectedPosition.x && el?.y === expectedPosition.y
          },
          {},
          { boardId, fileId: uploaded.fileId, expectedPosition },
        )
      const movementTransfers = calls.slice(beforeMove).filter((op) => ['upload', 'read'].includes(op)).length
      assert.equal(movementTransfers, 0, 'Movement must not transfer image bytes')
      result.checks.push('real mouse movement persists position with zero image byte transfers')
      if (cloud)
        assert.equal(calls.filter((op) => op === 'upload').length, 2, 'One upload each for private and shared paths')
      result.network = {
        uploads: calls.filter((op) => op === 'upload').length,
        reads: calls.filter((op) => op === 'read').length,
        movementTransfers,
      }
      await page.screenshot({ path: `${reportDir}/${format}.png` })
      result.status = 'passed'
      console.log(`PASS ${format}: ${result.checks.length} checks; stored as ${result.storedMimeType}`)
    } catch (error) {
      result.failure = error.message
      result.failureStack = error.stack
      result.network = { calls }
      if (cloud && result.boardId)
        result.diagnostic = await page
          .evaluate(async (boardId) => {
            const { readFormatScene } = await import('/tests/image-formats-fixture.ts')
            try {
              const scene = await readFormatScene(boardId, false)
              return {
                elements: scene?.elements?.map(({ fileId, type }) => ({ fileId, type })),
                files: Object.fromEntries(
                  Object.entries(scene?.files || {}).map(([id, file]) => [
                    id,
                    {
                      mimeType: file.mimeType,
                      storagePath: file.storagePath,
                      hasBytes: Boolean(file.dataURL),
                      dataURLEmpty: file.dataURL === '',
                    },
                  ]),
                ),
              }
            } catch (error) {
              return { error: error.message }
            }
          }, result.boardId)
          .catch((error) => ({ error: error.message }))
      console.error(`Completed checks: ${result.checks.join('; ')}\n${error.stack}`)
      await page.screenshot({ path: `${reportDir}/${format}-failure.png` }).catch(() => {})
      console.error(`FAIL ${format}: ${error.message}`)
    } finally {
      result.durationMs = Date.now() - start
      results.push(result)
      await page.close()
    }
  }
} finally {
  await browser?.close()
  await server.close()
  const report = {
    formats: selected ? [selected] : formats,
    excalidrawBundle: productionBundle ? 'production' : 'development',
    startedAt,
    finishedAt: new Date().toISOString(),
    mode,
    browserVersion,
    project: live ? 'open-excalidraw-dev-2' : cloud ? 'demo-image-persistence' : null,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status !== 'passed').length,
    results,
  }
  await writeFile(`${reportDir}/results.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(`Report: ${reportDir}/results.json (${report.passed} passed, ${report.failed} failed)`)
  if (report.failed) process.exitCode = 1
}
