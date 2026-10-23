import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import puppeteer from 'puppeteer-core'

if (
  process.env.GCLOUD_PROJECT !== 'demo-regression' ||
  !process.env.FIRESTORE_EMULATOR_HOST ||
  !process.env.FIREBASE_DATABASE_EMULATOR_HOST
)
  throw new Error('Tombstone compaction E2E requires the isolated demo-regression emulators.')

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getAuth } = require('firebase-admin/auth')
const { getDatabase } = require('firebase-admin/database')
const { getFirestore } = require('firebase-admin/firestore')
const { loadSceneRevision } = await import('../functions/lib/board-scenes.js')
const { manifestDigest, packScene, SCENE_PROTOCOL_VERSION } = await import('../functions/lib/scene-codec.js')
const projectId = 'demo-regression'
const boardId = `tombstone-compaction-${Date.now().toString(36)}`
const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190'
const boardUrl = `${baseUrl}/boards/${boardId}`
const adminApp = initializeApp({
  projectId,
  databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${projectId}`,
})
const adminAuth = getAuth(adminApp)
const adminDb = getFirestore(adminApp)
const adminRtdb = getDatabase(adminApp)
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
})

async function waitFor(check, message, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(message)
}

async function revisionPayloadBytes(head) {
  const revision = (await adminDb.doc(`boardScenes/${boardId}/revisions/${head.headRevisionId}`).get()).data()
  let bytes = 0
  for (let pageIndex = 0; pageIndex < revision.pageCount; pageIndex++) {
    const page = (
      await adminDb
        .doc(`boardScenes/${boardId}/revisions/${head.headRevisionId}/pages/${String(pageIndex).padStart(6, '0')}`)
        .get()
    ).data()
    for (const reference of page.references) {
      const chunk = (await adminDb.doc(`boardScenes/${boardId}/chunks/${reference.chunkId}`).get()).data()
      bytes += Buffer.byteLength(chunk.payload)
    }
  }
  return bytes
}

async function tryCreateUpload(id, head, uid, maintenanceEpoch, documentId, token) {
  const now = new Date().toISOString()
  const fields = {
    uploaderUid: { stringValue: uid }, expectedHeadRevisionId: { stringValue: head.headRevisionId },
    generation: { integerValue: String(head.generation) }, expectedFence: { integerValue: String(head.restoreFence ?? 0) },
    maintenanceEpoch: { integerValue: String(maintenanceEpoch) }, sceneFormatVersion: { integerValue: '1' },
    pageCount: { integerValue: '1' }, chunkCount: { integerValue: '1' }, newChunkCount: { integerValue: '0' },
    candidateDigest: { stringValue: 'a'.repeat(64) }, createdAt: { timestampValue: now },
    expiresAt: { timestampValue: new Date(Date.now() + 60_000).toISOString() },
  }
  const response = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-regression/databases/(default)/documents/boardScenes/${id}/uploads?documentId=${documentId}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  const result = await response.json().catch(() => null)
  return response.ok ? 'unexpected-success' : result?.error?.status ?? `http-${response.status}`
}

async function tryCreateChunk(id, commitId, chunkId, payload, digest, uid, generation, token, slot = 0) {
  const response = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-regression/databases/(default)/documents/boardScenes/${id}/chunks?documentId=${chunkId}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: {
      payload: { stringValue: payload }, digest: { stringValue: digest }, uploadId: { stringValue: commitId },
      slot: { integerValue: String(slot) }, uploaderUid: { stringValue: uid }, generation: { integerValue: String(generation) },
      kind: { stringValue: 'records' },
    } }),
  })
  const result = await response.json().catch(() => null)
  return response.ok ? 'unexpected-success' : result?.error?.status ?? `http-${response.status}`
}

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  page.setDefaultTimeout(30_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })

  const owner = await page.evaluate(async (id) => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner, seedSharedBoard } = await import('/tests/regression-fixture.ts')
    const auth = getFirebaseAuth()
    const credential = await signInOwner(auth)
    const config = {
      boardId: id,
      boardName: 'Tombstone compaction E2E',
      ownerId: credential.user.uid,
      generalAccess: 'anyone_with_link',
      generalRole: 'editor',
      invitedEmails: [],
      collaborators: {},
      scene: { elements: [], appState: { viewBackgroundColor: '#ffffff' } },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await seedSharedBoard(config)
    return { uid: credential.user.uid, shareConfig: config }
  }, boardId)

  await page.evaluate(({ id, shareConfig }) => {
    localStorage.setItem('agentic-whiteboard:library:v1', '[]')
    localStorage.setItem(`agentic-whiteboard:share:${id}`, JSON.stringify(shareConfig))
  }, { id: boardId, shareConfig: owner.shareConfig })
  await page.goto(boardUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.excalidraw')
  await page.waitForFunction(() => Boolean(window.__excalidrawAPI && window.__collab))
  await page.waitForFunction(() => window.__lazyCollab?.activeSessions?.length === 1, { timeout: 65_000 })

  // Lazy collaboration starts only when a second editor opens the board.
  const collaboratorPage = await browser.newPage()
  await collaboratorPage.goto(boardUrl, { waitUntil: 'domcontentloaded' })
  await collaboratorPage.waitForSelector('.excalidraw')
  const sessionIds = await Promise.all([
    page.evaluate(() => window.__collab.collabUser.sessionId),
    collaboratorPage.evaluate(() => window.__collab.collabUser.sessionId),
  ])
  const staleSession = await waitFor(async () => {
    for (const sessionId of sessionIds) {
      const connectionEpoch = (await adminRtdb.ref(`system/sceneConnectionEpochs/${boardId}/${sessionId}/token`).get()).val()
      if (typeof connectionEpoch === 'string') return { sessionId, connectionEpoch }
    }
    return null
  }, `Neither board tab received a server connection epoch (sessionIds=${JSON.stringify(sessionIds)}).`, 30_000)
  await page.bringToFront()
  await page.waitForFunction(() => window.__collab?.isEditor && !window.__collab?.isSpectator)

  const drawTarget = await page.evaluate(() => {
    const api = window.__excalidrawAPI
    const previousIds = api.getSceneElements().map((element) => element.id)
    const canvas = document.querySelector('canvas')
    if (!canvas) throw new Error('Canvas not mounted.')
    const bounds = canvas.getBoundingClientRect()
    const x = bounds.left + 440
    const y = bounds.top + 340
    return { previousIds, x, y }
  })
  await page.keyboard.press('r')
  await page.mouse.move(drawTarget.x, drawTarget.y)
  await page.mouse.down()
  await page.mouse.move(drawTarget.x + 120, drawTarget.y + 80, { steps: 5 })
  await page.mouse.up()
  await page.waitForFunction(
    (ids) => window.__excalidrawAPI.getSceneElements().some((element) => !ids.includes(element.id)),
    {},
    drawTarget.previousIds,
  )
  const undoShapeId = await page.evaluate((ids) =>
    window.__excalidrawAPI.getSceneElements().find((element) => !ids.includes(element.id)).id,
  drawTarget.previousIds)

  await page.keyboard.press('Delete')
  await page.waitForFunction((id) => {
    const elements = window.__excalidrawAPI.getSceneElementsIncludingDeleted()
    return elements.some((element) => element.id === id && element.isDeleted)
  }, {}, undoShapeId)
  await page.keyboard.down('Meta')
  await page.keyboard.press('z')
  await page.keyboard.up('Meta')
  await page.waitForFunction((id) =>
    window.__excalidrawAPI.getSceneElements().some((element) => element.id === id && !element.isDeleted),
  {}, undoShapeId)
  console.log('Verified undo restores the deleted element while its board tab remains open')

  const beforeFinalDelete = await page.evaluate(() => window.__excalidrawAPI.getSceneElements().map((element) => element.id))
  await page.keyboard.press('r')
  await page.mouse.move(drawTarget.x + 250, drawTarget.y + 180)
  await page.mouse.down()
  await page.mouse.move(drawTarget.x + 360, drawTarget.y + 250, { steps: 5 })
  await page.mouse.up()
  await page.waitForFunction(
    (ids) => window.__excalidrawAPI.getSceneElements().some((element) => !ids.includes(element.id)),
    {},
    beforeFinalDelete,
  )
  const shapeId = await page.evaluate((ids) =>
    window.__excalidrawAPI.getSceneElements().find((element) => !ids.includes(element.id)).id,
  beforeFinalDelete)
  await page.keyboard.press('Delete')
  await page.waitForFunction((id) =>
    window.__excalidrawAPI.getSceneElementsIncludingDeleted().some((element) => element.id === id && element.isDeleted),
  {}, shapeId)

  const receipt = await page.evaluate(async (id) => {
    const { sceneService } = await import('/src/features/scenes/scene-service.ts')
    const current = await sceneService.load(id)
    const elements = window.__excalidrawAPI.getSceneElementsIncludingDeleted()
    return sceneService.commit(id, { ...current.scene, elements }, { expectedGeneration: current.generation })
  }, boardId)
  const session = { uid: owner.uid, ...staleSession }

  const historical = await waitFor(async () => {
    const head = (await adminDb.doc(`boardScenes/${boardId}`).get()).data()
    if (!head?.headRevisionId) return null
    const scene = (await loadSceneRevision(boardId, head)).scene
    if (!scene.elements.some((element) => element.id === shapeId && element.isDeleted)) return null
    return { head, scene }
  }, 'The full tombstone was not committed before disconnect.', 60_000)
  const maintenanceEpochBeforeCompaction = historical.head.maintenanceEpoch ?? 1
  const ownerIdToken = await page.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    return getFirebaseAuth().currentUser.getIdToken()
  })
  const stagedUploadId = `pending_before_compaction_${Date.now().toString(36)}`
  const packedBeforeCompaction = await packScene(historical.scene)
  const stagedChunks = packedBeforeCompaction.map((chunk, slot) => ({
    ...chunk, chunkId: `${stagedUploadId}_${String(slot).padStart(6, '0')}`, slot,
  }))
  const stagedReferences = stagedChunks.map(({ chunkId, digest }) => ({ chunkId, digest }))
  const stagedCandidateDigest = await manifestDigest(stagedReferences, historical.head.generation)
  const candidateFields = {
    uploaderUid: { stringValue: owner.uid }, expectedHeadRevisionId: { stringValue: historical.head.headRevisionId },
    generation: { integerValue: String(historical.head.generation) }, expectedFence: { integerValue: String(historical.head.restoreFence ?? 0) },
    maintenanceEpoch: { integerValue: String(maintenanceEpochBeforeCompaction) }, sceneFormatVersion: { integerValue: '1' },
    pageCount: { integerValue: '1' }, chunkCount: { integerValue: String(stagedChunks.length) }, newChunkCount: { integerValue: String(stagedChunks.length) },
    candidateDigest: { stringValue: stagedCandidateDigest }, createdAt: { timestampValue: new Date().toISOString() },
    expiresAt: { timestampValue: new Date(Date.now() + 60 * 60_000).toISOString() },
  }
  const uploadUrl = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-regression/databases/(default)/documents/boardScenes/${boardId}/uploads`
  const stagedCandidateResponse = await fetch(`${uploadUrl}?documentId=${stagedUploadId}`, {
    method: 'POST', headers: { Authorization: `Bearer ${ownerIdToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: candidateFields }),
  })
  assert.equal(stagedCandidateResponse.status, 200, 'a valid upload can be staged before compaction begins')
  const stagedPageResponse = await fetch(`${uploadUrl}/${stagedUploadId}/pages?documentId=000000`, {
    method: 'POST', headers: { Authorization: `Bearer ${ownerIdToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { references: { arrayValue: { values: stagedReferences.map((reference) => ({
      mapValue: { fields: { chunkId: { stringValue: reference.chunkId }, digest: { stringValue: reference.digest } } },
    })) } } } }),
  })
  assert.equal(stagedPageResponse.status, 200, 'the pending upload manifest is staged before compaction')
  for (const chunk of stagedChunks) {
    const stagedChunk = await tryCreateChunk(
      boardId, stagedUploadId, chunk.chunkId, chunk.payload, chunk.digest, owner.uid,
      historical.head.generation, ownerIdToken, chunk.slot,
    )
    assert.equal(stagedChunk, 'unexpected-success', 'the complete candidate chunk is staged before compaction')
  }
  const bytesBeforeCompaction = await revisionPayloadBytes(historical.head)
  assert.equal((historical.scene.deletionLedger ?? []).some((entry) => entry.id === shapeId && entry.compacted), false)
  console.log('Verified the active session retains the full tombstone in the committed scene')

  await collaboratorPage.close()
  await page.close()
  // Chromium page close does not consistently deliver every RTDB onDisconnect
  // in the emulator. Clear the now-abandoned generation, then emit one explicit
  // deleted session leaf so the real onValueDeleted compaction trigger runs.
  const generationPresence = adminRtdb.ref(`presence/${boardId}/generations/${historical.head.generation}`)
  const emulatorLeftoverSessions = (await generationPresence.get()).val()
  if (emulatorLeftoverSessions) console.log(`Clearing emulator leftovers after browser close: ${Object.keys(emulatorLeftoverSessions).join(', ')}`)
  await generationPresence.remove()
  const activeSessions = adminRtdb.ref(`activeSessions/${boardId}`)
  const emulatorLeftoverActiveSessions = (await activeSessions.get()).val()
  if (emulatorLeftoverActiveSessions) console.log(`Clearing stale emulator lobby sessions: ${Object.keys(emulatorLeftoverActiveSessions).join(', ')}`)
  await activeSessions.remove()
  const triggerProbe = generationPresence.child('emulator-compaction-trigger')
  await triggerProbe.set({ uid: owner.uid, connectionEpoch: 'emulator-probe' })
  await triggerProbe.remove()
  const gateProbe = await browser.newPage()
  await gateProbe.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await gateProbe.evaluate(async ({ id, token, shareConfig }) => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwnerWithToken } = await import('/tests/regression-fixture.ts')
    await signInOwnerWithToken(getFirebaseAuth(), token)
    localStorage.setItem('agentic-whiteboard:library:v1', '[]')
    localStorage.setItem(`agentic-whiteboard:share:${id}`, JSON.stringify(shareConfig))
  }, { id: boardId, token: await adminAuth.createCustomToken(owner.uid), shareConfig: owner.shareConfig })
  let closedFence
  try {
    closedFence = await waitFor(async () => {
    const [head, control] = await Promise.all([
      adminDb.doc(`boardScenes/${boardId}`).get(),
      adminDb.doc(`boardScenes/${boardId}/maintenance/control`).get(),
    ])
    const headData = head.data(), controlData = control.data()
    if (headData?.maintenanceAdmission !== 'closed' || controlData?.admission !== 'closed') return null
    return { head: headData, control: controlData }
    }, 'Compaction never closed Firestore admission before pruning.', 120_000)
  } catch (error) {
    const [head, control, presence, activeSessions, maintenance] = await Promise.all([
      adminDb.doc(`boardScenes/${boardId}`).get(),
      adminDb.doc(`boardScenes/${boardId}/maintenance/control`).get(),
      adminRtdb.ref(`presence/${boardId}`).get(),
      adminRtdb.ref(`activeSessions/${boardId}`).get(),
      adminRtdb.ref(`system/sceneMaintenance/${boardId}`).get(),
    ])
    throw new Error(`${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify({ head: head.data(), control: control.data(), presence: presence.val(), activeSessions: activeSessions.val(), maintenance: maintenance.val() })}`, { cause: error })
  }
  assert.equal(closedFence.head.maintenanceEpoch, closedFence.control.epoch)
  assert.equal(closedFence.control.abandonedRoomOwner?.length > 0, true)
  const gateProbeToken = await gateProbe.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    return getFirebaseAuth().currentUser.getIdToken()
  })
  const blockedDuringPrune = await tryCreateUpload(
    boardId, closedFence.head, owner.uid, closedFence.head.maintenanceEpoch, 'fresh-editor-race', gateProbeToken,
  )
  assert.ok(['permission-denied', 'firestore/permission-denied', 'PERMISSION_DENIED'].includes(blockedDuringPrune),
    `Firestore upload must be denied while compaction is pruning: ${blockedDuringPrune}`)
  const compacted = await waitFor(async () => {
    const head = (await adminDb.doc(`boardScenes/${boardId}`).get()).data()
    if (!head?.headRevisionId || head.headRevisionId === historical.head.headRevisionId) return null
    const control = (await adminDb.doc(`boardScenes/${boardId}/maintenance/control`).get()).data()
    const scene = (await loadSceneRevision(boardId, head)).scene
    const deletion = scene.deletionLedger.find((entry) => entry.id === shapeId)
    if (!deletion?.compacted || scene.elements.some((element) => element.id === shapeId)) return null
    const gate = (await adminRtdb.ref(`system/sceneMaintenance/${boardId}`).get()).val()
    if (gate?.admissionClosed || head.maintenanceAdmission !== 'open' || control?.admission !== 'open') return null
    return { head, scene, control }
  }, 'The final-session disconnect did not produce a compacted scene head.', 150_000)
  assert.equal(compacted.head.maintenanceEpoch, maintenanceEpochBeforeCompaction + 1,
    'closing the shared Firestore fence advances the epoch and permanently fences in-flight uploads')
  assert.equal(compacted.control.epoch, compacted.head.maintenanceEpoch)
  const staleUploadAfterReopen = await tryCreateUpload(
    boardId, compacted.head, owner.uid, maintenanceEpochBeforeCompaction, 'stale-before-compaction', gateProbeToken,
  )
  assert.ok(['permission-denied', 'firestore/permission-denied', 'PERMISSION_DENIED'].includes(staleUploadAfterReopen),
    `An upload from before compaction must remain fenced after reopen: ${staleUploadAfterReopen}`)
  await adminDb.doc(`boardScenes/${boardId}/uploads/${stagedUploadId}`).update({
    expectedHeadRevisionId: compacted.head.headRevisionId,
    sceneProtocolVersion: SCENE_PROTOCOL_VERSION,
  })
  const staleCommitResponse = await fetch('http://127.0.0.1:45001/demo-regression/us-central1/commitBoardScene', {
    method: 'POST', headers: { Authorization: `Bearer ${gateProbeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { boardId, commitId: stagedUploadId, sceneProtocolVersion: SCENE_PROTOCOL_VERSION } }),
  })
  assert.equal(staleCommitResponse.ok, false, 'a pre-staged candidate cannot commit after the maintenance epoch advances')
  const staleCommitBody = await staleCommitResponse.json().catch(() => null)
  assert.equal(staleCommitBody?.error?.status, 'ABORTED',
    `The complete pre-staged candidate must fail specifically at the maintenance/head fence: ${JSON.stringify(staleCommitBody)}`)
  await gateProbe.close()
  assert.equal(compacted.scene.deletionLedger.find((entry) => entry.id === shapeId).compacted, true)
  assert(
    (await revisionPayloadBytes(compacted.head)) < bytesBeforeCompaction,
    'compaction must reduce the persisted scene payload bytes',
  )
  const historicalScene = await loadSceneRevision(boardId, historical.head)
  assert.equal(historicalScene.scene.elements.find((element) => element.id === shapeId)?.isDeleted, true)
  console.log('Verified the real abandoned-room trigger compacts the tombstone and retains the historical revision')

  const customToken = await adminAuth.createCustomToken(owner.uid)
  const reopened = await browser.newPage()
  await reopened.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await reopened.evaluate(async ({ id, token, shareConfig }) => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwnerWithToken } = await import('/tests/regression-fixture.ts')
    await signInOwnerWithToken(getFirebaseAuth(), token)
    localStorage.setItem('agentic-whiteboard:library:v1', '[]')
    localStorage.setItem(`agentic-whiteboard:share:${id}`, JSON.stringify(shareConfig))
  }, { id: boardId, token: customToken, shareConfig: owner.shareConfig })
  await reopened.goto(boardUrl, { waitUntil: 'domcontentloaded' })
  await reopened.waitForSelector('.excalidraw')
  await reopened.waitForFunction(() => Boolean(window.__excalidrawAPI))
  await reopened.waitForFunction((id) =>
    !window.__excalidrawAPI.getSceneElementsIncludingDeleted().some((element) => element.id === id),
  {}, shapeId)
  const staleReplay = await reopened.evaluate(async ({ id, session, elementId }) => {
    const { replayRegressionSession } = await import('/tests/regression-fixture.ts')
    return replayRegressionSession(id, session.sessionId, session.uid, session.connectionEpoch, elementId)
  }, { id: boardId, session, elementId: shapeId })
  assert.ok(staleReplay.every((result) => result === 'PERMISSION_DENIED' || result === 'database/permission-denied'),
    `Old-epoch presence and deltas must be denied after reconnect: ${JSON.stringify(staleReplay)}`)
  assert.deepEqual(errors, [], `Browser had uncaught errors: ${errors.join('; ')}`)
  console.log('Verified a fresh tab loads the compacted scene and stale-epoch presence/delta replay is rejected')
} finally {
  await browser.close().catch(() => {})
  adminRtdb.goOffline()
  await deleteApp(adminApp)
}
