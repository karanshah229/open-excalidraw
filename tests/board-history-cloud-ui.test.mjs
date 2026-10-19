import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Requires isolated history regression emulators')
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { getDatabase } = require('firebase-admin/database')
const app = initializeApp({ projectId: 'demo-regression', databaseURL: 'https://demo-regression.firebaseio.com' })
const db = getFirestore(app)
const rtdb = getDatabase(app)
const { loadNoteSnapshot } = await import('../functions/lib/board-history-notes.js')
const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190'
const artifacts = process.env.E2E_ARTIFACT_DIR || '.system_generated/regression'
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const ownerContext = await browser.createBrowserContext(), guestContext = await browser.createBrowserContext(), viewerContext = await browser.createBrowserContext()
const owner = await ownerContext.newPage(), guest = await guestContext.newPage(), viewer = await viewerContext.newPage()
const calls = [], errors = []
for (const [name, page] of [['owner', owner], ['guest', guest], ['viewer', viewer]]) {
  page.setDefaultTimeout(45000)
  await page.setViewport({ width: 1440, height: 900 })
  page.on('dialog', (dialog) => dialog.accept())
  page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`))
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().includes(':45001/')) return
    try { calls.push({ peer: name, endpoint: request.url().split('/').pop(), data: JSON.parse(request.postData() || '{}').data }) } catch { /* other request */ }
  })
  await page.evaluateOnNewDocument(() => {
    window.__historyProgressSeen = false
    new MutationObserver(() => { if (document.querySelector('[data-testid="history-restoration-progress"]')) window.__historyProgressSeen = true }).observe(document, { childList: true, subtree: true })
  })
}
const wait = async (predicate, message) => {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 100)) }
  throw new Error(message)
}
try {
  await owner.goto(base)
  const seed = await owner.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner } = await import('/tests/regression-fixture.ts')
    const { user } = await signInOwner(getFirebaseAuth())
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
    const { convertToExcalidrawElements } = await import('/tests/history-fixture.ts')
    const project = await workspaceApi.createProject('History cloud UI')
    const board = await workspaceApi.createBoard(project.id, 'Cloud original')
    const elements = convertToExcalidrawElements([
      { type: 'rectangle', id: 'cloud-original', x: 30, y: 30, width: 100, height: 80 },
      { type: 'frame', id: 'slide-one', children: ['cloud-original'], x: 0, y: 0, width: 400, height: 300, name: 'First slide', customData: { agenticWhiteboard: { slide: { schemaVersion: 1, orderKey: '0/1' } } } },
    ], { regenerateIds: false })
    const scene = { elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} }
    await workspaceApi.saveBoard({ ...board, scene })
    await workspaceApi.flushCloud()
    const config = await sharingService.getShareConfig(board.id, { ownerId: user.uid, boardName: board.name, scene })
    await sharingService.saveShareConfig({ ...config, generalAccess: 'anyone_with_link', generalRole: 'editor', scene })
    return { id: board.id, projectId: project.id }
  })
  await owner.goto(`${base}/boards/${seed.id}`)
  await owner.waitForSelector('[data-testid="board-history-open"]:not(:disabled)')
  if (!(await owner.$('.slides-panel'))) await owner.click('.slides-toggle')
  await owner.waitForSelector('.slide-properties')
  await owner.$eval('.slide-properties', (element) => [...element.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Notes')?.click())
  await owner.waitForSelector('#slide-notes-input:not([disabled])')
  await owner.type('#slide-notes-input', 'Canonical original speaker note')
  await wait(async () => {
    const head = (await db.doc(`boardScenes/${seed.id}`).get()).data()
    const notes = head?.notesRevisionId ? await loadNoteSnapshot(seed.id, head.notesRevisionId) : null
    return JSON.stringify(notes ?? {}).includes('Canonical original speaker note')
  }, 'Actual typed note did not publish in protected canonical snapshot')
  await owner.evaluate(async () => { const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts'); await workspaceApi.flushCloud() })
  const targetHead = (await db.doc(`boardScenes/${seed.id}`).get()).data()
  const targetId = targetHead.currentVersionId
  assert.ok(targetId)
  await owner.click('[aria-label="Edit board name"]')
  await owner.click('[aria-label="Edit board name"]', { clickCount: 3 }).catch(() => {})
  await owner.$eval('[aria-label="Edit board name"]', (input) => input.select())
  await owner.type('[aria-label="Edit board name"]', 'Cloud changed')
  await owner.keyboard.press('Enter')
  await wait(async () => (await db.doc(`boardScenes/${seed.id}`).get()).data()?.boardName === 'Cloud changed', 'UI rename did not publish canonical name')
  if (!(await owner.$('.slides-panel'))) await owner.click('.slides-toggle')
  await owner.waitForSelector('.slide-properties')
  if (!(await owner.$('#slide-notes-input'))) await owner.$eval('.slide-properties', (element) => [...element.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Notes')?.click())
  await owner.waitForSelector('#slide-notes-input:not([disabled])')
  await owner.$eval('#slide-notes-input', (input) => input.select())
  await owner.type('#slide-notes-input', 'Canonical later note')
  await wait(async () => {
    const head = (await db.doc(`boardScenes/${seed.id}`).get()).data()
    const notes = head?.notesRevisionId ? await loadNoteSnapshot(seed.id, head.notesRevisionId) : null
    return JSON.stringify(notes ?? {}).includes('Canonical later note')
  }, 'Later note did not publish')
  await guest.goto(`${base}/boards/${seed.id}`)
  await guest.waitForSelector('[data-testid="board-history-open"]:not(:disabled)')
  await wait(async () => await owner.evaluate(() => window.__lazyCollab?.isLazyCollabActive), 'Two editor lobby sessions did not enable collaboration')
  const joinedHead = (await db.doc(`boardScenes/${seed.id}`).get()).data()
  await wait(async () => Object.keys((await rtdb.ref(`presence/${seed.id}/generations/${joinedHead.generation}`).get()).val() ?? {}).length >= 2, 'Both editors did not publish generation-scoped presence')
  const presence = (await rtdb.ref(`presence/${seed.id}/generations/${joinedHead.generation}`).get()).val()
  assert.ok(Object.values(presence).every((record) => record.generation === joinedHead.generation && record.restoreFence === joinedHead.restoreFence), 'Presence carries actual generation and fence')
  // Real pointer drawing broadcasts a semantic delta, then the other editor renders it.
  await guest.keyboard.press('r')
  await guest.mouse.move(700, 500)
  await guest.mouse.down()
  await guest.mouse.move(800, 580, { steps: 5 })
  await guest.mouse.up()
  await wait(async () => Object.keys((await rtdb.ref(`boards/${seed.id}/generations/${joinedHead.generation}/elements`).get()).val() ?? {}).length > 0, 'Actual canvas delta did not reach RTDB generation room')
  await wait(async () => {
    const [a, b] = await Promise.all([owner, guest].map((page) => page.evaluate(() => window.__excalidrawAPI.getSceneElements().filter((element) => !element.isDeleted).map((element) => element.id).sort())))
    return b.length > 2 && JSON.stringify(a) === JSON.stringify(b)
  }, 'Actual drawing did not converge between owner and guest')
  await owner.evaluate(async () => { const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts'); await workspaceApi.flushCloud() })
  const before = (await db.doc(`boardScenes/${seed.id}`).get()).data()
  const policyBefore = (await db.doc(`boardShares/${seed.id}`).get()).data()
  await owner.click('[data-testid="board-history-open"]')
  await owner.waitForSelector(`[data-version-id="${targetId}"]`)
  await owner.waitForFunction(() => document.querySelector('[data-testid="history-preview-name"]')?.textContent === 'Cloud changed')
  const selectedLatestId = await owner.$eval('.history-entry[aria-pressed="true"]', (row) => row.dataset.versionId)
  const previewReadCount = () => calls.filter((call) => call.peer === 'owner' && call.endpoint === 'boardHistory' && call.data.boardId === seed.id && ['manifest', 'chunks'].includes(call.data.operation)).length
  const latestReadCount = previewReadCount()
  assert.ok(latestReadCount > 0, 'Opening cloud history loads the latest version preview')
  await owner.click(`[data-version-id="${selectedLatestId}"]`)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(previewReadCount(), latestReadCount, 'Selecting the already-loaded version reuses its preview without Firebase reads')
  await owner.click('[aria-label="Close board history"]')
  await owner.waitForSelector('[data-testid="board-history-dialog"]', { hidden: true })
  await owner.click('[data-testid="board-history-open"]')
  await owner.waitForFunction(() => document.querySelector('[data-testid="history-preview-name"]')?.textContent === 'Cloud changed')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(previewReadCount(), latestReadCount, 'Reopening history reuses the same board version preview cache')
  const offset = calls.length
  const previewNetwork = await owner.createCDPSession()
  await previewNetwork.send('Network.enable')
  await previewNetwork.send('Network.emulateNetworkConditions', { offline: false, latency: 800,
    downloadThroughput: 500_000, uploadThroughput: 250_000, connectionType: 'cellular3g' })
  await owner.click(`[data-version-id="${targetId}"]`)
  await owner.waitForSelector('.history-preview-loading')
  const spinnerPosition = await owner.$eval('.history-preview-loading', (loader) => {
    const container = loader.getBoundingClientRect(), spinner = loader.querySelector('svg').getBoundingClientRect()
    return { centered: Math.abs((container.left + container.width / 2) - (spinner.left + spinner.width / 2)) < 2 &&
      Math.abs((container.top + container.height / 2) - (spinner.top + spinner.height / 2)) < 2,
      hasLoadingText: /Loading version/.test(loader.textContent) }
  })
  assert.equal(spinnerPosition.centered, true, 'Preview loading spinner is centered in the preview area')
  assert.equal(spinnerPosition.hasLoadingText, false, 'Preview loader uses an icon instead of text')
  await previewNetwork.send('Network.emulateNetworkConditions', { offline: false, latency: 0,
    downloadThroughput: -1, uploadThroughput: -1, connectionType: 'none' })
  await owner.waitForFunction(() => document.querySelector('[data-testid="history-preview-notes"]')?.textContent.includes('Canonical original speaker note'))
  await previewNetwork.detach()
  assert.equal(calls.slice(offset).filter((call) => ['restoreBoardVersion', 'commitBoardScene', 'updateBoardContent'].includes(call.endpoint)).length, 0, 'Historical preview generated content writes')
  await owner.click('[data-testid="history-restore"]')
  if (await owner.$('[data-testid="history-data-loss-confirmation"]')) await owner.click('[data-testid="history-confirm-restore"]')
  await wait(async () => (await db.doc(`boardScenes/${seed.id}`).get()).data()?.generation === before.generation + 1, 'Restore did not publish exactly next generation')
  for (const page of [owner, guest]) await page.waitForFunction(() => window.__historyProgressSeen && !document.querySelector('[data-testid="history-restoration-progress"]'))
  const after = (await db.doc(`boardScenes/${seed.id}`).get()).data()
  assert.equal(after.boardName, 'Cloud original')
  assert.equal(after.generation, before.generation + 1)
  assert.equal(after.restoreOperationId, null)
  const notes = await loadNoteSnapshot(seed.id, after.notesRevisionId)
  assert.ok(JSON.stringify(notes).includes('Canonical original speaker note'))
  const policyAfter = (await db.doc(`boardShares/${seed.id}`).get()).data()
  assert.equal(policyAfter.generalAccess, policyBefore.generalAccess)
  assert.equal(policyAfter.generalRole, policyBefore.generalRole)
  const staleWrite = await guest.evaluate(async ({ id, generation, fence }) => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const auth = getFirebaseAuth()
    const token = await auth.currentUser.getIdToken()
    const response = await fetch(`http://127.0.0.1:49000/boards/${id}/generations/${generation}/elements/stale-probe.json?ns=demo-regression&auth=${token}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'stale-probe', generation, restoreFence: fence, lastModifiedBy: auth.currentUser.uid, updatedAt: Date.now(), version: 1, versionNonce: 1, data: JSON.stringify({ id: 'stale-probe', type: 'rectangle', version: 1 }) }) })
    return response.status
  }, { id: seed.id, generation: before.generation, fence: before.restoreFence })
  assert.equal(staleWrite, 401, 'Old-generation authenticated RTDB mutation is denied after restore')
  const operations = await db.collection(`boardScenes/${seed.id}/restoreOperations`).get()
  assert.equal(operations.size, 1)
  assert.equal(operations.docs[0].data().state, 'completed')
  for (const page of [owner, guest]) assert.ok(await page.evaluate(() => window.__excalidrawAPI.getSceneElements().some((element) => element.id === 'cloud-original')))
  assert.ok(calls.some((call) => call.endpoint === 'slideNotes' && call.data?.operation === 'write' && Number.isInteger(call.data?.generation) && Number.isInteger(call.data?.expectedFence)), 'Actual note UI sent fenced write wire fields')
  // Public viewers observe the replacement through current-only gateways and keep their role.
  const viewerBoard = await owner.evaluate(async () => {
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
    const { projectCall } = await import('/src/features/sharing/project-service.ts')
    const { getFirebaseAuth, getFirestoreDb } = await import('/src/lib/firebase.ts')
    const { getDocFromServer, doc } = await import('/tests/history-fixture.ts')
    const { convertToExcalidrawElements } = await import('/tests/history-fixture.ts')
    const project = await workspaceApi.createProject('Viewer restore UI')
    const document = await workspaceApi.createBoard(project.id, 'Viewer original')
    const elements = convertToExcalidrawElements([{ type: 'rectangle', id: 'viewer-original', x: 30, y: 30, width: 100, height: 80 }], { regenerateIds: false })
    const scene = { elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} }
    await workspaceApi.saveBoard({ ...document, scene }); await workspaceApi.flushCloud()
    const policy = await sharingService.getShareConfig(document.id, { ownerId: getFirebaseAuth().currentUser.uid, boardName: document.name, scene })
    await sharingService.saveShareConfig({ ...policy, generalAccess: 'anyone_with_link', generalRole: 'viewer', scene })
    const head = (await getDocFromServer(doc(getFirestoreDb(), 'boardScenes', document.id))).data()
    await projectCall('slideNotes', { operation: 'write', boardId: document.id, projectId: project.id, slideId: 'viewer-hidden-slide', text: 'Protected editor note', revision: 0, mutationId: crypto.randomUUID(), generation: head.generation, expectedFence: head.restoreFence })
    const target = (await getDocFromServer(doc(getFirestoreDb(), 'boardScenes', document.id))).data().currentVersionId
    const current = await workspaceApi.loadBoard(document.id)
    const later = convertToExcalidrawElements([{ type: 'rectangle', id: 'viewer-later', x: 200, y: 200, width: 80, height: 60 }], { regenerateIds: false })
    await workspaceApi.saveBoard({ ...current, scene: { ...current.scene, elements: [...current.scene.elements, ...later] } }); await workspaceApi.flushCloud()
    return { id: document.id, target }
  })
  await owner.goto(`${base}/boards/${viewerBoard.id}`)
  await owner.waitForSelector('[data-testid="board-history-open"]:not(:disabled)')
  await viewer.goto(`${base}/boards/${viewerBoard.id}`)
  await viewer.waitForFunction(() => !!window.__excalidrawAPI && window.__excalidrawAPI.getSceneElements().some((element) => element.id === 'viewer-later'))
  assert.equal(await viewer.$('[data-testid="board-history-open"]'), null, 'Viewer has no history action')
  assert.equal(await viewer.evaluate(() => window.__excalidrawAPI.getAppState().viewModeEnabled), true)
  await owner.click('[data-testid="board-history-open"]')
  await owner.waitForSelector(`[data-version-id="${viewerBoard.target}"]`)
  await owner.click(`[data-version-id="${viewerBoard.target}"]`)
  await owner.waitForFunction(() => !document.querySelector('[data-testid="history-restore"]')?.disabled)
  await owner.click('[data-testid="history-restore"]')
  await owner.waitForFunction(() => !!document.querySelector('[data-testid="history-data-loss-confirmation"]') || !!document.querySelector('[data-testid="history-restoration-progress"]'))
  if (await owner.$('[data-testid="history-data-loss-confirmation"]')) await owner.click('[data-testid="history-confirm-restore"]')
  await viewer.waitForFunction(() => window.__historyProgressSeen && !document.querySelector('[data-testid="history-restoration-progress"]') && window.__excalidrawAPI.getSceneElements().filter((element) => !element.isDeleted).every((element) => element.id === 'viewer-original'))
  assert.equal(await viewer.evaluate(() => window.__excalidrawAPI.getAppState().viewModeEnabled), true, 'Restore keeps viewer readonly')
  assert.equal(await viewer.$('[data-testid="board-history-open"]'), null)
  assert.ok(!calls.some((call) => call.peer === 'viewer' && (call.endpoint === 'slideNotes' || call.endpoint === 'boardHistory' && ['notes', 'list', 'restore-status'].includes(call.data.operation))), 'Viewer makes no protected-note/history requests')
  const viewerIds = await viewer.evaluate(() => window.__excalidrawAPI.getSceneElements().map((element) => element.id))
  await viewer.mouse.click(600, 700); await viewer.keyboard.press('r')
  await viewer.mouse.move(600, 500); await viewer.mouse.down(); await viewer.mouse.move(700, 580, { steps: 3 }); await viewer.mouse.up()
  assert.deepEqual(await viewer.evaluate(() => window.__excalidrawAPI.getSceneElements().map((element) => element.id)), viewerIds, 'Pointer/keyboard attempt cannot mutate restored viewer canvas')
  assert.ok(!calls.some((call) => call.peer === 'viewer' && ['commitBoardScene', 'importBoardVersion', 'restoreBoardVersion', 'updateBoardContent'].includes(call.endpoint)))
  console.log('PASS Viewer replacement hydration uses current-only scene gateway, skips protected notes/history and remains readonly')
  assert.deepEqual(errors, [])
  console.log('PASS Cloud history real note/rename/preview/restore, guest editor progress, durable complete tuple and sharing')
} finally {
  const bounded = async (promise, timeoutMs, fallback) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs))])
  const diagnostics = await Promise.all([owner, guest, viewer].map(async (page) =>
    bounded(
      page.evaluate(() => ({ text: document.body.innerText, collab: window.__lazyCollab, progressSeen: window.__historyProgressSeen })).catch(() => null),
      3000,
      { unavailable: 'page did not answer diagnostics within 3s' },
    ),
  ))
  await writeFile(`${artifacts}/board-history-cloud-ui-network.json`, JSON.stringify({ calls, errors, diagnostics }, null, 2))
  // A restored page can keep Firebase listeners alive while its renderer is
  // shutting down. Browser.close() owns all three isolated contexts; bound it
  // so a successful scenario does not get reclassified as a five-minute test
  // timeout by lingering renderer teardown.
  const closed = await bounded(browser.close().then(() => true, () => false), 10000, false)
  if (!closed) browser.process()?.kill('SIGKILL')
  await bounded(deleteApp(app).catch(() => undefined), 5000, undefined)
}
