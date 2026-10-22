/** Complete eligible timeline oracle, real editor actions, pagination, previews and restore lineage. */
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST || process.env.E2E_LEGACY_FUNCTIONS === 'true') throw new Error('Timeline suite requires current disposable demo emulators')
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const app = initializeApp({ projectId: 'demo-regression', databaseURL: 'https://demo-regression.firebaseio.com' }), db = getFirestore(app)
const { loadSceneManifest, loadSceneRevision } = await import('../functions/lib/board-scenes.js')
const { loadNoteSnapshot } = await import('../functions/lib/board-history-notes.js')
const { canonicalStringify } = await import('../functions/lib/scene-codec.js')
const { eligibleVersion, versionExpired } = await import('../functions/lib/board-history-model.js')
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.createBrowserContext(), page = await context.newPage()
const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190', artifacts = process.env.E2E_ARTIFACT_DIR || '.system_generated/regression'
const calls = [], responses = [], errors = [], checks = [], report = { captures: [], previews: [], timelines: [], bulkRenameCount: 55 }
const pendingResponses = new Set()
const cachedPreviewIds = new Set()
let boardId, projectId, root
await page.setViewport({ width: 1440, height: 900 }); page.setDefaultTimeout(60000)
page.on('dialog', (dialog) => dialog.accept())
page.on('pageerror', (error) => errors.push(error.message))
page.on('request', (request) => {
  if (request.method() !== 'POST' || !request.url().includes(':45001/')) return
  try { calls.push({ endpoint: request.url().split('/').pop(), data: JSON.parse(request.postData() || '{}').data }) } catch { /* non-callable request */ }
})
page.on('response', (response) => {
  const request = response.request()
  if (request.method() !== 'POST' || !request.url().includes(':45001/')) return
  const work = (async () => {
    try { const body = await response.json(); responses.push({ endpoint: request.url().split('/').pop(), request: JSON.parse(request.postData() || '{}').data, status: response.status(), result: body.result, error: body.error }) }
    catch { /* A closed page may abort a background response; assertions use completed preview responses. */ }
  })()
  pendingResponses.add(work); void work.finally(() => pendingResponses.delete(work))
})
const wait = async (predicate, message) => {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 100)) }
  throw new Error(message)
}
const head = async () => (await db.doc(root).get()).data()
const ids = (scene) => scene.elements.filter((element) => !element.isDeleted).map((element) => element.id).sort()
const hash = (value) => createHash('sha256').update(canonicalStringify(value)).digest('hex')
async function settled() {
  await page.evaluate(async (id) => {
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { syncBoardHistory } = await import('/src/features/workspace/history-sync.ts')
    const { boardHistoryStore } = await import('/tests/history-fixture.ts')
    await workspaceApi.flushCloud()
    const tuple = await boardHistoryStore.getCommittedContent(id)
    await syncBoardHistory({ boardId: id, projectId: tuple.document.projectId, assetRoot: `boards/${id}/assets` })
  }, boardId)
  await wait(async () => await page.evaluate(async (id) => {
    const { boardHistoryStore } = await import('/tests/history-fixture.ts')
    return (await boardHistoryStore.listOutbox(id)).length === 0
  }, boardId), 'All successful local captures must receive cloud receipts before comparing eligible cloud rows')
}
async function snapshot(versionId) {
  const version = (await db.doc(`${root}/versions/${versionId}`).get()).data()
  assert.ok(version, `Version ${versionId} exists`)
  const { revision, references } = await loadSceneManifest(boardId, { headRevisionId: version.sceneRevisionId, generation: version.sceneGeneration })
  const { scene } = await loadSceneRevision(boardId, { headRevisionId: version.sceneRevisionId, generation: version.sceneGeneration })
  const noteRecords = await loadNoteSnapshot(boardId, version.notesRevisionId)
  const notes = Object.fromEntries(Object.entries(noteRecords).map(([id, note]) => [id, note.text]))
  return { id: versionId, name: version.boardName, notes, scene, references, sceneRevisionId: version.sceneRevisionId, manifestDigest: revision.candidateDigest, tupleDigest: hash({ name: version.boardName, scene, notes }), serverCreatedAt: version.serverCreatedAt.toDate().toISOString(), capturedAt: version.capturedAt ?? null, branchId: version.branchId, branchSequence: version.branchSequence, origin: version.origin }
}
async function remember(label) {
  await settled()
  const value = await snapshot((await head()).currentVersionId)
  report.captures.push({ label, kind: 'real-ui-action', ...value, scene: undefined, notes: undefined })
  return value
}
async function draw(x, y) {
  await page.bringToFront()
  const before = await page.evaluate(() => window.__excalidrawAPI.getSceneElements().filter((element) => !element.isDeleted).map((element) => element.id))
  await page.click('[data-testid="toolbar-rectangle"]')
  await page.waitForFunction(() => window.__excalidrawAPI.getAppState().activeTool.type === 'rectangle')
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 105, y + 70, { steps: 6 }); await page.mouse.up()
  await wait(async () => (await page.evaluate(() => window.__excalidrawAPI.getSceneElements().filter((element) => !element.isDeleted).map((element) => element.id))).some((id) => !before.includes(id)), 'Actual toolbar/pointer gesture did not create a new rectangle')
  const newId = await page.evaluate((old) => window.__excalidrawAPI.getSceneElements().find((element) => !element.isDeleted && !old.includes(element.id))?.id, before)
  await wait(async () => ids((await loadSceneRevision(boardId, await head())).scene).includes(newId), 'Drawn rectangle did not publish a canonical chunk revision')
  return newId
}
async function note(text) {
  if (!(await page.$('.slides-panel'))) await page.click('.slides-toggle')
  await page.waitForSelector('.slide-properties')
  if (!(await page.$('#slide-notes-input'))) await page.$eval('.slide-properties', (element) => [...element.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Notes')?.click())
  await page.waitForSelector('#slide-notes-input:not([disabled])')
  await page.$eval('#slide-notes-input', (input) => input.select())
  await page.type('#slide-notes-input', text)
  await wait(async () => (await loadNoteSnapshot(boardId, (await head()).notesRevisionId))['timeline-slide']?.text === text, 'Typed note did not publish its exact protected text')
}
async function rename(text) {
  await page.click('button[aria-label="Edit board name"]')
  await page.waitForSelector('input[aria-label="Edit board name"]')
  await page.$eval('input[aria-label="Edit board name"]', (input) => input.select())
  await page.type('input[aria-label="Edit board name"]', text); await page.keyboard.press('Enter')
  await wait(async () => (await head()).boardName === text, 'Actual rename form did not publish its exact name')
}
async function eligible() {
  return page.evaluate(async (id) => {
    const { projectCall } = await import('/src/features/sharing/project-service.ts')
    const result = [], cursors = []
    let cursor
    do {
      const next = await projectCall('boardHistory', { boardId: id, operation: 'list', ...(cursor ? { cursor } : {}) })
      result.push(...next.entries); cursor = next.cursor; if (cursor) cursors.push(cursor)
    } while (cursor)
    return { entries: result, pageCount: cursors.length + 1 }
  }, boardId)
}
async function inspectTimeline(label, minimum = 0) {
  const expected = await eligible(), expectedIds = expected.entries.map((entry) => entry.versionId)
  assert.ok(expectedIds.length >= minimum)
  const currentHead = await head(), raw = await db.collection(`${root}/versions`).get(), independentlyEligible = []
  for (const document of raw.docs) {
    const version = document.data()
    if ((!versionExpired(version) || document.id === currentHead.currentVersionId) && await eligibleVersion(boardId, currentHead, version)) independentlyEligible.push(document.id)
  }
  assert.deepEqual([...expectedIds].sort(), independentlyEligible.sort(), 'Gateway includes every eligible persisted version, independently of its pagination implementation')
  assert.equal(new Set(expectedIds).size, expectedIds.length, 'Gateway has no duplicate IDs across pages')
  await page.click('[data-testid="board-history-open"]')
  await page.waitForSelector('.history-entry')
  const currentEntry = expected.entries.find((entry) => entry.versionId === currentHead.currentVersionId)
  assert.ok(currentEntry, 'The current head appears in the eligible timeline')
  await page.waitForFunction((name) => document.querySelector('[data-testid="history-preview-name"]')?.textContent === name, {}, currentEntry.boardName)
  const initiallySelectedId = await page.$eval('.history-entry[aria-pressed="true"]', (row) => row.dataset.versionId)
  assert.equal(initiallySelectedId, currentHead.currentVersionId, 'Opening history previews the latest version by default')
  cachedPreviewIds.add(initiallySelectedId)
  let pageLoads = 1
  while (true) {
    await page.waitForFunction(() => !document.querySelector('.history-list [role="status"]'))
    const more = await page.$('.history-list > button')
    if (!more) break
    assert.equal(await more.evaluate((button) => button.textContent.trim()), 'Load more versions')
    const count = await page.$$eval('.history-entry', (rows) => rows.length)
    await more.click(); pageLoads++
    await page.waitForFunction((previous) => document.querySelectorAll('.history-entry').length > previous || !!document.querySelector('.history-error'), {}, count)
    assert.equal(await page.$('.history-error'), null)
  }
  // Collapse/re-expand through actual summary controls, then prove every row is visible.
  const groups = await page.$$('[data-testid="history-date-group"]')
  for (const group of groups) {
    const summary = await group.$('.ui-accordion-trigger')
    if (await summary.evaluate((element) => element.getAttribute('aria-expanded') === 'true')) await summary.click()
    await page.waitForFunction((id) => document.getElementById(id)?.getAttribute('aria-expanded') === 'false', {}, await summary.evaluate((element) => element.id))
    await summary.click(); assert.equal(await summary.evaluate((element) => element.getAttribute('aria-expanded')), 'true')
  }
  const rows = await page.$$eval('.history-entry', (elements) => elements.map((element) => ({ id: element.dataset.versionId, timestamp: element.querySelector('time').dateTime, label: element.querySelector('time').textContent, expectedLabel: new Date(element.querySelector('time').dateTime).toLocaleString(), visible: element.getClientRects().length > 0, current: element.querySelector('small').textContent.includes('Current') })))
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'UI never duplicates a version across pages')
  assert.deepEqual(rows.map((row) => row.id), expectedIds, 'All eligible IDs render in authoritative order, with no omitted intermediate save')
  assert.ok(rows.every((row) => row.visible), 'Expanded groups retain every visible row, including offscreen scroll content')
  for (const row of rows) {
    const entry = expected.entries.find((entry) => entry.versionId === row.id)
    assert.equal(row.timestamp, entry.capturedAt ?? entry.serverCreatedAt)
    assert.equal(row.label, row.expectedLabel, 'Version labels show saved date and time')
  }
  assert.equal(rows.filter((row) => row.current).length, 1, 'Exactly one current entry is labelled')
  assert.equal(pageLoads, expected.pageCount, 'UI Load More consumed every gateway page')
  assert.deepEqual((await eligible()).entries.map((entry) => entry.versionId), expectedIds, 'Listing/expanding history creates no new versions')
  report.timelines.push({ label, count: rows.length, groups: groups.length, pageLoads, ids: expectedIds })
  return expected.entries
}
async function preview(value, current = false) {
  const liveBefore = await head(), beforeCalls = calls.length, beforeResponses = responses.length
  const wasCached = cachedPreviewIds.has(value.id)
  const liveIds = await page.evaluate(() => window.__excalidrawAPI.getSceneElements().filter((element) => !element.isDeleted).map((element) => element.id).sort())
  await page.click(`[data-version-id="${value.id}"]`)
  await page.waitForFunction((name) => document.querySelector('[data-testid="history-preview-name"]')?.textContent === name, {}, value.name)
  await page.waitForSelector('[data-testid="history-preview-canvas"] canvas')
  await page.waitForFunction((text) => document.querySelector('[data-testid="history-preview-notes"]')?.textContent.includes(text), {}, value.notes['timeline-slide'] || 'No speaker notes')
  assert.equal(await page.$eval('[data-testid="history-restore"]', (button) => button.disabled), current, 'Current preview cannot be restored; older eligible previews can')
  await Promise.all([...pendingResponses])
  const read = responses.slice(beforeResponses)
  const manifestResponse = responses.find((entry) => entry.endpoint === 'boardHistory' && entry.request.operation === 'manifest' && entry.request.versionId === value.id)
  const manifest = manifestResponse?.result
  assert.ok(manifest, 'The selected version has a fixed actor-bound manifest, fetched initially or retained in cache')
  const selectedManifestRequests = read.filter((entry) => entry.endpoint === 'boardHistory' && entry.request.operation === 'manifest' && entry.request.versionId === value.id)
  assert.equal(selectedManifestRequests.length, wasCached ? 0 : 1, wasCached ? 'A cached version preview does not refetch its manifest' : 'A first preview fetches its manifest exactly once')
  cachedPreviewIds.add(value.id)
  assert.equal(manifest.revisionId, value.sceneRevisionId)
  assert.equal(manifest.candidateDigest, value.manifestDigest)
  assert.equal(manifest.chunkCount, value.references.length)
  const chunks = [
    ...(manifestResponse.result.chunks ?? []),
    ...responses.filter((entry) => entry.endpoint === 'boardHistory' && entry.request.operation === 'chunks' && entry.request.contextId === manifest.contextId).flatMap((entry) => entry.result.chunks),
  ]
  assert.deepEqual(chunks.map((chunk) => ({ chunkId: chunk.chunkId, digest: chunk.digest })), value.references, 'UI preview read exactly the selected immutable chunk manifest')
  const { assembleScene } = await import('../functions/lib/scene-codec.js')
  assert.deepEqual(ids(await assembleScene(chunks)), ids(value.scene), 'Exact preview bytes contain that version’s elements, not live elements')
  assert.ok(calls.slice(beforeCalls).every((call) => !['commitBoardScene', 'updateBoardContent', 'restoreBoardVersion', 'importBoardVersion'].includes(call.endpoint)), 'Preview never writes live scene/name/history')
  assert.equal((await head()).currentVersionId, liveBefore.currentVersionId)
  assert.equal((await head()).headRevisionId, liveBefore.headRevisionId)
  assert.deepEqual(await page.evaluate(() => window.__excalidrawAPI.getSceneElements().filter((element) => !element.isDeleted).map((element) => element.id).sort()), liveIds, 'Isolated preview does not replace the mounted live editor')
  report.previews.push({ versionId: value.id, manifestDigest: value.manifestDigest, tupleDigest: value.tupleDigest, chunkCount: chunks.length, elementIds: ids(value.scene), current })
}
try {
  await page.goto(base)
  const fixture = await page.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner } = await import('/tests/regression-fixture.ts')
    await signInOwner(getFirebaseAuth())
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { convertToExcalidrawElements } = await import('/tests/history-fixture.ts')
    const project = await workspaceApi.createProject('Timeline actions proof'), board = await workspaceApi.createBoard(project.id, 'Timeline original')
    const frame = convertToExcalidrawElements([{ type: 'frame', id: 'timeline-slide', children: [], x: 0, y: 0, width: 450, height: 350, name: 'Timeline slide', customData: { agenticWhiteboard: { slide: { schemaVersion: 1, orderKey: '0/1' } } } }], { regenerateIds: false })
    await workspaceApi.saveBoard({ ...board, scene: { elements: frame, appState: { viewBackgroundColor: '#ffffff' }, files: {} } }); await workspaceApi.flushCloud()
    return { id: board.id, projectId: project.id }
  })
  boardId = fixture.id; projectId = fixture.projectId; root = `boardScenes/${boardId}`
  await page.goto(`${base}/boards/${boardId}`)
  await page.waitForSelector('[data-testid="board-history-open"]:not(:disabled)')
  await draw(650, 400)
  const drawing = await remember('Actual toolbar/pointer save')
  await note('Timeline original protected note')
  const target = await remember('Actual speaker note save / restore target')
  assert.ok(target.notes['timeline-slide']); assert.notEqual(target.id, drawing.id)
  await rename('Timeline renamed')
  const renamed = await remember('Actual rename form save')
  assert.equal(renamed.sceneRevisionId, target.sceneRevisionId, 'Name-only version reuses its immutable scene revision')
  await note('Timeline later protected note')
  const laterNotes = await remember('Actual second speaker note save')
  assert.equal(laterNotes.sceneRevisionId, target.sceneRevisionId, 'Note-only version reuses its immutable scene revision')
  if (await page.$('.slides-panel')) await page.click('.slides-toggle')
  const futureElement = await draw(800, 600), laterDrawing = await remember('Actual later pointer save')
  assert.ok(ids(laterDrawing.scene).includes(futureElement)); assert.ok(!ids(target.scene).includes(futureElement))
  // Real accepted server renames provide >50 immutable entries quickly, without fabricated metadata.
  const bulk = await page.evaluate(async ({ id, count }) => {
    const { projectCall } = await import('/src/features/sharing/project-service.ts')
    const { getFirestoreDb } = await import('/src/lib/firebase.ts')
    const { doc, getDocFromServer } = await import('/tests/history-fixture.ts')
    const head = (await getDocFromServer(doc(getFirestoreDb(), 'boardScenes', id))).data()
    let nameRevision = head.nameRevision
    const accepted = []
    for (let index = 0; index < count; index++) {
      const result = await projectCall('updateBoardContent', { boardId: id, name: `Timeline page entry ${String(index).padStart(2, '0')}`, mutationId: crypto.randomUUID(), generation: head.generation, expectedFence: head.restoreFence, nameRevision })
      nameRevision = result.nameRevision; accepted.push(result.versionId)
    }
    return accepted
  }, { id: boardId, count: report.bulkRenameCount })
  assert.equal(new Set(bulk).size, report.bulkRenameCount)
  for (const id of bulk) { const value = await snapshot(id); report.captures.push({ label: 'Accepted callable pagination fixture', kind: 'callable-pagination-fixture', ...value, scene: undefined, notes: undefined }) }
  // Two real native captures yield an admitted immutable offline-import side lineage.
  await page.goto(`${base}/tests/history-fixture.ts`)
  await page.evaluate(async ({ id, projectId }) => {
    const { boardHistoryStore, convertToExcalidrawElements, setWorkspaceIdentity } = await import('/tests/history-fixture.ts')
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    await getFirebaseAuth().authStateReady(); setWorkspaceIdentity(getFirebaseAuth().currentUser.uid)
    const { syncBoardHistory } = await import('/src/features/workspace/history-sync.ts')
    for (let index = 0; index < 2; index++) {
      const tuple = await boardHistoryStore.getCommittedContent(id)
      const extra = convertToExcalidrawElements([{ type: 'ellipse', id: `timeline-offline-${index}`, x: 500 + index * 130, y: 500, width: 80, height: 80 }], { regenerateIds: false })
      await boardHistoryStore.save({ ...tuple.document, scene: { ...tuple.document.scene, elements: [...tuple.document.scene.elements, ...extra] } }, { changedFields: { scene: true } })
    }
    await syncBoardHistory({ boardId: id, projectId, assetRoot: `boards/${id}/assets` })
  }, { id: boardId, projectId })
  await page.goto(`${base}/boards/${boardId}`); await page.waitForSelector('[data-testid="board-history-open"]:not(:disabled)')
  await settled()
  const before = await inspectTimeline('Before restore: every save and admitted side branch', 60)
  assert.ok(report.captures.every((capture) => before.some((entry) => entry.versionId === capture.id)), 'Every separately tracked real UI save and every callable fixture save appears in history')
  report.allInitialEligibleCaptures = []
  for (const entry of before) { const value = await snapshot(entry.versionId); report.allInitialEligibleCaptures.push({ ...value, scene: undefined, notes: undefined }) }
  const sideIds = before.filter((entry) => entry.origin === 'offline-import').map((entry) => entry.versionId)
  assert.ok(sideIds.length, 'Fixture really admitted offline-import entries; side-branch hiding is not a vacuous assertion')
  const beforeIds = before.map((entry) => entry.versionId), preRestoreHead = await head()
  await page.screenshot({ path: `${artifacts}/board-history-timeline-all-versions.png` })
  await preview(target); await preview(laterDrawing)
  const current = await snapshot(preRestoreHead.currentVersionId)
  await preview(current, true)
  await preview(target)
  await page.screenshot({ path: `${artifacts}/board-history-timeline-target-preview.png` })
  await page.click('[data-testid="history-restore"]')
  await page.waitForFunction(() => !!document.querySelector('[data-testid="history-data-loss-confirmation"]') || !!document.querySelector('[data-testid="history-restoration-progress"]'))
  if (await page.$('[data-testid="history-data-loss-confirmation"]')) await page.click('[data-testid="history-confirm-restore"]')
  await wait(async () => (await head()).generation === preRestoreHead.generation + 1 && !(await head()).restoreOperationId, 'Restore did not publish/unlock the new universe')
  await page.waitForFunction(() => !document.querySelector('[data-testid="board-history-dialog"]') && !document.querySelector('[data-testid="history-restoration-progress"]'))
  const restored = await head()
  assert.equal(restored.boardName, target.name)
  assert.deepEqual(ids((await loadSceneRevision(boardId, restored)).scene), ids(target.scene))
  assert.equal((await loadNoteSnapshot(boardId, restored.notesRevisionId))['timeline-slide'].text, target.notes['timeline-slide'])
  assert.deepEqual(await page.evaluate(() => window.__excalidrawAPI.getSceneElements().filter((element) => !element.isDeleted).map((element) => element.id).sort()), ids(target.scene))
  const after = await inspectTimeline('After restore: selected ancestors plus fresh restore version')
  const afterIds = after.map((entry) => entry.versionId), removed = beforeIds.filter((id) => !afterIds.includes(id))
  assert.ok(afterIds.includes(target.id)); assert.ok(afterIds.includes(restored.currentVersionId))
  assert.ok(removed.includes(laterDrawing.id) && bulk.every((id) => removed.includes(id)) && sideIds.every((id) => removed.includes(id)), 'Later canonical saves and admitted old side branches are hidden after the cutoff')
  assert.equal(afterIds.length + removed.length, beforeIds.length + 1, 'Restore introduces exactly one new eligible immutable version')
  await page.click('[aria-label="Close board history"]')
  const postRestoreElement = await draw(600, 500), newSave = await remember('Actual pointer save in new universe')
  assert.equal(newSave.branchId, restored.currentBranchId)
  assert.ok(ids(newSave.scene).includes(postRestoreElement)); assert.ok(!ids(newSave.scene).includes(futureElement))
  const edited = await inspectTimeline('New universe edit appears without resurrecting abandoned history')
  assert.ok(edited.some((entry) => entry.versionId === newSave.id))
  assert.ok(removed.every((id) => !edited.some((entry) => entry.versionId === id)))
  await page.click('[aria-label="Close board history"]')
  cachedPreviewIds.clear()
  await page.reload(); await page.waitForSelector('[data-testid="board-history-open"]:not(:disabled)'); await settled()
  const reloaded = await inspectTimeline('Cold route reload keeps the exact eligible set')
  assert.deepEqual(reloaded.map((entry) => entry.versionId), edited.map((entry) => entry.versionId))
  await page.screenshot({ path: `${artifacts}/board-history-timeline-after-reload.png` })
  assert.deepEqual(errors, [])
  checks.push('Real pointer/name/note saves each publish complete immutable versions', '>50 accepted versions exactly match every rendered grouped/paginated ID', 'Several previews read their own verified chunks/name/notes without live writes', 'Restore hides all later saves and old admitted side branches', 'New-universe pointer save and cold reload keep exact eligible IDs')
  console.log(`PASS timeline (${beforeIds.length} initial eligible, ${removed.length} hidden, ${reloaded.length} eligible after restore/edit): ${checks.join('; ')}`)
} finally {
  await Promise.all([...pendingResponses])
  const finalBrowserState = await page.evaluate(async (id) => {
    const { boardHistoryStore } = await import('/tests/history-fixture.ts')
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const tuple = id ? await boardHistoryStore.getCommittedContent(id) : null
    const outbox = id ? await boardHistoryStore.listOutbox(id) : []
    const workspace = id ? await workspaceApi.loadBoard(id) : null
    return { text: document.body.innerText, editingName: document.querySelector('input[aria-label="Edit board name"]')?.value,
      native: tuple ? { name: tuple.document.name, revision: tuple.document.revision, cloudNameRevision: tuple.document.cloudNameRevision, cloudRestoreFence: tuple.document.cloudRestoreFence, cloudVersionId: tuple.document.cloudVersionId, syncStatus: tuple.document.syncStatus } : null,
      workspace: workspace ? { name: workspace.name, revision: workspace.revision, cloudNameRevision: workspace.cloudNameRevision, cloudRestoreFence: workspace.cloudRestoreFence, syncStatus: workspace.syncStatus } : null,
      outbox: outbox.map((entry) => ({ localVersionId: entry.localVersionId, expectedFence: entry.expectedFence, generation: entry.generation, headAcknowledged: entry.headAcknowledged, changedFields: entry.changedFields, fieldBases: entry.fieldBases, retryState: entry.retryState, lastError: entry.lastError, receipt: entry.receipt })) }
  }, boardId).catch((error) => ({ error: error.message }))
  const finalHead = boardId ? await head().then((value) => ({ boardName: value.boardName, nameRevision: value.nameRevision, generation: value.generation, restoreFence: value.restoreFence, currentVersionId: value.currentVersionId })).catch((error) => ({ error: error.message })) : null
  const contentResponses = responses.filter((entry) => ['updateBoardContent', 'slideNotes', 'commitBoardScene'].includes(entry.endpoint)).map((entry) => ({ endpoint: entry.endpoint, operation: entry.request.operation, mutationId: entry.request.mutationId, name: entry.request.name, nameRevision: entry.request.nameRevision, generation: entry.request.generation, expectedFence: entry.request.expectedFence, status: entry.status, result: entry.result, error: entry.error }))
  const aliases = new Map(), alias = (id) => { if (!id) return undefined; if (!aliases.has(id)) aliases.set(id, `context-${aliases.size + 1}`); return aliases.get(id) }
  const network = calls.map(({ endpoint, data }) => ({ endpoint, operation: data?.operation, versionId: data?.versionId, mutationId: data?.mutationId, name: data?.name, nameRevision: data?.nameRevision, generation: data?.generation ?? data?.expectedGeneration, expectedFence: data?.expectedFence, cursorPresent: !!data?.cursor, context: alias(data?.contextId), page: data?.page, chunkIds: data?.chunkIds }))
  await writeFile(`${artifacts}/board-history-timeline-report.json`, JSON.stringify({ checks, errors, ...report, finalBrowserState, finalHead, contentResponses, realUiActionCaptures: report.captures.filter((capture) => capture.kind === 'real-ui-action').map((capture) => ({ label: capture.label, id: capture.id })), acceptedCallableFixtureCaptures: report.captures.filter((capture) => capture.kind === 'callable-pagination-fixture').map((capture) => capture.id), network, uncovered: ['Retention expiry/garbage collection, permission revocation, images and network/restore failure races are covered by separate model/backend/rules/image/chaos suites, not this timeline oracle.', 'Pagination fixtures use real accepted rename callables; only representative scene/name/note edits use pointer/forms.'] }, null, 2))
  await context.close(); await browser.close(); await db.terminate(); await deleteApp(app)
}
