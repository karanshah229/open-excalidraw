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
const calls = [], errors = [], captureEvidence = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('request', (request) => {
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
      cloudRevisionId: snapshot.revisionId, cloudGeneration: snapshot.generation,
      cloudRestoreFence: head.restoreFence, cloudNameRevision: head.nameRevision }, snapshot.notes)
  }, { boardId, projectId })
  const originalHead = await head()
  const captures = []
  await page.setOfflineMode(true)
  for (let index = 1; index <= 3; index++) captures.push(await capture('Original', index * 50))
  await page.setOfflineMode(false)
  // Protocol-0 has acknowledged current fields but has no history receipts.
  // Reopening after migration has already projected the cloud baseline ID.
  const stranded = await page.evaluate(async ({ boardId, captures, originalHead }) => {
    const { store } = window.__outbox
    for (const capture of captures) await store.acknowledgeLegacyFields(boardId, capture.localVersionId,
      { scene: true, name: true, notes: ['slide-one'] })
    const current = await store.getCommittedContent(boardId)
    await store.reconcileDocument({ ...current.document, cloudVersionId: originalHead.currentVersionId,
      cloudRestoreFence: originalHead.restoreFence, syncStatus: 'synced' })
    return store.listOutbox(boardId)
  }, { boardId, captures, originalHead })
  assert.equal(stranded.length, 3)
  assert.ok(stranded.every(entry => !entry.sourceBaseVersionId && entry.headAcknowledged), 'Exact already-hydrated legacy rollout state reproduced')
  await synchronize()
  const pending = await page.evaluate(async id => window.__outbox.store.listOutbox(id), boardId)
  assert.equal(pending.length, 0, `Legacy history must upload after hydration: ${JSON.stringify(pending.map(entry => ({ error: entry.lastError, base: entry.sourceBaseVersionId })))}`)
  const currentHead = await head()
  assert.equal(currentHead.currentVersionId, originalHead.currentVersionId, 'Historical upload must not overwrite current cloud content')
  const native = await page.evaluate(async id => window.__outbox.store.list(id), boardId)
  for (const capture of captures) {
    const version = native.find(version => version.localVersionId === capture.localVersionId)
    assert.equal(version.uploadStatus, 'published')
    assert.ok(version.receipt, 'Every retained capture gets a stable cloud receipt')
    const receipt = (await db.doc(`${root}/importReceipts/${capture.localVersionId}`).get()).data()
    assert.equal(receipt.result.localSnapshotVersionId, version.receipt.localSnapshotVersionId)
    const cloud = (await db.doc(`${root}/versions/${version.receipt.localSnapshotVersionId}`).get()).data()
    const scene = await loadSceneRevision(boardId, { generation: cloud.sceneGeneration, headRevisionId: cloud.sceneRevisionId })
    assert.equal(scene.scene.elements.find(element => element.id === 'rectangle').x, capture.x)
    assert.equal((await loadNoteSnapshot(boardId, cloud.notesRevisionId))['slide-one'].text, 'Original protected note')
  }
  const timeline = await cloudTimeline()
  assert.ok(!timeline.some(entry => entry.origin === 'local'), 'Uploaded history replaces disabled device-only rows')
  for (const capture of captures) assert.ok(timeline.some(entry => entry.id === native.find(version => version.localVersionId === capture.localVersionId).receipt.localSnapshotVersionId))
  await synchronize()
  assert.equal((await records()).length, 4, 'Retry never duplicates baseline or the three imports')
  assert.deepEqual(errors, [])
  console.log('PASS rollout recovery: acknowledged legacy captures hydrate before lineage binding; all receipts/chunk scenes/notes publish once, current head unchanged, cloud history replaces local rows')
} finally {
  await writeFile(`${artifacts}/network.json`, JSON.stringify({ calls, errors }, null, 2))
  await browser.close()
  await db.terminate()
  await deleteApp(app)
}
