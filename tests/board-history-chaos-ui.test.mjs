/** Network failures are injected only in disposable demo emulators; assertions use UI + canonical oracles. */
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Requires disposable history chaos emulators')
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { getDatabase } = require('firebase-admin/database')
const app = initializeApp({ projectId: 'demo-regression', databaseURL: 'https://demo-regression.firebaseio.com' })
const db = getFirestore(app), rtdb = getDatabase(app)
const { loadNoteSnapshot } = await import('../functions/lib/board-history-notes.js')
const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190'
const artifacts = process.env.E2E_ARTIFACT_DIR || '.system_generated/regression'
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const calls = [], failures = [], checks = [], contexts = []
const wait = async (predicate, label, timeout = 90000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 100)) }
  throw new Error(label)
}
// Drain already-dispatched callbacks before disabling Fetch; late protocol errors stay test failures.
async function interceptFetch(cdp, pattern, handle) {
  const pending = new Set(), errors = []
  const listener = (event) => {
    const task = Promise.resolve().then(() => handle(event))
    pending.add(task)
    task.then(() => pending.delete(task), (error) => { pending.delete(task); errors.push(error) })
  }
  cdp.on('Fetch.requestPaused', listener)
  await cdp.send('Fetch.enable', { patterns: [pattern] })
  return async () => {
    cdp.off('Fetch.requestPaused', listener)
    await Promise.all([...pending])
    await cdp.send('Fetch.disable')
    assert.deepEqual(errors, [], 'Network fault callbacks completed without protocol errors')
  }
}
async function tab(name) {
  const context = await browser.createBrowserContext()
  contexts.push(context)
  const page = await context.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  page.setDefaultTimeout(90000)
  page.on('dialog', (dialog) => dialog.accept())
  page.on('pageerror', (error) => failures.push({ peer: name, error: error.message }))
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().includes(':45001/')) return
    try { calls.push({ peer: name, endpoint: request.url().split('/').pop(), data: JSON.parse(request.postData() || '{}').data, at: Date.now() }) } catch { /* not callable */ }
  })
  page.on('requestfailed', (request) => failures.push({ peer: name, url: request.url(), failure: request.failure()?.errorText }))
  await page.goto(base)
  return page
}
async function seed(owner, name) {
  return owner.evaluate(async (name) => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner } = await import('/tests/regression-fixture.ts')
    const { user } = await signInOwner(getFirebaseAuth())
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
    const { convertToExcalidrawElements } = await import('/tests/history-fixture.ts')
    const project = await workspaceApi.createProject(name)
    const board = await workspaceApi.createBoard(project.id, name)
    const elements = convertToExcalidrawElements([
      { type: 'rectangle', id: 'seed-shape', x: 80, y: 80, width: 120, height: 80 },
      { type: 'frame', id: 'seed-slide', children: ['seed-shape'], x: 50, y: 50, width: 400, height: 300, name: 'Chaos slide', customData: { agenticWhiteboard: { slide: { schemaVersion: 1, orderKey: '0/1' } } } },
    ], { regenerateIds: false })
    const scene = { elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} }
    await workspaceApi.saveBoard({ ...board, scene })
    await workspaceApi.flushCloud()
    const config = await sharingService.getShareConfig(board.id, { ownerId: user.uid, boardName: name, scene })
    await sharingService.saveShareConfig({ ...config, generalAccess: 'anyone_with_link', generalRole: 'editor', scene })
    return { id: board.id, projectId: project.id }
  }, name)
}
async function open(page, id) {
  await page.goto(`${base}/boards/${id}`)
  await page.waitForSelector('[data-testid="board-history-open"]:not(:disabled)')
  await page.waitForFunction(() => !!window.__excalidrawAPI)
}
async function draw(page, x = 750) {
  await page.mouse.click(600, 700)
  await page.keyboard.press('r')
  await page.mouse.move(x, 480)
  await page.mouse.down()
  await page.mouse.move(x + 95, 560, { steps: 4 })
  await page.mouse.up()
}
async function contentIds(page) { return page.evaluate(() => window.__excalidrawAPI.getSceneElements().filter((element) => !element.isDeleted).map((element) => element.id).sort()) }
async function ledger(page, id) {
  return page.evaluate(async (id) => {
    const { boardHistoryStore } = await import('/tests/history-fixture.ts')
    const { readSharedSceneDraft } = await import('/src/features/sharing/shared-scene-drafts.ts')
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    return { current: await boardHistoryStore.getCommittedContent(id), outbox: await boardHistoryStore.listOutbox(id), draft: await readSharedSceneDraft(id, getFirebaseAuth().currentUser.uid) }
  }, id)
}
async function beginRestore(page, target) {
  await page.click('[data-testid="board-history-open"]')
  await page.waitForSelector(`[data-version-id="${target}"]`)
  await page.click(`[data-version-id="${target}"]`)
  await page.waitForSelector('[data-testid="history-preview-name"]')
  await page.waitForFunction(() => !document.querySelector('[data-testid="history-restore"]')?.disabled)
  await page.click('[data-testid="history-restore"]')
  await page.waitForFunction(() => !!document.querySelector('[data-testid="history-data-loss-confirmation"]') || !!document.querySelector('[data-testid="history-restoration-progress"]'))
  if (await page.$('[data-testid="history-data-loss-confirmation"]')) await page.click('[data-testid="history-confirm-restore"]')
}
async function complete(page) { await page.waitForFunction(() => !document.querySelector('[data-testid="history-restoration-progress"]') && !document.querySelector('[data-testid="board-history-dialog"]')) }
async function notes(page) {
  if (!(await page.$('.slides-panel'))) await page.click('.slides-toggle')
  await page.waitForSelector('.slide-properties')
  if (!(await page.$('#slide-notes-input'))) await page.$eval('.slide-properties', (element) => [...element.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Notes')?.click())
  await page.waitForSelector('#slide-notes-input:not([disabled])')
}
try {
  if (process.env.E2E_HISTORY_CHAOS_CASE !== 'failure') {
  // C02/E02: a guest has a durably captured local save, but its content calls are held.
  // C10: the initiating editor then receives a slow replacement while a ready peer resumes.
  const owner = await tab('held-owner'), guest = await tab('held-guest')
  const board = await seed(owner, 'Held peer chaos')
  const target = (await db.doc(`boardScenes/${board.id}`).get()).data().currentVersionId
  await open(owner, board.id); await open(guest, board.id)
  await draw(owner, 900)
  await wait(async () => (await db.doc(`boardScenes/${board.id}`).get()).data().currentVersionId !== target, 'Held fixture needs an older restore target')
  await wait(async () => Object.keys((await rtdb.ref(`presence/${board.id}/generations/1`).get()).val() ?? {}).length >= 2, 'Held case: peer generation presence unavailable')
  const heldWrites = []
  await guest.setRequestInterception(true)
  const holdGuest = (request) => {
    const endpoint = request.url().split('/').pop()
    if (request.method() === 'POST' && request.url().includes(':45001/') && ['commitBoardScene', 'updateBoardContent', 'importBoardVersion'].includes(endpoint)) heldWrites.push(request)
    else void request.continue()
  }
  guest.on('request', holdGuest)
  await draw(guest)
  await wait(async () => (await ledger(guest, board.id)).outbox.length > 0 && heldWrites.length > 0, 'Guest logical save was not captured and held before cloud acknowledgement')
  const unsynced = await ledger(guest, board.id)
  assert.ok(unsynced.outbox.some((entry) => entry.generation === 1))
  const ownerCdp = await owner.createCDPSession()
  const heldReads = []
  let holdHydration = false
  const stopOwnerFetch = await interceptFetch(ownerCdp, { urlPattern: '*45001*boardHistory', requestStage: 'Response' }, async (event) => {
    const operation = JSON.parse(event.request.postData || '{}').data?.operation
    if (holdHydration && operation === 'chunks') heldReads.push(event.requestId)
    else await ownerCdp.send('Fetch.continueRequest', { requestId: event.requestId })
  })
  // Open preview before arming replacement delay, so history is not artificially held.
  await owner.click('[data-testid="board-history-open"]')
  await owner.waitForSelector(`[data-version-id="${target}"]`)
  await owner.click(`[data-version-id="${target}"]`)
  await owner.waitForSelector('[data-testid="history-preview-name"]')
  holdHydration = true
  await owner.click('[data-testid="history-restore"]')
  await owner.waitForFunction(() => !!document.querySelector('[data-testid="history-data-loss-confirmation"]') || !!document.querySelector('[data-testid="history-restoration-progress"]'))
  if (await owner.$('[data-testid="history-data-loss-confirmation"]')) await owner.click('[data-testid="history-confirm-restore"]')
  await wait(async () => (await db.doc(`boardScenes/${board.id}`).get()).data().generation === 2 && heldReads.length > 0, 'Restore did not publish before held hydration')
  await guest.waitForFunction(() => !document.querySelector('[data-testid="history-restoration-progress"]') && window.__excalidrawAPI.getSceneElements().length === 2)
  assert.ok(await owner.$('[data-testid="history-restoration-progress"]'), 'Slow editor must remain blocked until complete replacement hydration')
  const blockedIds = await contentIds(owner)
  await owner.keyboard.press('Escape'); await owner.keyboard.press('Delete')
  await owner.keyboard.down('Meta'); await owner.keyboard.press('z'); await owner.keyboard.up('Meta')
  assert.ok(await owner.$('[data-testid="history-restoration-progress"]'), 'Escape does not dismiss a blocking restore')
  assert.deepEqual(await contentIds(owner), blockedIds, 'Keyboard edits/undo cannot mutate a blocked editor')
  const guestAfter = await ledger(guest, board.id)
  assert.equal(guestAfter.outbox.length, 0, 'Successful restore discards unsynced guest history')
  assert.equal(guestAfter.draft, undefined, 'Successful restore discards the old shared recovery journal')
  assert.equal(guestAfter.current.document.cloudGeneration, 2)
  // Deliver the original request after publication. Its original generation remains fenced.
  guest.off('request', holdGuest)
  for (const request of heldWrites) if (!request.isInterceptResolutionHandled()) await request.continue()
  await guest.setRequestInterception(false)
  holdHydration = false
  for (const requestId of heldReads) await ownerCdp.send('Fetch.continueRequest', { requestId })
  await complete(owner)
  await stopOwnerFetch(); await ownerCdp.detach()
  assert.deepEqual(await contentIds(owner), ['seed-shape', 'seed-slide'])
  assert.deepEqual(await contentIds(guest), ['seed-shape', 'seed-slide'])
  assert.equal((await db.doc(`boardScenes/${board.id}`).get()).data().generation, 2)
  checks.push('Held unsynced guest save discarded; late request fenced; slow hydration blocks only unready editor; Escape/Delete/Undo blocked')
  console.log('PASS ' + checks.at(-1))

  // C06/C09: a guest misses an entire restore offline and makes scene + notes saves.
  const offlineOwner = await tab('offline-owner'), offlineGuest = await tab('offline-guest')
  const offline = await seed(offlineOwner, 'Offline peer chaos')
  const offlineTarget = (await db.doc(`boardScenes/${offline.id}`).get()).data().currentVersionId
  await open(offlineOwner, offline.id); await open(offlineGuest, offline.id)
  await draw(offlineOwner, 900)
  await wait(async () => (await db.doc(`boardScenes/${offline.id}`).get()).data().currentVersionId !== offlineTarget, 'Offline fixture needs an older restore target')
  await notes(offlineGuest)
  await offlineGuest.evaluate(async () => {
    const { getFirestoreDb, getFirebaseRtdb } = await import('/src/lib/firebase.ts')
    const { disableNetwork, goOffline } = await import('/tests/history-fixture.ts')
    await disableNetwork(getFirestoreDb())
    goOffline(getFirebaseRtdb())
  })
  await offlineGuest.setOfflineMode(true)
  await offlineGuest.type('#slide-notes-input', 'Unsynced offline note must be discarded')
  await draw(offlineGuest, 760)
  await wait(async () => (await ledger(offlineGuest, offline.id)).outbox.length >= 1, 'Offline native saves were not captured')
  await beginRestore(offlineOwner, offlineTarget)
  await complete(offlineOwner)
  assert.equal((await db.doc(`boardScenes/${offline.id}`).get()).data().generation, 2)
  // Continue editing while unaware of the replacement; none of this work may replay into G2.
  await draw(offlineGuest, 950)
  const offlineCaptured = await ledger(offlineGuest, offline.id)
  assert.equal(offlineCaptured.current.document.cloudGeneration, 1)
  await offlineGuest.setOfflineMode(false)
  const slow = await offlineGuest.createCDPSession()
  await slow.send('Network.enable')
  await slow.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 64 * 1024, uploadThroughput: 32 * 1024 })
  await offlineGuest.evaluate(async () => {
    const { getFirestoreDb, getFirebaseRtdb } = await import('/src/lib/firebase.ts')
    const { enableNetwork, goOnline } = await import('/tests/history-fixture.ts')
    await enableNetwork(getFirestoreDb())
    goOnline(getFirebaseRtdb())
  })
  await wait(async () => (await ledger(offlineGuest, offline.id)).current?.document.cloudGeneration === 2 && !(await offlineGuest.$('[data-testid="history-restoration-progress"]')), 'Offline peer did not adopt the latest restored generation')
  const rejoined = await ledger(offlineGuest, offline.id)
  assert.equal(rejoined.outbox.length, 0)
  assert.equal(rejoined.draft, undefined)
  assert.deepEqual(await contentIds(offlineGuest), ['seed-shape', 'seed-slide'])
  assert.equal(rejoined.current.notes['seed-slide'] ?? '', '')
  const cloudNotes = await loadNoteSnapshot(offline.id, (await db.doc(`boardScenes/${offline.id}`).get()).data().notesRevisionId)
  assert.ok(!JSON.stringify(cloudNotes).includes('Unsynced offline note'))
  await slow.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await slow.detach()
  checks.push('Offline peer misses restore, continues scene/notes edits, then under slow reconnect discards old outbox/drafts and adopts G2')
  console.log('PASS ' + checks.at(-1))

  // E04: intercept at RESPONSE stage, proving server publication occurred before reply loss.
  const lost = await tab('lost-reply-owner')
  const lostBoard = await seed(lost, 'Lost response chaos')
  const oldTarget = (await db.doc(`boardScenes/${lostBoard.id}`).get()).data().currentVersionId
  await open(lost, lostBoard.id)
  await draw(lost)
  await wait(async () => (await db.doc(`boardScenes/${lostBoard.id}`).get()).data().currentVersionId !== oldTarget, 'Lost-response fixture did not create a later canonical state')
  const lostCdp = await lost.createCDPSession()
  let committedBeforeDrop = false
  const stopLostFetch = await interceptFetch(lostCdp, { urlPattern: '*45001*restoreBoardVersion', requestStage: 'Response' }, async (event) => {
    if (event.request.method !== 'POST') { await lostCdp.send('Fetch.continueRequest', { requestId: event.requestId }); return }
    const request = JSON.parse(event.request.postData || '{}').data
    const operation = (await db.doc(`boardScenes/${lostBoard.id}/restoreOperations/${request.operationId}`).get()).data()
    committedBeforeDrop = event.responseStatusCode === 200 && operation?.state === 'completed'
    await lostCdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'ConnectionFailed' })
  })
  await beginRestore(lost, oldTarget)
  await complete(lost)
  assert.equal(committedBeforeDrop, true, 'Response was dropped only after a committed successful restore')
  assert.equal((await db.doc(`boardScenes/${lostBoard.id}`).get()).data().generation, 2)
  const lostOperations = await db.collection(`boardScenes/${lostBoard.id}/restoreOperations`).get()
  assert.equal(lostOperations.size, 1)
  assert.equal(lostOperations.docs[0].data().state, 'completed')
  assert.ok(calls.some((call) => call.peer === 'lost-reply-owner' && call.endpoint === 'boardHistory' && call.data.operation === 'restore-status'))
  assert.deepEqual(await contentIds(lost), ['seed-shape', 'seed-slide'])
  assert.equal(await lost.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('board-history-restore:v1:')).length), 0)
  await stopLostFetch(); await lostCdp.detach()
  checks.push('Restore reply lost after durable publication; original operation recovered by status, exactly one branch/generation, no pending identity')
  console.log('PASS ' + checks.at(-1))

  }
  // A failed publication must release both transports and retain every pending local tuple.
  const failedOwner = await tab('failed-owner'), failedGuest = await tab('failed-guest')
  const failedBoard = await seed(failedOwner, 'Pre-publication failure chaos')
  console.log('Failure fixture seeded')
  const failureTarget = (await db.doc(`boardScenes/${failedBoard.id}`).get()).data().currentVersionId
  await open(failedOwner, failedBoard.id); await open(failedGuest, failedBoard.id)
  console.log('Failure editors opened')
  await draw(failedOwner, 900)
  await wait(async () => (await db.doc(`boardScenes/${failedBoard.id}`).get()).data().currentVersionId !== failureTarget, 'Failed restore fixture needs older target')
  console.log('Failure target older; opening notes')
  await notes(failedGuest)
  const pendingWrites = []
  await failedGuest.setRequestInterception(true)
  const holdPending = (request) => {
    const endpoint = request.url().split('/').pop()
    let data
    try { data = JSON.parse(request.postData() || '{}').data } catch { /* Not a callable body. */ }
    if (request.method() === 'POST' && request.url().includes(':45001/') &&
        (['commitBoardScene', 'updateBoardContent', 'importBoardVersion'].includes(endpoint) || endpoint === 'slideNotes' && data?.operation === 'write')) pendingWrites.push(request)
    else void request.continue()
  }
  failedGuest.on('request', holdPending)
  await failedGuest.type('#slide-notes-input', 'Draft survives failed restoration')
  await wait(async () => (await ledger(failedGuest, failedBoard.id)).current?.notes['seed-slide'] === 'Draft survives failed restoration', 'Pending note was not durably captured before scene mutation')
  await draw(failedGuest, 700)
  await wait(async () => {
    const pending = await ledger(failedGuest, failedBoard.id)
    return pending.outbox.length > 0 && pending.current.notes['seed-slide'] === 'Draft survives failed restoration' && pendingWrites.length > 0
  }, 'Dirty scene and note tuples not captured before failing restore')
  const beforeFailure = await ledger(failedGuest, failedBoard.id)
  console.log('Failure dirty tuples captured')
  const pendingIds = beforeFailure.outbox.map((entry) => entry.localVersionId)
  const beforeHead = (await db.doc(`boardScenes/${failedBoard.id}`).get()).data()
  await failedOwner.click('[data-testid="board-history-open"]')
  await failedOwner.waitForSelector(`[data-version-id="${failureTarget}"]`)
  await failedOwner.click(`[data-version-id="${failureTarget}"]`)
  await failedOwner.waitForFunction(() => !document.querySelector('[data-testid="history-restore"]')?.disabled)
  const targetDocument = (await db.doc(`boardScenes/${failedBoard.id}/versions/${failureTarget}`).get()).data()
  const targetPages = await db.collection(`boardScenes/${failedBoard.id}/revisions/${targetDocument.sceneRevisionId}/pages`).get()
  const brokenPage = targetPages.docs[0], backupPage = brokenPage.data()
  await brokenPage.ref.delete()
  try {
    await failedOwner.click('[data-testid="history-restore"]')
    await failedOwner.waitForFunction(() => !!document.querySelector('[data-testid="history-data-loss-confirmation"]') || !!document.querySelector('[data-testid="history-restoration-progress"]'))
    if (await failedOwner.$('[data-testid="history-data-loss-confirmation"]')) await failedOwner.click('[data-testid="history-confirm-restore"]')
    await wait(async () => {
      const operations = await db.collection(`boardScenes/${failedBoard.id}/restoreOperations`).get()
      return operations.docs.some((operation) => operation.data().state === 'failed')
    }, 'Corrupted target did not cause a durable pre-publication failure')
    const failedHead = (await db.doc(`boardScenes/${failedBoard.id}`).get()).data()
    assert.equal(failedHead.generation, beforeHead.generation)
    assert.equal(failedHead.restoreFence, beforeHead.restoreFence + 1)
    assert.equal(failedHead.restoreOperationId, null)
    const failedRoom = (await rtdb.ref(`boards/${failedBoard.id}`).get()).val()
    assert.equal(failedRoom.restoreOperationId ?? null, null)
    assert.equal(failedRoom.restoreFence, failedHead.restoreFence)
    await Promise.all([failedOwner, failedGuest].map((page) => page.waitForFunction(() => !document.querySelector('[data-testid="history-restoration-progress"]'))))
    const retained = await ledger(failedGuest, failedBoard.id)
    assert.equal(retained.current.document.cloudGeneration, beforeHead.generation)
    assert.equal(retained.current.notes['seed-slide'], 'Draft survives failed restoration')
    assert.ok(pendingIds.every((id) => retained.outbox.some((entry) => entry.localVersionId === id)), 'Failed restore retains every pending historical capture')
    assert.ok((await contentIds(failedGuest)).length > 2, 'Pending scene is retained rather than replaced with target')
    await failedOwner.click('[aria-label="Close board history"]')
    const ownerIds = await contentIds(failedOwner)
    const ownerDiagnostic = async () => failedOwner.evaluate(async (id) => { const { historyEditingState } = await import('/src/features/history/history-editing-gate.ts'); const api = window.__excalidrawAPI; const state = api.getAppState(); return { gate: historyEditingState(id), ids: api.getSceneElements().map((element) => element.id), appState: { activeTool: state.activeTool, viewModeEnabled: state.viewModeEnabled, selectedElementIds: state.selectedElementIds, editingTextElement: state.editingTextElement }, activeElement: document.activeElement?.outerHTML?.slice(0, 500), focusTarget: document.elementFromPoint(600, 700)?.outerHTML?.slice(0, 500), drawTarget: document.elementFromPoint(500, 480)?.outerHTML?.slice(0, 500), collab: window.__lazyCollab, text: document.body.innerText.slice(-1000) } }, failedBoard.id)
    console.log('Failure owner before draw ' + JSON.stringify(await ownerDiagnostic()))
    assert.equal(await failedOwner.evaluate(() => window.__excalidrawAPI.getAppState().viewModeEnabled), false, 'Initiator canvas editing gate is released')
    await failedOwner.bringToFront()
    await failedOwner.click('[data-testid="toolbar-rectangle"]')
    await failedOwner.waitForFunction(() => window.__excalidrawAPI.getAppState().activeTool.type === 'rectangle')
    await failedOwner.mouse.move(500, 480); await failedOwner.mouse.down(); await failedOwner.mouse.move(595, 560, { steps: 4 }); await failedOwner.mouse.up()
    console.log('Failure owner after draw ' + JSON.stringify(await ownerDiagnostic()))
    try { await wait(async () => (await contentIds(failedOwner)).length > ownerIds.length, 'Initiator cannot edit after failed restore', 15000) } catch (error) { console.log('Failure owner delayed draw ' + JSON.stringify(await ownerDiagnostic())); await failedOwner.screenshot({ path: `${artifacts}/failed-owner-edit-state.png` }); throw error }
    await notes(failedGuest)
    assert.equal(await failedGuest.$eval('#slide-notes-input', (input) => input.disabled), false)
    // Restore the faulted historical ancestry before testing independent draft retries.
    await brokenPage.ref.set(backupPage)
    // Let the old fenced replies arrive; retries must retain capture identity and use the new fence.
    failedGuest.off('request', holdPending)
    for (const request of pendingWrites) if (!request.isInterceptResolutionHandled()) await request.continue()
    await failedGuest.setRequestInterception(false)
    await wait(async () => {
      const head = (await db.doc(`boardScenes/${failedBoard.id}`).get()).data()
      return JSON.stringify(await loadNoteSnapshot(failedBoard.id, head.notesRevisionId)).includes('Draft survives failed restoration')
    }, 'Preserved notes did not reauthorize and publish after failed fence')
    assert.equal((await db.doc(`boardScenes/${failedBoard.id}`).get()).data().generation, beforeHead.generation)
    assert.ok(calls.some((call) => call.peer === 'failed-guest' && call.data?.expectedFence === failedHead.restoreFence && ['commitBoardScene', 'importBoardVersion', 'slideNotes'].includes(call.endpoint)), 'Retry uses refreshed monotonic fence')
    checks.push('Actual pre-publication corruption fails safely: same generation/new fence, both locks released, dirty scene/notes/history retained, editors resume, old replies reauthorize')
    console.log('PASS ' + checks.at(-1))
  } finally { await brokenPage.ref.set(backupPage) }
} finally {
  await writeFile(`${artifacts}/board-history-chaos-ui.json`, JSON.stringify({ checks, calls, failures }, null, 2))
  await Promise.all(contexts.map((context) => context.close().catch(() => {})))
  await browser.close(); await db.terminate(); await deleteApp(app)
}
