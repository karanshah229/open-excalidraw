import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const require = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
const { createServer } = await import(require.resolve('vite'))
Object.assign(process.env, {
  VITE_FIREBASE_API_KEY: 'emulator-only',
  VITE_FIREBASE_AUTH_DOMAIN: 'demo-image-persistence.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'demo-image-persistence',
  VITE_FIREBASE_APP_ID: 'emulator-only',
  VITE_FIREBASE_STORAGE_BUCKET: 'demo-image-persistence.appspot.com',
  VITE_FIREBASE_DATABASE_URL: 'https://demo-image-persistence-default-rtdb.firebaseio.com',
  VITE_USE_FIREBASE_EMULATOR: 'true',
  VITE_FIREBASE_SYNC_ACCESS_FUNCTION_REGION: 'us-central1',
})
const server = await createServer({
  root: fileURLToPath(new URL('../apps/whiteboard', import.meta.url)),
  server: { host: '127.0.0.1', port: 15188, strictPort: true },
})
const dataURL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII='
let browser
let page
let boardId
try {
  await server.listen()
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  })
  page = await browser.newPage()
  page.on('dialog', (dialog) => dialog.accept())
  const calls = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/boardAsset') && request.method() === 'POST') {
      try {
        calls.push(JSON.parse(request.postData()).data.operation)
      } catch {
        /* preflight */
      }
    }
  })
  await page.goto('http://127.0.0.1:15188/', { waitUntil: 'domcontentloaded' })
  boardId = await page.evaluate(async (dataURL) => {
    const { createFormatBoard } = await import('/tests/image-formats-fixture.ts')
    const { createPrivateImageBoard } = await import('/tests/image-cloud-fixture.ts')
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    await createFormatBoard('deleted parent regression', true, false)
    const boardId = await createPrivateImageBoard(dataURL)
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    await workspaceApi.ensureCloudBoardSynced(boardId, getFirebaseAuth().currentUser.uid)
    return boardId
  }, dataURL)
  await page.goto(`http://127.0.0.1:15188/boards/${boardId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__excalidrawAPI?.getFiles().asset?.dataURL))
  await page.evaluate(async (boardId) => {
    const { tombstoneProject } = await import('/tests/deleted-project-sync-fixture.ts')
    await tombstoneProject(boardId, true)
  }, boardId)
  await page.waitForFunction(() => document.body.innerText.includes('Project deleted'), { timeout: 10000 })
  assert.equal(await page.evaluate(() => window.__excalidrawAPI.getAppState().viewModeEnabled), true)
  const beforeBlockedSave = calls.length
  const pending = await page.evaluate(
    async ({ boardId, dataURL }) => {
      const { savePendingImage } = await import('/tests/deleted-project-sync-fixture.ts')
      return savePendingImage(boardId, dataURL)
    },
    { boardId, dataURL },
  )
  assert.equal(pending.syncStatus, 'sync-blocked')
  await new Promise((resolve) => setTimeout(resolve, 2200))
  const inspect = async () =>
    page.evaluate(async (boardId) => {
      const { inspectDeletedProject } = await import('/tests/deleted-project-sync-fixture.ts')
      return inspectDeletedProject(boardId)
    }, boardId)
  const blocked = await inspect()
  assert.equal(blocked.status, 'sync-blocked')
  assert.equal(blocked.retry, null)
  assert.equal(blocked.projectDeletedAt, '2026-10-03T08:28:00.000Z')
  assert.equal(blocked.localImage, dataURL)
  assert.equal(blocked.pendingImage, dataURL)
  assert.equal(calls.length - beforeBlockedSave, 0, 'Blocked saves must not call the image gateway')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.innerText.includes('Project deleted'))
  assert.equal((await inspect()).pendingImage, dataURL, 'Pending bytes must survive reload')
  await page.evaluate(async (boardId) => {
    const { tombstoneProject } = await import('/tests/deleted-project-sync-fixture.ts')
    await tombstoneProject(boardId, false)
  }, boardId)
  await page.waitForFunction(
    async (boardId) => {
      const { inspectDeletedProject } = await import('/tests/deleted-project-sync-fixture.ts')
      const state = await inspectDeletedProject(boardId)
      return state.status === 'synced' && state.remoteX === 240 && Boolean(state.remotePendingPath)
    },
    { timeout: 30000, polling: 500 },
    boardId,
  )
  assert.equal(await page.evaluate(() => window.__excalidrawAPI.getAppState().viewModeEnabled), false)
  console.log(
    'PASS: deleted parent blocks sync without dropping its tombstone; pending bytes survive reload; restore resumes sync and editing',
  )
} catch (error) {
  console.error('Failure:', error.message)
  if (page && boardId)
    console.error(
      await page
        .evaluate(async (id) => {
          const { inspectDeletedProject } = await import('/tests/deleted-project-sync-fixture.ts')
          const state = await inspectDeletedProject(id)
          return {
            status: state.status,
            error: state.error,
            projectDeletedAt: state.projectDeletedAt,
            viewMode: window.__excalidrawAPI?.getAppState().viewModeEnabled,
            text: document.body.innerText,
          }
        }, boardId)
        .catch((error) => ({ diagnosticError: error.message })),
    )
  await mkdir('.system_generated/deleted-project-sync', { recursive: true })
  await page?.screenshot({ path: '.system_generated/deleted-project-sync/failure.png' })
  throw error
} finally {
  await browser?.close()
  await server.close()
}
