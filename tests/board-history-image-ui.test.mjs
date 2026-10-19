import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Requires disposable image history emulators')
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const app = initializeApp({ projectId: 'demo-regression' }), db = getFirestore(app)
const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190'
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const page = await browser.newPage(), calls = [], errors = []
page.setDefaultTimeout(60000)
await page.setViewport({ width: 1440, height: 900 })
page.on('dialog', (dialog) => dialog.accept())
page.on('pageerror', (error) => errors.push(error.message))
page.on('request', (request) => {
  if (request.method() !== 'POST' || !request.url().includes(':45001/')) return
  try { calls.push({ endpoint: request.url().split('/').pop(), data: JSON.parse(request.postData() || '{}').data }) } catch { /* Ignore non-callable requests. */ }
})
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR7sAAAAASUVORK5CYII='
try {
  await page.goto(base)
  const board = await page.evaluate(async (dataURL) => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner } = await import('/tests/regression-fixture.ts')
    await signInOwner(getFirebaseAuth())
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { convertToExcalidrawElements } = await import('/tests/history-fixture.ts')
    const project = await workspaceApi.createProject('Image history UI')
    const document = await workspaceApi.createBoard(project.id, 'Image original')
    const [rectangle] = convertToExcalidrawElements([{ type: 'rectangle', id: 'historical-image', x: 20, y: 20, width: 160, height: 160 }], { regenerateIds: false })
    const image = { ...rectangle, type: 'image', fileId: 'immutable-png', status: 'saved', scale: [1, 1], crop: null }
    await workspaceApi.saveBoard({ ...document, scene: { elements: [image], appState: { viewBackgroundColor: '#ffffff' }, files: { 'immutable-png': { id: 'immutable-png', dataURL, mimeType: 'image/png', created: Date.now() } } } })
    await workspaceApi.flushCloud()
    return { id: document.id, projectId: project.id }
  }, png)
  const target = (await db.doc(`boardScenes/${board.id}`).get()).data().currentVersionId
  assert.ok(calls.some((call) => call.endpoint === 'boardAsset' && call.data.operation === 'upload'), 'Image bytes use the real upload gateway')
  const pinned = await page.evaluate(async (id) => {
    const { readHistorySnapshot } = await import('/src/features/history/history-service.ts')
    const original = await readHistorySnapshot(id, undefined, false)
    return { contextId: original.readContextId, file: original.scene.files['immutable-png'] }
  }, board.id)
  assert.equal(pinned.file.dataURL, '')
  assert.ok(pinned.file.storagePath)
  await page.evaluate(async (id) => {
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const current = await workspaceApi.loadBoard(id)
    await workspaceApi.saveBoard({ ...current, name: 'Image removed', scene: { ...current.scene, elements: current.scene.elements.map((element) => ({ ...element, isDeleted: true, version: element.version + 1, updated: Date.now() })), files: {} } })
    await workspaceApi.flushCloud()
  }, board.id)
  const changed = (await db.doc(`boardScenes/${board.id}`).get()).data()
  assert.notEqual(changed.currentVersionId, target)
  const bytes = await page.evaluate(async ({ contextId, file }) => {
    const { projectCall } = await import('/src/features/sharing/project-service.ts')
    return projectCall('boardAsset', { operation: 'read', contextId, storagePath: file.storagePath })
  }, pinned)
  assert.equal(bytes.dataURL, png, 'A leased historical context survives ordinary head changes and still authorizes removed image bytes')
  const persisted = await page.evaluate(async (id) => { const { readHistorySnapshot } = await import('/src/features/history/history-service.ts'); const { boardHistoryStore } = await import('/tests/history-fixture.ts'); return { cloud: (await readHistorySnapshot(id, undefined, false)).scene.elements.filter((element) => !element.isDeleted).map((element) => element.id), native: (await boardHistoryStore.getCommittedContent(id)).document.scene.elements.filter((element) => !element.isDeleted).map((element) => element.id) } }, board.id)
  assert.deepEqual(persisted, { cloud: [], native: [] }, 'Cloud and native scene reflect image removal before opening editor')
  await page.goto(`${base}/boards/${board.id}`)
  await page.waitForSelector('[data-testid="board-history-open"]:not(:disabled)')
  await page.waitForFunction(() => !!window.__excalidrawAPI)
  assert.equal(await page.evaluate(() => window.__excalidrawAPI.getSceneElements().filter((element) => !element.isDeleted).length), 0)
  const previewStart = calls.length
  await page.click('[data-testid="board-history-open"]')
  await page.waitForSelector(`[data-version-id="${target}"]`)
  await page.click(`[data-version-id="${target}"]`)
  await page.waitForSelector('[data-testid="history-preview-canvas"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="history-restore"]')?.disabled)
  assert.equal(await page.evaluate(() => window.__excalidrawAPI.getSceneElements().filter((element) => !element.isDeleted).length), 0, 'Isolated preview leaves current canvas empty')
  assert.ok(calls.slice(previewStart).some((call) => call.endpoint === 'boardAsset' && call.data.operation === 'read' && call.data.contextId), 'Preview obtains bytes through its historical actor context')
  const writes = new Set(['commitBoardScene', 'updateBoardContent', 'importBoardVersion', 'restoreBoardVersion'])
  assert.ok(!calls.slice(previewStart).some((call) => writes.has(call.endpoint) || (call.endpoint === 'boardAsset' && call.data.operation === 'upload')), 'Preview makes no historical or current mutations')
  assert.equal((await db.doc(`boardScenes/${board.id}`).get()).data().currentVersionId, changed.currentVersionId)
  await page.click('[data-testid="history-restore"]')
  await page.waitForFunction(() => !!document.querySelector('[data-testid="history-data-loss-confirmation"]') || !!document.querySelector('[data-testid="history-restoration-progress"]'))
  if (await page.$('[data-testid="history-data-loss-confirmation"]')) await page.click('[data-testid="history-confirm-restore"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="board-history-dialog"]') && !document.querySelector('[data-testid="history-restoration-progress"]'))
  assert.ok(calls.some((call) => call.endpoint === 'restoreBoardVersion' && call.data.versionId === target), 'Restore starts through the real server operation after any dirty confirmation')
  const restored = await page.evaluate(() => ({ ids: window.__excalidrawAPI.getSceneElements().map((element) => element.id), file: window.__excalidrawAPI.getFiles()['immutable-png'] }))
  assert.deepEqual(restored.ids, ['historical-image'])
  assert.equal(restored.file.dataURL, png)
  await page.reload()
  await page.waitForFunction(() => !!window.__excalidrawAPI && window.__excalidrawAPI.getSceneElements().some((element) => element.id === 'historical-image') && !!window.__excalidrawAPI.getFiles()['immutable-png']?.dataURL)
  assert.equal(await page.evaluate(() => window.__excalidrawAPI.getFiles()['immutable-png'].dataURL), png, 'Cold reload hydrates restored image bytes')
  const decoded = await page.evaluate(async () => { const image = new Image(); image.src = window.__excalidrawAPI.getFiles()['immutable-png'].dataURL; await image.decode(); return image.naturalWidth })
  assert.equal(decoded, 1)
  console.log('PASS Image upload, historical lease after removal, readonly asset preview, complete restore and cold reload image decoding')
} finally {
  await writeFile(`${process.env.E2E_ARTIFACT_DIR || '.system_generated/regression'}/board-history-image-ui.json`, JSON.stringify({ calls, errors }, null, 2))
  await browser.close(); await deleteApp(app)
}
