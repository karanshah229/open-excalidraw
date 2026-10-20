import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error('Requires disposable history regression emulators')
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getFirestore, Timestamp } = require('firebase-admin/firestore')
const app = initializeApp({ projectId: 'demo-regression', databaseURL: 'https://demo-regression.firebaseio.com' })
const db = getFirestore(app)
const { loadSceneRevision } = await import('../functions/lib/board-scenes.js')
const { loadNoteSnapshot } = await import('../functions/lib/board-history-notes.js')
const { restoreVersion } = await import('../functions/lib/board-history.js')
const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190'
const artifacts = process.env.E2E_ARTIFACT_DIR || '.system_generated/regression'
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const page = await browser.newPage()
page.setDefaultTimeout(60000)
const calls = [], errors = [], captureEvidence = [], firestoreCommits = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('request', (request) => {
  if (request.method() === 'POST' && request.url().includes('firestore.googleapis.com') && request.url().includes(':commit'))
    firestoreCommits.push(request.url())
  if (request.method() !== 'POST' || !request.url().includes(':45001/')) return
  try { calls.push({ endpoint: request.url().split('/').pop(), data: JSON.parse(request.postData() || '{}').data }) } catch { /* Other request. */ }
})
const boardId = `outbox_${Date.now()}`, projectId = `${boardId}_project`, root = `boardScenes/${boardId}`
const wait = async (predicate, message) => {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
  throw new Error(message)
}
const head = async () => (await db.doc(root).get()).data()
const records = async () => (await db.collection(`${root}/versions`).get()).docs.map((doc) => ({ id: doc.id, ...doc.data() }))
const cloudTimeline = async () => page.evaluate(async (boardId) => {
  const { cloudHistorySource } = await import('/src/features/history/history-service.ts')
  const { sceneService } = await import('/src/features/scenes/scene-service.ts')
  const head = await sceneService.load(boardId)
  const source = cloudHistorySource(boardId, () => ({ generation: head.generation, restoreFence: head.restoreFence }))
  const entries = [], cursors = new Set()
  let cursor
  do {
    const next = await source.list(cursor)
    entries.push(...next.entries)
    cursor = next.cursor
    if (cursor && cursors.has(cursor)) throw new Error('History cursor repeated')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return entries
}, boardId)
const installBrowserModules = async () => page.evaluate(async () => {
  const firebase = await import('/src/lib/firebase.ts')
  await firebase.getFirebaseAuth().authStateReady()
  const fixture = await import('/tests/history-fixture.ts')
  fixture.setWorkspaceIdentity(firebase.getFirebaseAuth().currentUser.uid)
  const sync = await import('/src/features/workspace/history-sync.ts')
  window.__outbox = { store: fixture.boardHistoryStore, sync, firebase }
})
const synchronize = async () => page.evaluate(async ({ boardId, projectId }) => {
  await window.__outbox.sync.syncBoardHistory({ boardId, projectId, assetRoot: `boards/${boardId}/assets` })
}, { boardId, projectId })
const capture = async (label, x, cloudBase) => page.evaluate(async ({ boardId, label, x, cloudBase }) => {
  const { store } = window.__outbox
  const current = await store.getCommittedContent(boardId)
  const document = { ...current.document, name: label, scene: { ...current.document.scene,
    elements: current.document.scene.elements.map((element) => element.id === 'rectangle'
      ? { ...element, x, version: Number(element.version) + 1 } : element) } }
  const saved = await store.save(document, { changedFields: { scene: true, name: true },
    fieldBases: { nameRevision: cloudBase ?? current.document.cloudNameRevision } })
  return { localVersionId: saved.version.localVersionId, name: saved.document.name, x }
}, { boardId, label, x, cloudBase })
try {
  // A fixture-only document intentionally runs no editor/autosave. All writes
  // below go through the real native store, Firebase SDK/rules and outbox worker.
  await page.goto(`${base}/tests/history-fixture.ts`)
  const seed = await page.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner, pauseCloudReplication } = await import('/tests/regression-fixture.ts')
    const { user } = await signInOwner(getFirebaseAuth())
    pauseCloudReplication()
    const { convertToExcalidrawElements } = await import('/tests/history-fixture.ts')
    return { uid: user.uid, scene: { elements: convertToExcalidrawElements([
      { id: 'rectangle', type: 'rectangle', x: 0, y: 0, width: 100, height: 80 },
    ], { regenerateIds: false }), appState: {}, files: {} } }
  })
  const timestamp = new Date().toISOString()
  await db.doc(`users/${seed.uid}/projects/${projectId}`).set({ id: projectId, ownerId: seed.uid, name: 'Outbox', active: true,
    createdAt: timestamp, updatedAt: timestamp })
  await db.doc(`users/${seed.uid}/projects/${projectId}/boards/${boardId}`).set({ id: boardId, projectId, name: 'Original', active: true, scene: seed.scene,
    createdAt: timestamp, updatedAt: timestamp })
  await db.doc(`slideNotes/${boardId}/notes/slide-one`).set({ text: 'Original protected note', revision: 2, updatedAt: null })
  await installBrowserModules()
  await page.evaluate(async ({ boardId, projectId }) => {
    const { sceneService } = await import('/src/features/scenes/scene-service.ts')
    const { readHistorySnapshot } = await import('/src/features/history/history-service.ts')
    const head = await sceneService.ensure(boardId, projectId)
    const snapshot = await readHistorySnapshot(boardId, undefined, false)
    await window.__outbox.store.initialize({ id: boardId, projectId, name: snapshot.entry.name, active: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), syncStatus: 'synced', revision: 0,
      baseRevision: 0, syncAttempts: 0, nextSyncAt: null, lastSyncError: null, formatVersion: 1, scene: snapshot.scene,
      cloudRevisionId: snapshot.revisionId, cloudGeneration: snapshot.generation, cloudVersionId: snapshot.entry.id,
      cloudRestoreFence: head.restoreFence, cloudNameRevision: head.nameRevision }, snapshot.notes)
  }, { boardId, projectId })
  const originalHead = await head(), originalVersionId = originalHead.currentVersionId
  assert.equal(await page.evaluate(async (id) => (await window.__outbox.store.listOutbox(id)).length, boardId), 0)
  await page.setOfflineMode(true)
  assert.equal(await page.evaluate(() => navigator.onLine), false)
  const captures = []
  for (let index = 1; index <= 3; index++) captures.push(await capture(`Offline L${index}`, index * 50))
  assert.equal((await head()).headRevisionId, originalHead.headRevisionId, 'offline saves must not touch canonical head')
  assert.equal(await page.evaluate(async (id) => (await window.__outbox.store.listOutbox(id)).length, boardId), 3)
  const reconnectCallOffset = calls.length
  await page.setOfflineMode(false)
  await synchronize()
  const reconnectCalls = calls.slice(reconnectCallOffset).filter((call) => call.data?.boardId === boardId)
  assert.ok(reconnectCalls.some((call) => call.endpoint === 'commitBoardScene'),
    'reconnect must publish the pending current-content head after importing earlier offline versions')
  assert.ok(reconnectCalls.some((call) => call.endpoint === 'importBoardVersion'),
    'reconnect must also preserve offline captures as immutable history')
  assert.equal(reconnectCalls.filter((call) => call.endpoint === 'ensureBoardScene').length, 1,
    'direct history sync registers the board once before applying pending captures')
  assert.equal(await page.evaluate(async (id) => (await window.__outbox.store.listOutbox(id)).length, boardId), 0,
    'reconnect resolves both historical captures and the current-content head before returning')
  let cloud = await head()
  assert.equal(cloud.boardName, 'Offline L3')
  assert.equal((await loadSceneRevision(boardId, cloud)).scene.elements.find((element) => element.id === 'rectangle').x, 150)
  assert.equal((await loadNoteSnapshot(boardId, cloud.notesRevisionId))['slide-one'].text, 'Original protected note')
  const versions = await records()
  const nativeVersions = await page.evaluate(async (id) => window.__outbox.store.list(id), boardId)
  const mappedIds = []
  for (const saved of captures) {
    const receipt = (await db.doc(`${root}/importReceipts/${saved.localVersionId}`).get()).data()
    assert.ok(receipt, `missing stable capture receipt ${saved.name}`)
    const native = nativeVersions.find((entry) => entry.localVersionId === saved.localVersionId)
    assert.equal(native.uploadStatus, 'published')
    assert.equal(native.receipt.localSnapshotVersionId, receipt.result.localSnapshotVersionId)
    assert.equal(native.receipt.canonicalVersionId ?? null, receipt.result.canonicalVersionId ?? null)
    assert.equal(native.receipt.expiresAt, receipt.result.expiresAt)
    mappedIds.push(receipt.result.localSnapshotVersionId)
    captureEvidence.push({ ...saved, receipt: receipt.result })
    const entry = versions.find((version) => version.id === receipt.result.localSnapshotVersionId)
    assert.ok(entry, 'canonical aliases resolve by receipt version ID, not local capture mutation ID')
    assert.equal(entry.boardName, saved.name)
    assert.equal((await loadSceneRevision(boardId, { generation: entry.sceneGeneration, headRevisionId: entry.sceneRevisionId })).scene.elements.find((element) => element.id === 'rectangle').x, saved.x)
    assert.equal((await loadNoteSnapshot(boardId, entry.notesRevisionId))['slide-one'].text, 'Original protected note')
    if (receipt.result.canonicalVersionId) {
      assert.equal(receipt.result.canonicalVersionId, cloud.currentVersionId)
      assert.equal(receipt.result.localSnapshotVersionId, receipt.result.canonicalVersionId)
      assert.equal(versions.filter((version) => version.mutationId === saved.localVersionId).length, 0, 'canonical alias must not duplicate the immutable canonical version')
    } else assert.equal(versions.filter((version) => version.mutationId === saved.localVersionId).length, 1)
  }
  assert.equal(new Set(mappedIds).size, captures.length, 'all three different complete local saves map to distinct cloud versions')
  const timeline = await cloudTimeline()
  assert.equal(new Set(timeline.map((entry) => entry.id)).size, timeline.length, 'history list contains no duplicate version IDs')
  assert.deepEqual(timeline.map((entry) => entry.id).sort(), versions.map((entry) => entry.id).sort(), 'every eligible immutable cloud version appears in the production source')
  for (const [index, saved] of captures.entries()) assert.equal(timeline.find((entry) => entry.id === mappedIds[index])?.name, saved.name)
  // Render the production dialog in a separate root without mounting an editor
  // or autosave callback. This verifies the actual rows use the receipt IDs.
  await page.evaluate(async (boardId) => {
    const { default: HistoryDialog } = await import('/src/features/history/history-dialog.tsx')
    const { ThemeProvider } = await import('/src/lib/theme-context.tsx')
    // Resolve the existing Vite React module, including its configured cacheDir,
    // so this fixture does not introduce a second React instance.
    const reactUrl = performance.getEntriesByType('resource').map((entry) => entry.name)
      .find((url) => /\/deps\/react\.js(?:\?|$)/.test(url))
    if (!reactUrl) throw new Error('Production React dependency was not loaded')
    const reactModule = await import(reactUrl)
    const React = reactModule.default ?? reactModule
    const clientModule = await import(new URL('react-dom_client.js', reactUrl).href)
    const createRoot = clientModule.createRoot ?? clientModule.default?.createRoot
    if (typeof createRoot !== 'function') throw new Error('Vite ReactDOM client did not expose createRoot')
    const { cloudHistorySource } = await import('/src/features/history/history-service.ts')
    const { sceneService } = await import('/src/features/scenes/scene-service.ts')
    const head = await sceneService.load(boardId), host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    window.__outboxDialog = { root, host }
    root.render(React.createElement(ThemeProvider, null, React.createElement(HistoryDialog, { open: true, onOpenChange() {},
      source: cloudHistorySource(boardId, () => ({ generation: head.generation, restoreFence: head.restoreFence })),
      canRestore: false, async isDirty() { return false }, onRestoreStart() {}, async onRestoreComplete() {}, onRestoreFailed() {} })))
  }, boardId)
  await wait(async () => await page.$$eval('.history-entry', (rows) => rows.length) === timeline.length, 'production HistoryDialog did not display all eligible version rows')
  const visibleRows = await page.$$eval('.history-entry', (rows) => rows.map((row) => ({ id: row.dataset.versionId, timestamp: row.querySelector('time')?.dateTime, label: row.querySelector('time')?.textContent, expectedLabel: new Date(row.querySelector('time').dateTime).toLocaleString() })))
  assert.deepEqual(visibleRows.map((row) => row.id).sort(), timeline.map((entry) => entry.id).sort())
  for (const row of visibleRows) {
    const entry = timeline.find((entry) => entry.id === row.id)
    assert.equal(row.timestamp, entry.capturedAt ?? entry.createdAt)
    assert.equal(row.label, row.expectedLabel)
  }
  await page.evaluate(() => { window.__outboxDialog.root.unmount(); window.__outboxDialog.host.remove(); delete window.__outboxDialog })
  assert.equal(await page.evaluate(async (id) => (await window.__outbox.store.listOutbox(id)).length, boardId), 0)
  const beforeRetry = versions.length
  const idleSyncOffset = calls.length
  await synchronize()
  assert.equal((await records()).length, beforeRetry, 'retry must not duplicate history')
  assert.deepEqual(calls.slice(idleSyncOffset).filter((call) => call.data?.boardId === boardId), [],
    'syncing an empty outbox must not register, read, or rewrite the cloud board')

  // A user may explicitly resolve an offline name conflict with a later rename
  // based on the newly observed revision. The abandoned older CAS base remains
  // provenance for its capture, but cannot block that deliberate new intent.
  await page.setOfflineMode(true)
  const staleRename = await capture('Stale offline rename', 180)
  await page.setOfflineMode(false)
  await page.evaluate(async (boardId) => {
    const { projectCall } = await import('/src/features/sharing/project-service.ts')
    const { sceneService } = await import('/src/features/scenes/scene-service.ts')
    const current = await sceneService.load(boardId)
    await projectCall('updateBoardContent', { boardId, mutationId: crypto.randomUUID(), name: 'Other editor rename',
      nameRevision: current.nameRevision, generation: current.generation, expectedFence: current.restoreFence })
  }, boardId)
  const failedRename = await synchronize().then(() => false, () => true)
  assert.ok(failedRename, 'stale explicit rename CAS must conflict')
  cloud = await head()
  assert.equal(cloud.boardName, 'Other editor rename')
  await capture('Explicit conflict resolution', 190, cloud.nameRevision)
  await synchronize()
  assert.equal((await head()).boardName, 'Explicit conflict resolution')
  assert.ok((await db.doc(`${root}/importReceipts/${staleRename.localVersionId}`).get()).exists, 'earlier conflicting tuple retained as history')

  // Lose a successful import's response at HTTP response stage, then reload.
  // The accepted receipt survives the lost browser promise and resumes by ID.
  await page.setOfflineMode(true)
  const lost = await capture('Lost receipt local', 220)
  const latest = await capture('Latest after lost receipt', 270)
  const cdp = await page.createCDPSession()
  let responseLost = false
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/importBoardVersion', requestStage: 'Response' }] })
  cdp.on('Fetch.requestPaused', (event) => {
    if (!responseLost && event.request.method === 'POST' && event.responseStatusCode >= 200 && event.responseStatusCode < 300) {
      responseLost = true
      void cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' })
    } else void cdp.send('Fetch.continueRequest', { requestId: event.requestId })
  })
  await page.setOfflineMode(false)
  await synchronize().catch(() => undefined)
  await wait(async () => (await db.doc(`${root}/importReceipts/${lost.localVersionId}`).get()).exists, 'lost response was not a committed import')
  assert.ok(responseLost)
  const lostReceiptBefore = (await db.doc(`${root}/importReceipts/${lost.localVersionId}`).get()).data().result
  await cdp.send('Fetch.disable')
  await cdp.detach()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await installBrowserModules()
  await synchronize()
  assert.deepEqual((await db.doc(`${root}/importReceipts/${lost.localVersionId}`).get()).data().result, lostReceiptBefore, 'reload retry must preserve original expiry and identities')
  assert.equal((await head()).boardName, latest.name)
  assert.equal((await db.collection(`${root}/versions`).where('mutationId', '==', lost.localVersionId).get()).size, 1)

  // Same-generation failed restore: retain local work, resolve receipts, fresh
  // attempt IDs and fence, while preserving the original compare-and-set base.
  await page.setOfflineMode(true)
  const beforeFence = await capture('Survives failed restore', 330)
  const pendingBefore = await page.evaluate(async (id) => (await window.__outbox.store.listOutbox(id))[0], boardId)
  cloud = await head()
  await db.doc(root).update({ restoreFence: cloud.restoreFence + 1, restoreOperationId: null })
  await page.setOfflineMode(false)
  await synchronize()
  assert.equal((await head()).boardName, beforeFence.name)
  assert.ok((await db.doc(`${root}/importReceipts/${beforeFence.localVersionId}`).get()).exists)
  assert.equal(await page.evaluate(async (id) => (await window.__outbox.store.listOutbox(id)).length, boardId), 0)
  assert.equal(pendingBefore.generation, (await head()).generation)

  // An expired historical base blocks that capture only; latest content is
  // still committed and acknowledged with a new eligible canonical identity.
  cloud = await head()
  await db.doc(`${root}/versions/${cloud.currentVersionId}`).update({ expiresAt: Timestamp.fromMillis(0) })
  await page.setOfflineMode(true)
  const blocked = await capture('Historical expired-base snapshot', 380)
  const availableLatest = await capture('Current despite expired history base', 420)
  await page.setOfflineMode(false)
  await synchronize()
  assert.equal((await head()).boardName, availableLatest.name)
  const held = await page.evaluate(async (id) => await window.__outbox.store.listOutbox(id), boardId)
  assert.ok(held.some((entry) => entry.localVersionId === blocked.localVersionId && entry.retryState === 'blocked' && entry.headAcknowledged))
  assert.ok(!held.some((entry) => entry.localVersionId === availableLatest.localVersionId))

  // A concurrent canonical scene merge may differ from the local saved tuple.
  // If that tuple's ancestry is unavailable, retain its exact history obligation
  // without falsely keeping its already-applied current head pending forever.
  cloud = await head()
  await db.doc(`${root}/versions/${cloud.currentVersionId}`).update({ expiresAt: Timestamp.fromMillis(0) })
  await page.setOfflineMode(true)
  await capture('Unavailable ancestor before merge', 440)
  const divergentLatest = await capture('Latest merged despite unavailable history', 460)
  await page.setOfflineMode(false)
  await page.evaluate(async (boardId) => {
    const { sceneService } = await import('/src/features/scenes/scene-service.ts')
    const { convertToExcalidrawElements } = await import('/tests/history-fixture.ts')
    const loaded = await sceneService.load(boardId)
    await sceneService.commit(boardId, { ...loaded.scene, elements: [...loaded.scene.elements,
      ...convertToExcalidrawElements([{ id: 'remote-circle', type: 'ellipse', x: 800, y: 0, width: 60, height: 60 }], { regenerateIds: false })] },
      { expectedGeneration: loaded.generation, expectedFence: loaded.restoreFence })
  }, boardId)
  await synchronize()
  cloud = await head()
  assert.equal(cloud.boardName, divergentLatest.name)
  assert.ok((await loadSceneRevision(boardId, cloud)).scene.elements.some((element) => element.id === 'remote-circle'))
  const divergentHeld = await page.evaluate(async (id) => await window.__outbox.store.listOutbox(id), boardId)
  assert.ok(divergentHeld.some((entry) => entry.localVersionId === divergentLatest.localVersionId && entry.retryState === 'blocked' && entry.headAcknowledged))
  assert.ok(divergentHeld.every((entry) => entry.publicationIntent === 'history-only'), 'unavailable history must not retain an already-applied head')
  assert.equal(await page.evaluate(async (id) => (await window.__outbox.store.getCommittedContent(id)).document.syncStatus, boardId), 'synced')
  const blockedRetryOffset = calls.length
  await synchronize()
  assert.deepEqual(calls.slice(blockedRetryOffset).filter((call) => call.data?.boardId === boardId), [],
    'blocked historical entries must remain visible locally without polling Firebase on every retry')

  // Successful restore received after being offline discards both old pending
  // edits and unsynced history; reconnect must never write them to generation 2.
  await page.setOfflineMode(true)
  const discarded = await capture('Must never upload after restore', 510)
  cloud = await head()
  const restored = await restoreVersion(boardId, `${boardId}_restore`, originalVersionId,
    { uid: seed.uid }, cloud.generation, cloud.restoreFence)
  await page.setOfflineMode(false)
  await page.evaluate(async ({ boardId, projectId, restored }) => {
    const { readHistorySnapshot } = await import('/src/features/history/history-service.ts')
    const snapshot = await readHistorySnapshot(boardId, undefined, false)
    const current = await window.__outbox.store.getCommittedContent(boardId)
    await window.__outbox.store.applyCloudRestore({ ...current.document, projectId, name: snapshot.entry.name,
      scene: snapshot.scene, cloudGeneration: restored.generation, cloudRevisionId: restored.revisionId, syncStatus: 'synced' },
      { notes: snapshot.notes, restoreFence: restored.restoreFence, currentVersionId: restored.versionId })
  }, { boardId, projectId, restored })
  await synchronize()
  assert.equal((await head()).generation, restored.generation)
  assert.equal((await head()).boardName, 'Original')
  assert.equal((await db.doc(`${root}/importReceipts/${discarded.localVersionId}`).get()).exists, false)
  assert.equal(await page.evaluate(async (id) => (await window.__outbox.store.listOutbox(id)).length, boardId), 0)
  const restoredLocal = await page.evaluate(async ({ boardId, discardedId }) => ({
    entries: await window.__outbox.store.list(boardId),
    discarded: await window.__outbox.store.get(boardId, discardedId),
  }), { boardId, discardedId: discarded.localVersionId })
  assert.equal(restoredLocal.discarded, null, 'restoration deletes the unsynced immutable history capture, not just its outbox entry')
  assert.ok(!restoredLocal.entries.some((entry) => entry.localVersionId === discarded.localVersionId))
  const restoredTimeline = await cloudTimeline()
  assert.deepEqual(restoredTimeline.map((entry) => entry.id).sort(), [originalVersionId, restored.versionId].sort(), 'new universe exposes only the retained target prefix and the restoration version')
  assert.ok(restoredTimeline.every((entry) => !mappedIds.includes(entry.id) && !entry.id.startsWith('local:')), 'abandoned imported versions and canonical aliases are all hidden after restore')
  const hiddenRead = await page.evaluate(async ({ boardId, versionId }) => {
    const { readHistorySnapshot } = await import('/src/features/history/history-service.ts')
    try { await readHistorySnapshot(boardId, versionId, false); return null }
    catch (error) { return error.code }
  }, { boardId, versionId: mappedIds[0] })
  assert.equal(hiddenRead, 'functions/not-found', 'hidden imported history cannot be previewed/restored through the gateway')

  // A stale local-only projection with no outbox work must settle locally and
  // must not restart the Firestore metadata/scene-registration loop.
  const workspaceSyncCallOffset = calls.length
  const workspaceSyncCommitOffset = firestoreCommits.length
  const settledSyncStatus = await page.evaluate(async ({ boardId, projectId, uid }) => {
    const { workspaceApi, workspaceStore } = await import('/src/features/workspace/workspace-api.ts')
    const current = await window.__outbox.store.getCommittedContent(boardId)
    await workspaceStore.upsertProject({ id: projectId, ownerId: uid, name: 'Outbox', members: [],
      createdAt: current.document.createdAt, updatedAt: current.document.updatedAt })
    await workspaceStore.upsertBoard(current.document)
    await workspaceStore.updateBoardSyncStatus(boardId, 'local-only')
    await workspaceApi.activateCloudWorkspace(uid)
    await workspaceApi.flushCloud()
    return (await workspaceStore.loadBoard(boardId)).syncStatus
  }, { boardId, projectId, uid: seed.uid })
  assert.equal(settledSyncStatus, 'synced', 'the stale local-only marker is reconciled from its cloud head')
  await new Promise((resolve) => setTimeout(resolve, 1400))
  assert.equal(calls.slice(workspaceSyncCallOffset).filter((call) => call.data?.boardId === boardId && call.endpoint === 'ensureBoardScene').length, 0,
    'a cloud-bound local-only board with an empty outbox must not re-register its scene')
  assert.equal(firestoreCommits.length - workspaceSyncCommitOffset, 0,
    'a cloud-bound local-only board with an empty outbox must not repeat metadata transactions')
  await page.evaluate(async () => {
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    workspaceApi.deactivateCloudWorkspace()
  })
  assert.ok(calls.some((call) => call.endpoint === 'importBoardVersion'))
  assert.ok(calls.some((call) => call.endpoint === 'boardHistory' && call.data.operation === 'receipt'))
  assert.ok(calls.some((call) => call.endpoint === 'commitBoardScene'))
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log('PASS cloud outbox: offline 3 complete saves, individual imports/latest head, explicit rename CAS conflict/resolution, HTTP lost receipt + reload dedupe, failed-restore fence retry, expired-history isolation, successful-restore discard')
} finally {
  await writeFile(`${artifacts}/network.json`, JSON.stringify({ calls, errors, captureEvidence }, null, 2))
  await browser.close()
  await deleteApp(app)
}
