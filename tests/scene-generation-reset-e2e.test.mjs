/** Browser-to-emulator contract for restoring an immutable scene version. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'

if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error('Generation-reset E2E requires isolated demo-regression emulators.')

const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { getDatabase } = require('firebase-admin/database')
const adminApp = initializeApp({ projectId: 'demo-regression', databaseURL: 'https://demo-regression.firebaseio.com' })
const db = getFirestore()
const rtdb = getDatabase()
const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190'
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})

try {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  page.setDefaultTimeout(45000)
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  const fixture = await page.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner } = await import('/tests/regression-fixture.ts')
    const { user } = await signInOwner(getFirebaseAuth())
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { sceneService } = await import('/src/features/scenes/scene-service.ts')
    const project = await workspaceApi.createProject('Generation reset E2E')
    const board = await workspaceApi.createBoard(project.id, 'Generation reset fixture')
    const original = {
      elements: [{ id: 'restore-target', type: 'rectangle', x: 111, y: 123, width: 80, height: 60,
        angle: 0, strokeColor: '#000000', backgroundColor: 'transparent', fillStyle: 'solid',
        strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null,
        roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null,
        updated: Date.now(), link: null, locked: false }],
      appState: { viewBackgroundColor: '#ffffff' },
    }
    await workspaceApi.saveBoard({ ...board, scene: original })
    await workspaceApi.flushCloud()
    const version = await sceneService.createNamedVersion(board.id, 'Restore target')
    const changed = { elements: [{ ...original.elements[0], x: 987, version: 2, versionNonce: 2 }], appState: original.appState }
    const current = await workspaceApi.loadBoard(board.id)
    await workspaceApi.saveBoard({ ...current, scene: changed })
    await workspaceApi.flushCloud()
    const operationId = `browser-reset-${crypto.randomUUID()}`
    const result = await sceneService.restoreNamedVersion(board.id, version.versionId, operationId)
    return { boardId: board.id, versionId: version.versionId, operationId, result }
  })

  assert.equal(fixture.result.phase, 'activated')
  assert.equal(fixture.result.status, 'complete')
  const head = (await db.doc(`boardScenes/${fixture.boardId}`).get()).data()
  assert.equal(head.generation, 2, 'Restore publishes a monotonically increasing generation')
  assert.equal(head.headRevisionId, fixture.result.revisionId)
  const job = (await db.doc(`boardScenes/${fixture.boardId}/maintenanceJobs/${fixture.operationId}`).get()).data()
  assert.equal(job.phase, 'activated')
  assert.equal(job.status, 'complete')
  const transition = (await db.doc(`boardScenes/${fixture.boardId}/maintenance/control`).get()).data()
  assert.equal(transition.admission, 'open', 'Firestore admission reopens after activation')
  const roomGeneration = (await rtdb.ref(`boards/${fixture.boardId}/generation`).get()).val()
  const gate = (await rtdb.ref(`system/sceneMaintenance/${fixture.boardId}`).get()).val()
  assert.equal(gate.admissionClosed, false, 'RTDB admission reopens after activation')
  assert.equal(roomGeneration, 2)

  await page.goto(`${base}/boards/${fixture.boardId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => window.__excalidrawAPI?.getSceneElements().some((element) => element.id === 'restore-target'),
    { polling: 100 },
  )
  const visibleX = await page.evaluate(() => {
    const element = window.__excalidrawAPI.getSceneElements().find((item) => item.id === 'restore-target')
    return element.x
  })
  assert.equal(visibleX, 111, 'Cold-loaded canvas matches the selected historical snapshot')

  assert.deepEqual(pageErrors, [], 'Browser has no uncaught errors during restore and reload')
  console.log('PASS browser restore publishes and cold-loads the named canvas at generation 2')

  const deferredFixture = await page.evaluate(async () => {
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { sceneService } = await import('/src/features/scenes/scene-service.ts')
    const project = await workspaceApi.createProject('Generation reset deferral E2E')
    const board = await workspaceApi.createBoard(project.id, 'Active room deferral fixture')
    const oldScene = { elements: [{ id: 'deferred-target', type: 'rectangle', x: 21, y: 34, width: 50, height: 45,
      angle: 0, strokeColor: '#000000', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
      strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 2,
      version: 1, versionNonce: 3, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false }],
      appState: { viewBackgroundColor: '#ffffff' } }
    await workspaceApi.saveBoard({ ...board, scene: oldScene })
    await workspaceApi.flushCloud()
    const version = await sceneService.createNamedVersion(board.id, 'Before active room')
    const current = await workspaceApi.loadBoard(board.id)
    await workspaceApi.saveBoard({ ...current, scene: { ...oldScene, elements: [{ ...oldScene.elements[0], x: 900, version: 2, versionNonce: 4 }] } })
    await workspaceApi.flushCloud()
    return { boardId: board.id, versionId: version.versionId, operationId: `deferred-reset-${crypto.randomUUID()}` }
  })
  const sessionPath = `activeSessions/${deferredFixture.boardId}/active-e2e-session`
  await rtdb.ref(sessionPath).set({ uid: 'simulated-collaborator', sessionId: 'active-e2e-session' })
  const deferred = await page.evaluate(async ({ boardId, versionId, operationId }) => {
    const { sceneService } = await import('/src/features/scenes/scene-service.ts')
    return sceneService.restoreNamedVersion(boardId, versionId, operationId)
  }, deferredFixture)
  assert.equal(deferred.status, 'deferred', 'Active collaboration blocks generation reset without losing its operation')
  assert.equal(deferred.phase, 'prepared')
  const heldHead = (await db.doc(`boardScenes/${deferredFixture.boardId}`).get()).data()
  assert.equal(heldHead.generation, 1, 'Deferred restore leaves the live generation unchanged')
  await rtdb.ref(sessionPath).remove()
  const resumed = await page.evaluate(async ({ boardId, versionId, operationId }) => {
    const { sceneService } = await import('/src/features/scenes/scene-service.ts')
    return sceneService.restoreNamedVersion(boardId, versionId, operationId)
  }, deferredFixture)
  assert.equal(resumed.phase, 'activated', 'Same operation resumes after the active session ends')
  assert.equal(resumed.status, 'complete')
  assert.equal((await db.doc(`boardScenes/${deferredFixture.boardId}`).get()).data().generation, 2)
  const retry = await page.evaluate(async ({ boardId, versionId, operationId }) => {
    const { sceneService } = await import('/src/features/scenes/scene-service.ts')
    const repeated = await sceneService.restoreNamedVersion(boardId, versionId, operationId)
    const restored = await sceneService.loadNamedVersion(boardId, versionId)
    return { repeated, restoredX: restored.scene.elements[0].x }
  }, deferredFixture)
  assert.equal(retry.repeated.status, 'complete', 'Completed operation retries return the same receipt')
  assert.equal(retry.restoredX, 21, 'Deferred restore eventually reproduces the selected historical canvas')
  console.log('PASS browser restore defers for an active collaboration session and resumes idempotently after disconnect')
  await context.close()
} finally {
  await browser.close()
  await db.terminate()
  await deleteApp(adminApp)
}
