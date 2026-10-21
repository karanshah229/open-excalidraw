import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
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
  assert.equal((historical.scene.deletionLedger ?? []).some((entry) => entry.id === shapeId && entry.compacted), false)
  console.log('Verified the active session retains the full tombstone in the committed scene')

  await collaboratorPage.close()
  await page.close()
  const compacted = await waitFor(async () => {
    const head = (await adminDb.doc(`boardScenes/${boardId}`).get()).data()
    if (!head?.headRevisionId || head.headRevisionId === historical.head.headRevisionId) return null
    const scene = (await loadSceneRevision(boardId, head)).scene
    const deletion = scene.deletionLedger.find((entry) => entry.id === shapeId)
    if (!deletion?.compacted || scene.elements.some((element) => element.id === shapeId)) return null
    const gate = (await adminRtdb.ref(`system/sceneMaintenance/${boardId}`).get()).val()
    if (gate?.admissionClosed) return null
    return { head, scene }
  }, 'The final-session disconnect did not produce a compacted scene head.', 150_000)
  assert.equal(compacted.scene.deletionLedger.find((entry) => entry.id === shapeId).compacted, true)
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
