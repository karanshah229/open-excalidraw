import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

if (process.env.E2E_LEGACY_FUNCTIONS !== 'true' || process.env.GCLOUD_PROJECT !== 'demo-regression')
  throw new Error('Requires --legacy-functions disposable HEAD server/rules runtime')
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const admin = initializeApp({ projectId: 'demo-regression' }), db = getFirestore(admin)
const { manifestDigest } = await import('../functions/lib/scene-codec.js')
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const page = await browser.newPage()
page.setDefaultTimeout(60000)
const calls = [], errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('request', (request) => {
  if (request.method() === 'POST' && request.url().includes(':45001/')) calls.push(request.url().split('/').pop())
})
try {
  await page.goto(`${process.env.E2E_BASE_URL || 'http://127.0.0.1:15190'}/tests/regression-fixture.ts`)
  const result = await page.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner } = await import('/tests/regression-fixture.ts')
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { boardHistoryStore, convertToExcalidrawElements } = await import('/tests/history-fixture.ts')
    const { sceneService } = await import('/src/features/scenes/scene-service.ts')
    const { user } = await signInOwner(getFirebaseAuth())
    const project = await workspaceApi.createProject('Legacy runtime regression')
    const board = await workspaceApi.createBoard(project.id, 'Legacy new board')
    await workspaceApi.saveBoard({ ...board, scene: { elements: convertToExcalidrawElements([
      { id: 'legacy-rectangle', type: 'rectangle', x: 30, y: 40, width: 110, height: 80 },
    ], { regenerateIds: false }), appState: {}, files: {} } })
    await workspaceApi.flushCloud()
    const created = await workspaceApi.loadBoard(board.id)
    await workspaceApi.renameBoard(board.id, 'Legacy renamed board')
    await boardHistoryStore.saveNotes(board.id, { 'legacy-slide': 'Offline note survives old server' },
      { changedFields: { notes: ['legacy-slide'] }, fieldBases: { notes: { 'legacy-slide': 0 } } })
    await workspaceApi.flushCloud()
    await workspaceApi.loadBoardWithProject(board.id)
    const hydratedNotes = (await boardHistoryStore.getCommittedContent(board.id)).notes
    const saved = await workspaceApi.loadBoard(board.id)
    const cloud = await sceneService.load(board.id)
    const { projectCall } = await import('/src/features/sharing/project-service.ts')
    const note = await projectCall('slideNotes', { operation: 'read', boardId: board.id, projectId: project.id, slideId: 'legacy-slide' })
    const outbox = await boardHistoryStore.listOutbox(board.id)
    const versions = await boardHistoryStore.list(board.id)
    // A scene receipt is not a history receipt. Later migration must still bind
    // every retained capture even though ordinary scene sync already set a revision.
    return { boardId: board.id, projectId: project.id, uid: user.uid, hydratedNotes, createdStatus: created.syncStatus, savedStatus: saved.syncStatus,
      name: saved.name, revisionId: saved.cloudRevisionId, currentVersionId: saved.cloudVersionId,
      sceneIds: cloud.scene.elements.filter((element) => !element.isDeleted).map((element) => element.id),
      protocol: cloud.historyProtocolVersion, note, outbox, versions }
  })
  assert.equal(result.createdStatus, 'synced', 'new board must synchronize against old functions')
  assert.equal(result.savedStatus, 'synced', 'legacy rename and notes must not leave Sync failed')
  assert.equal(result.name, 'Legacy renamed board')
  assert.ok(result.revisionId)
  assert.equal(result.currentVersionId, undefined)
  assert.notEqual(result.protocol, 1)
  assert.deepEqual(result.sceneIds, ['legacy-rectangle'])
  assert.equal(result.note.text, 'Offline note survives old server')
  assert.equal(result.hydratedNotes['legacy-slide'], result.note.text, 'legacy hydration preserves known local notes when no full gateway exists')
  assert.equal((await db.doc(`users/${result.uid}/projects/${result.projectId}/boards/${result.boardId}`).get()).data().name, result.name)
  assert.ok(result.outbox.length >= 3, 'every immutable local capture retained for future history publication')
  assert.ok(result.outbox.every((entry) => !entry.receipt && entry.headAcknowledged && entry.publicationIntent === 'history-only'))
  assert.ok(result.versions.every((entry) => entry.uploadStatus === 'pending' && !entry.receipt), 'no fabricated history acknowledgement')
  const headRef = db.doc(`boardScenes/${result.boardId}`), originalHead = (await headRef.get()).data()
  await headRef.update({ generation: originalHead.generation + 1 })
  const beforeStale = calls.length
  const stale = await page.evaluate(async (boardId) => {
    const { syncBoardHistory } = await import('/src/features/workspace/history-sync.ts')
    const { SceneGenerationError } = await import('/src/features/scenes/scene-service.ts')
    try { await syncBoardHistory({ boardId, assetRoot: `boards/${boardId}/assets` }); return false }
    catch (error) { return error instanceof SceneGenerationError }
  }, result.boardId)
  assert.ok(stale, 'known legacy generation replacement must reject stale device content')
  assert.ok(!calls.slice(beforeStale).includes('commitBoardScene'), 'legacy stale generation cannot overwrite replacement')
  assert.equal((await headRef.get()).data().headRevisionId, originalHead.headRevisionId)
  await headRef.update({ generation: originalHead.generation })
  await headRef.update({ historyProtocolVersion: 1, currentVersionId: null })
  const beforePartial = calls.length
  const incomplete = await page.evaluate(async (boardId) => {
    const { syncBoardHistory } = await import('/src/features/workspace/history-sync.ts')
    try { await syncBoardHistory({ boardId, assetRoot: `boards/${boardId}/assets` }); return '' }
    catch (error) { return String(error) }
  }, result.boardId)
  assert.match(incomplete, /Cloud history registration has not completed/)
  assert.ok(!calls.slice(beforePartial).some((name) => ['commitBoardScene', 'slideNotes', 'updateBoardContent'].includes(name)), 'incomplete protocol 1 must not fall back to unfenced legacy writes')
  await headRef.update({ historyProtocolVersion: FieldValue.delete(), currentVersionId: FieldValue.delete() })
  await page.setOfflineMode(true)
  const dirtyId = await page.evaluate(async (boardId) => {
    const { boardHistoryStore } = await import('/tests/history-fixture.ts')
    const current = await boardHistoryStore.getCommittedContent(boardId)
    const saved = await boardHistoryStore.save({ ...current.document, scene: { ...current.document.scene,
      elements: current.document.scene.elements.map((element) => ({ ...element, x: element.x + 400, version: element.version + 1 })) } },
      { changedFields: { scene: true } })
    return saved.version.localVersionId
  }, result.boardId)
  const originalManifest = (await db.doc(`${headRef.path}/revisions/${originalHead.headRevisionId}`).get()).data()
  const replacementId = `legacy_replacement_${Date.now()}`, references = []
  const writer = db.bulkWriter()
  for (let slot = 0; slot < originalManifest.pageCount; slot++) {
    const pageId = String(slot).padStart(6, '0')
    const page = (await db.doc(`${headRef.path}/revisions/${originalHead.headRevisionId}/pages/${pageId}`).get()).data()
    const next = []
    for (const reference of page.references) {
      const chunkId = `${reference.chunkId}_legacy2`
      writer.set(db.doc(`${headRef.path}/chunks/${chunkId}`), { ...(await db.doc(`${headRef.path}/chunks/${reference.chunkId}`).get()).data(), generation: 2 })
      next.push({ chunkId, digest: reference.digest })
    }
    references.push(...next)
    writer.set(db.doc(`${headRef.path}/revisions/${replacementId}/pages/${pageId}`), { references: next })
  }
  writer.set(db.doc(`${headRef.path}/revisions/${replacementId}`), { ...originalManifest, generation: 2,
    candidateDigest: await manifestDigest(references, 2) })
  await writer.close()
  await headRef.update({ generation: 2, headRevisionId: replacementId })
  await page.setOfflineMode(false)
  const dirtyReopen = await page.evaluate(async (boardId) => {
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { boardHistoryStore } = await import('/tests/history-fixture.ts')
    await workspaceApi.loadBoardWithProject(boardId)
    const current = await boardHistoryStore.getCommittedContent(boardId)
    return { status: current.document.syncStatus, generation: current.document.cloudGeneration,
      x: current.document.scene.elements[0].x, notes: current.notes, outbox: await boardHistoryStore.listOutbox(boardId) }
  }, result.boardId)
  assert.equal(dirtyReopen.status, 'conflict')
  assert.equal(dirtyReopen.generation, originalHead.generation)
  assert.equal(dirtyReopen.x, 430, 'legacy replacement reopening preserves unsynced local scene')
  assert.equal(dirtyReopen.notes['legacy-slide'], result.note.text)
  assert.ok(dirtyReopen.outbox.some((entry) => entry.localVersionId === dirtyId && !entry.receipt && !entry.headAcknowledged), 'legacy replacement must not discard pending history capture')
  await headRef.update({ generation: originalHead.generation, headRevisionId: originalHead.headRevisionId })
  result.rebound = await page.evaluate(async ({ boardId, revisionId }) => {
    const { boardHistoryStore } = await import('/tests/history-fixture.ts')
    await boardHistoryStore.bindCloudLineage(boardId, { generation: 3, restoreFence: 5,
      currentVersionId: 'future-migration-baseline', cloudRevisionId: revisionId })
    return boardHistoryStore.listOutbox(boardId)
  }, result)
  assert.equal(result.rebound.length, result.outbox.length + 1)
  assert.ok(result.rebound.every((entry) => entry.generation === 3 && entry.expectedFence === 5 && entry.sourceBaseVersionId === 'future-migration-baseline' && !entry.receipt))
  assert.ok(calls.includes('ensureBoardScene') && calls.includes('commitBoardScene') && calls.includes('slideNotes'))
  assert.ok(!calls.some((name) => ['boardHistory', 'importBoardVersion', 'updateBoardContent', 'restoreBoardVersion'].includes(name)), 'old runtime must receive no unavailable history calls')
  assert.deepEqual(errors, [])
  console.log('PASS pinned legacy functions/rules: create/scene/name/notes sync, known-note hydration, stale-generation rejection, fresh-head incomplete-protocol-1 fail-closed, dirty-generation reopen retains scene/notes/captures, no history API calls, later lineage binding')
} finally {
  await writeFile(`${process.env.E2E_ARTIFACT_DIR || '.system_generated/regression'}/network.json`, JSON.stringify({ calls, errors }, null, 2))
  await browser.close()
  await deleteApp(admin)
}
