import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { createRequire } from 'node:module'

if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error('Undo session tests require isolated demo-regression emulators.')

const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190'
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp: initializeAdminApp, deleteApp: deleteAdminApp } = require('firebase-admin/app')
const { getAuth: getAdminAuth } = require('firebase-admin/auth')
const adminApp = initializeAdminApp({ projectId: 'demo-regression' }, `undo-reconnect-${Date.now()}`)

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  page.setDefaultTimeout(30_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('dialog', (dialog) => dialog.accept())
  await page.goto(base, { waitUntil: 'domcontentloaded' })

  const boards = await page.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner } = await import('/tests/regression-fixture.ts')
    await signInOwner(getFirebaseAuth())
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const project = await workspaceApi.createProject('Undo session lifecycle E2E')
    const first = await workspaceApi.createBoard(project.id, 'Undo session board')
    const second = await workspaceApi.createBoard(project.id, 'Other board')
    await workspaceApi.flushCloud()
    return { first: first.id, second: second.id, ownerUid: getFirebaseAuth().currentUser.uid }
  })

  const navigateFromWorkspace = async (boardId) => {
    await page.waitForSelector('a[title="Workspace"]')
    await page.click('a[title="Workspace"]')
    await page.waitForFunction(() => location.pathname === '/')
    await page.waitForSelector(`[data-board-id="${boardId}"]`)
    await page.click(`[data-board-id="${boardId}"]`)
    await page.waitForFunction((id) => location.pathname === `/boards/${id}`, {}, boardId)
    await page.waitForFunction(() => Boolean(window.__excalidrawAPI))
  }
  await page.goto(`${base}/boards/${boards.first}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction((id) => location.pathname === `/boards/${id}`, {}, boards.first)
  await page.waitForFunction(() => Boolean(window.__excalidrawAPI))
  console.log('Opened initial board session')
  await page.waitForFunction(() => window.__excalidrawAPI.getSceneElements().length === 0)

  const draw = async () => {
    const before = await page.evaluate(() => window.__excalidrawAPI.getSceneElements().map((element) => element.id))
    await page.keyboard.press('Escape')
    await page.keyboard.press('r')
    await page.mouse.move(310, 280)
    await page.mouse.down()
    await page.mouse.move(430, 360, { steps: 5 })
    await page.mouse.up()
    await page.waitForFunction(
      (oldIds) => window.__excalidrawAPI.getSceneElements().some((element) => !oldIds.includes(element.id)),
      {},
      before,
    )
    return page.evaluate((oldIds) => window.__excalidrawAPI.getSceneElements().find((element) => !oldIds.includes(element.id)).id, before)
  }

  const firstShape = await draw()
  await page.keyboard.down('Meta')
  await page.keyboard.press('z')
  await page.keyboard.up('Meta')
  await page.waitForFunction((id) => !window.__excalidrawAPI.getSceneElements().some((element) => element.id === id && !element.isDeleted), {}, firstShape)
  const shapeAfterUndo = await draw()
  console.log('Verified undo within the active board session')
  await page.evaluate(async () => (await import('/src/features/workspace/workspace-api.ts')).workspaceApi.flushCloud())

  await navigateFromWorkspace(boards.second)
  console.log('Switched to second board')
  await navigateFromWorkspace(boards.first)
  console.log('Returned to original board')
  await page.waitForFunction(
    (id) => window.__excalidrawAPI.getSceneElements().some((element) => element.id === id && !element.isDeleted),
    {},
    shapeAfterUndo,
  )
  await page.keyboard.down('Meta')
  await page.keyboard.press('z')
  await page.keyboard.up('Meta')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert(
    await page.evaluate((id) => window.__excalidrawAPI.getSceneElements().some((element) => element.id === id && !element.isDeleted), shapeAfterUndo),
    'undo history from the previous board session must not affect the re-opened board',
  )
  const shapeBeforeDisconnect = await draw()
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await new Promise((resolve) => setTimeout(resolve, 250))
  await page.keyboard.down('Meta')
  await page.keyboard.press('z')
  await page.keyboard.up('Meta')
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert(
    await page.evaluate((id) => window.__excalidrawAPI.getSceneElements().some((element) => element.id === id && !element.isDeleted), shapeBeforeDisconnect),
    'undo history must be cleared when the tab loses network connectivity',
  )
  console.log('Verified network disconnect ends the active tab undo session')

  // A connected peer advances the committed head while this tab is genuinely
  // offline. On reconnect, the first tab must reload that head before editing.
  await page.setOfflineMode(true)
  await page.waitForFunction(() => navigator.onLine === false)
  const customToken = await getAdminAuth(adminApp).createCustomToken(boards.ownerUid)
  const peerContext = await browser.createBrowserContext()
  const peer = await peerContext.newPage()
  await peer.goto(base, { waitUntil: 'domcontentloaded' })
  const remoteHead = await peer.evaluate(async ({ boardId, elementId, customToken }) => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwnerWithToken } = await import('/tests/regression-fixture.ts')
    await signInOwnerWithToken(getFirebaseAuth(), customToken)
    const { sceneService } = await import('/src/features/scenes/scene-service.ts')
    const current = await sceneService.load(boardId)
    const target = current.scene.elements.find((element) => element.id === elementId)
    if (!target) throw new Error('Expected test element is missing from canonical scene.')
    const nextX = target.x + 256
    const elements = current.scene.elements.map((element) =>
      element.id === elementId
        ? { ...element, x: nextX, version: Number(element.version ?? 1) + 1, versionNonce: Number(element.versionNonce ?? 0) + 1 }
        : element,
    )
    await sceneService.commit(boardId, { ...current.scene, elements }, { expectedGeneration: current.generation })
    return { elementId, x: nextX }
  }, { boardId: boards.first, elementId: shapeAfterUndo, customToken })
  await page.setOfflineMode(false)
  await page.waitForFunction(
    ({ elementId, x }) => window.__excalidrawAPI.getSceneElements().some((element) => element.id === elementId && element.x === x),
    {},
    remoteHead,
  )
  await peerContext.close()
  console.log('Verified reconnect refreshes the latest committed scene before accepting edits')
  assert.deepEqual(errors, [], 'browser has no uncaught errors')
  console.log('PASS active-tab undo works; switching boards ends that board undo session')
} finally {
  await browser.close()
  await deleteAdminApp(adminApp)
}
