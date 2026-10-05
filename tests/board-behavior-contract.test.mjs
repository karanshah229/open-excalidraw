import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const base = process.env.E2E_BASE_URL || 'http://localhost:15190'
const require = createRequire(new URL('../functions/package.json', import.meta.url))
const { initializeApp } = require('firebase-admin/app')
const { getAuth } = require('firebase-admin/auth')
if (process.env.GCLOUD_PROJECT !== 'demo-regression' || !process.env.FIREBASE_AUTH_EMULATOR_HOST)
  throw new Error('Behavior contract tests require isolated demo-regression emulators')
const admin = initializeApp({ projectId: 'demo-regression' }, 'behavior-contract')
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const results = []
const output = process.env.E2E_ARTIFACT_DIR || '.system_generated/behavior-contract'
await mkdir(output, { recursive: true })
const imageData =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII='
const imagePath = `${output}/contract-image.png`
await writeFile(imagePath, Buffer.from(imageData.split(',')[1], 'base64'))
async function open(context, path = '') {
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  await page.setViewport({ width: 1400, height: 1000 })
  await page.evaluateOnNewDocument(() => {
    delete window.showOpenFilePicker
    localStorage.setItem('agentic-whiteboard:library:v1', '[]')
  })
  await page.goto(new URL(path, base).href)
  return page
}
async function clickText(page, text, selector = 'button,[role="menuitem"]') {
  await page.waitForFunction(
    (text, selector) =>
      [...document.querySelectorAll(selector)].some((n) => n.textContent.trim() === text && !n.disabled),
    {},
    text,
    selector,
  )
  await page.evaluate(
    (text, selector) =>
      [...document.querySelectorAll(selector)].find((n) => n.textContent.trim() === text && !n.disabled).click(),
    text,
    selector,
  )
}
async function draw(page, x = 300, y = 300) {
  await page.click('[data-testid="toolbar-rectangle"]')
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 140, y + 100)
  await page.mouse.up()
  await page.waitForFunction(() => window.__excalidrawAPI.getSceneElements().some((el) => !el.isDeleted))
}
async function closeTab(page) {
  const closed = new Promise((resolve) => page.once('close', resolve))
  await page.close({ runBeforeUnload: true })
  await closed
}
async function insertImage(page) {
  const chooser = page.waitForFileChooser()
  await page.click('[data-testid="toolbar-image"]')
  await (await chooser).accept([imagePath])
  await page.waitForFunction(() => Boolean(window.__excalidrawAPI.getAppState().pendingImageElementId))
  await page.waitForFunction(() => Object.values(window.__excalidrawAPI.getFiles()).some((file) => file.dataURL))
  await page.mouse.click(650, 350)
  await page.waitForFunction(() =>
    window.__excalidrawAPI
      .getSceneElements()
      .some((e) => e.type === 'image' && e.fileId && window.__excalidrawAPI.getFiles()[e.fileId]?.dataURL),
  )
  return page.evaluate(() => window.__excalidrawAPI.getSceneElements().find((e) => e.type === 'image').fileId)
}
async function ownerBoard(page) {
  return page.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner } = await import('/tests/regression-fixture.ts')
    await signInOwner(getFirebaseAuth())
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const project = await workspaceApi.createProject('Behavior contract')
    const board = await workspaceApi.createBoard(project.id, 'Contract board')
    await workspaceApi.flushCloud()
    return board.id
  })
}
async function share(page) {
  await page.click('button[title="Share board"]')
  await page.waitForSelector('.google-share-dialog')
}
async function mode(page, readOnly) {
  await page.waitForFunction(
    (readOnly) =>
      Boolean(document.querySelector('.excalidraw')) &&
      !document.querySelector('.access-denied-card') &&
      window.__excalidrawAPI?.getAppState().viewModeEnabled === readOnly,
    {},
    readOnly,
  )
}
async function shareSettled(page) {
  await page.waitForFunction(() => {
    const done = document.querySelector('.google-share-dialog .google-share-done-btn')
    return done && !done.disabled && !document.querySelector('.google-share-error-message')
  })
}
async function closeShare(page) {
  await shareSettled(page)
  await page.click('.google-share-dialog .google-share-done-btn')
  await page.waitForSelector('.google-share-dialog', { hidden: true })
}
async function run(name, work) {
  if (process.env.CONTRACT_SCENARIO && process.env.CONTRACT_SCENARIO !== name) return
  try {
    await work()
    results.push({ name, status: 'passed' })
    console.log(`PASS: ${name}`)
  } catch (error) {
    for (const [index, page] of (await browser.pages()).entries()) {
      await writeFile(
        `${output}/${name}-${index}.txt`,
        await page.evaluate(() => document.body.innerText).catch(() => 'closed'),
      )
      await page.screenshot({ path: `${output}/${name}-${index}.png` }).catch(() => {})
    }
    results.push({ name, status: 'failed', error: error.stack })
    console.error(`FAIL: ${name}: ${error.message}`)
    process.exitCode = 1
  }
}
try {
  await run('framed-scene-reload', async () => {
    const context = await browser.createBrowserContext()
    const page = await open(context)
    const fixture = await page.evaluate(async () => {
      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
      const { convertToExcalidrawElements } = await import('/tests/frame-reload-fixture.ts')
      const project = await workspaceApi.createProject('Local framed diagram')
      const board = await workspaceApi.createBoard(project.id, 'Framed diagram')
      const elements = convertToExcalidrawElements(
        [
          {
            type: 'rectangle',
            id: 'framed-box',
            x: 100,
            y: 120,
            width: 160,
            height: 90,
            label: { text: 'Saved label' },
          },
          { type: 'rectangle', id: 'deleted-box', x: 120, y: 240, width: 100, height: 50 },
          {
            type: 'frame',
            id: 'saved-frame',
            x: 50,
            y: 60,
            width: 350,
            height: 350,
            children: ['framed-box', 'deleted-box'],
          },
        ],
        { regenerateIds: false },
      ).map((el) => ({ ...el, version: 7, isDeleted: el.id === 'deleted-box' }))
      await workspaceApi.saveBoard({ ...board, scene: { elements, appState: { viewBackgroundColor: 'transparent' } } })
      return { boardId: board.id, elements }
    })
    assert.equal(
      fixture.elements.find((e) => e.id === 'saved-frame').children,
      undefined,
      'Persisted frames have frameId membership, not skeleton children',
    )
    await page.goto(`${base}/boards/${fixture.boardId}`)
    await mode(page, false)
    const reopened = await page.evaluate(() => window.__excalidrawAPI.getSceneElementsIncludingDeleted())
    for (const expected of fixture.elements) {
      const element = reopened.find((e) => e.id === expected.id)
      assert.ok(element, `Restore element ${expected.id}`)
      assert.equal(element.frameId, expected.frameId)
      assert.equal(element.isDeleted, expected.isDeleted)
      assert.equal(element.version, expected.version)
      // Restoration canonicalizes an absent binding list to an empty array.
      assert.deepEqual(element.boundElements ?? [], expected.boundElements ?? [])
      if (expected.type === 'text') assert.equal(element.containerId, expected.containerId)
    }
    await context.close()
  })
  await run('anonymous-local', async () => {
    const context = await browser.createBrowserContext()
    const page = await open(context)
    const cloudWrites = []
    page.on('request', (request) => {
      if (
        /\/(manageProject|manageBoardAccess|boardAsset)$/.test(new URL(request.url()).pathname) &&
        request.method() === 'POST'
      )
        cloudWrites.push(request.url())
    })
    await clickText(page, 'Continue without signing in')
    await clickText(page, 'New board')
    await page.type('#board-name-input', 'Anonymous local board')
    await page.type('#new-project-name', 'Local project')
    await clickText(page, 'Create board')
    await page.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await draw(page)
    const fileId = await insertImage(page)
    const uploadedData = await page.evaluate((id) => window.__excalidrawAPI.getFiles()[id].dataURL, fileId)
    await page.waitForFunction(() =>
      document.querySelector('#header-status-slot')?.textContent.includes('Synced locally'),
    )
    const url = page.url()
    const ids = await page.evaluate(() =>
      window.__excalidrawAPI
        .getSceneElements()
        .filter((e) => !e.isDeleted)
        .map((e) => e.id),
    )
    await closeTab(page)
    const reopened = await open(context, url)
    await reopened.waitForFunction(() => Boolean(window.__excalidrawAPI))
    assert.deepEqual(
      await reopened.evaluate(() =>
        window.__excalidrawAPI
          .getSceneElements()
          .filter((e) => !e.isDeleted)
          .map((e) => e.id),
      ),
      ids,
    )
    await reopened.waitForFunction((id) => Boolean(window.__excalidrawAPI.getFiles()[id]?.dataURL), {}, fileId)
    assert.equal(await reopened.evaluate((id) => window.__excalidrawAPI.getFiles()[id]?.dataURL, fileId), uploadedData)
    assert.deepEqual(cloudWrites, [], 'Anonymous local boards must not upload or publish cloud access')
    await context.close()
  })
  await run('permissions-without-refresh', async () => {
    const ownerContext = await browser.createBrowserContext()
    const owner = await open(ownerContext)
    const id = await ownerBoard(owner)
    await owner.goto(`${base}/boards/${id}`)
    await owner.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await draw(owner)
    await owner.waitForSelector('.sync-status-pill--saved')
    // Publish a link and restrict it again through the UI: the recipient has a
    // real previously issued link, rather than an unpublished synthetic URL.
    await share(owner)
    await owner.click('[aria-label="General access setting"]')
    await clickText(owner, 'Anyone with the link', '[role="menuitem"]')
    await shareSettled(owner)
    await owner.click('[aria-label="General access setting"]')
    await clickText(owner, 'Restricted', '[role="menuitem"]')
    await closeShare(owner)
    const recipientContext = await browser.createBrowserContext()
    const recipient = await open(recipientContext)
    const identity = await recipient.evaluate(async () => {
      const { signInOwner } = await import('/tests/regression-fixture.ts')
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      const { user } = await signInOwner(getFirebaseAuth())
      return { uid: user.uid, email: user.email }
    })
    await getAuth(admin).updateUser(identity.uid, { emailVerified: true })
    await recipient.evaluate(async () => {
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      await getFirebaseAuth().currentUser.reload()
      await getFirebaseAuth().currentUser.getIdToken(true)
    })
    // Recipient already has the restricted board open before receiving an invitation.
    await recipient.goto(`${base}/boards/${id}`)
    await recipient.waitForSelector('.access-denied-card')
    let navigations = 0
    recipient.on('framenavigated', (frame) => {
      if (frame === recipient.mainFrame()) navigations++
    })
    await share(owner)
    await owner.locator('input[type="email"]').fill(identity.email)
    assert.equal(await owner.$eval('input[type="email"]', (input) => input.value), identity.email)
    await clickText(owner, 'Add')
    await shareSettled(owner)
    await mode(recipient, true)
    await owner.click('[aria-label="Change permission"]')
    await clickText(owner, 'Editor', '[role="menuitem"]')
    await shareSettled(owner)
    await mode(recipient, false)
    await closeShare(owner)
    await recipient.waitForFunction(() => !window.__lazyCollab?.isTransitioningCollab)
    await draw(recipient, 500, 500)
    await owner.waitForFunction(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length === 2,
    )
    await share(owner)
    await owner.click('[aria-label="Change permission"]')
    await clickText(owner, 'Viewer', '[role="menuitem"]')
    await shareSettled(owner)
    await mode(recipient, true)
    assert.equal(navigations, 0, 'Invitation, upgrade and downgrade must work without recipient refresh')
    await closeShare(owner)
    const guestContext = await browser.createBrowserContext()
    const guest = await open(guestContext, `/boards/${id}`)
    await guest.waitForSelector('.access-denied-card')
    let guestNavigations = 0
    guest.on('framenavigated', (frame) => {
      if (frame === guest.mainFrame()) guestNavigations++
    })
    await share(owner)
    await owner.click('[aria-label="General access setting"]')
    await clickText(owner, 'Anyone with the link', '[role="menuitem"]')
    await shareSettled(owner)
    await mode(guest, true)
    await owner.click('[aria-label="General access role"]')
    await clickText(owner, 'Editor', '[role="menuitem"]')
    await shareSettled(owner)
    await mode(guest, false)
    await owner.click('[aria-label="General access role"]')
    await clickText(owner, 'Viewer', '[role="menuitem"]')
    await shareSettled(owner)
    await mode(guest, true)
    await owner.click('[aria-label="General access setting"]')
    await clickText(owner, 'Restricted', '[role="menuitem"]')
    await shareSettled(owner)
    await guest.waitForSelector('.access-denied-card')
    await owner.click('[aria-label="General access setting"]')
    await clickText(owner, 'Anyone with the link', '[role="menuitem"]')
    await shareSettled(owner)
    await mode(guest, true)
    assert.equal(guestNavigations, 0, 'Public grant, role changes, revocation and restoration require no refresh')
    await closeShare(owner)
    await closeTab(guest)
    const rejoined = await open(guestContext, `/boards/${id}`)
    await mode(rejoined, true)
    await rejoined.waitForSelector('.collab-avatar')
    await share(owner)
    await owner.click('[aria-label="General access role"]')
    await clickText(owner, 'Editor', '[role="menuitem"]')
    await closeShare(owner)
    await mode(rejoined, false)
    await draw(rejoined, 750, 600)
    await owner.waitForFunction(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length === 3,
    )
    await guestContext.close()
    await ownerContext.close()
    await recipientContext.close()
  })
  await run('anonymous-editor-pending-close', async () => {
    const ownerContext = await browser.createBrowserContext()
    const owner = await open(ownerContext)
    const id = await ownerBoard(owner)
    await owner.goto(`${base}/boards/${id}`)
    await owner.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await share(owner)
    await owner.click('[aria-label="General access setting"]')
    await clickText(owner, 'Anyone with the link', '[role="menuitem"]')
    await shareSettled(owner)
    await owner.click('[aria-label="General access role"]')
    await clickText(owner, 'Editor', '[role="menuitem"]')
    await closeShare(owner)
    const guestContext = await browser.createBrowserContext()
    const guest = await open(guestContext, `/boards/${id}`)
    await mode(guest, false)
    await closeTab(owner)
    await guest.waitForFunction(() => window.__lazyCollab?.isLazyCollabActive === false)
    await guest.setOfflineMode(true)
    await draw(guest)
    const fileId = await insertImage(guest)
    const uploadedData = await guest.evaluate((id) => window.__excalidrawAPI.getFiles()[id].dataURL, fileId)
    await guest.waitForFunction(() => window.__hasUnsavedChanges())
    await guest.waitForFunction(
      async ({ boardId, fileId }) => {
        const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
        const { readSharedSceneDraft } = await import('/src/features/sharing/shared-scene-drafts.ts')
        const draft = await readSharedSceneDraft(boardId, getFirebaseAuth().currentUser.uid)
        return (
          draft?.scene.elements.filter((e) => !e.isDeleted).length === 2 &&
          Boolean(draft.scene.files?.[fileId]?.dataURL)
        )
      },
      {},
      { boardId: id, fileId },
    )
    let warned = false
    guest.on('dialog', async (dialog) => {
      warned ||= dialog.type() === 'beforeunload'
      await dialog.accept()
    })
    await closeTab(guest)
    assert.equal(warned, true)
    const reopened = await open(guestContext, `/boards/${id}`)
    await mode(reopened, false)
    await reopened.waitForFunction((id) => Boolean(window.__excalidrawAPI.getFiles()[id]?.dataURL), {}, fileId)
    assert.equal(await reopened.evaluate((id) => window.__excalidrawAPI.getFiles()[id].dataURL, fileId), uploadedData)
    assert.equal(
      await reopened.evaluate(() => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length),
      2,
    )
    await reopened.waitForFunction(
      async (boardId) => {
        const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
        const { readSharedSceneDraft } = await import('/src/features/sharing/shared-scene-drafts.ts')
        return !(await readSharedSceneDraft(boardId, getFirebaseAuth().currentUser.uid))
      },
      {},
      id,
    )
    const viewerContext = await browser.createBrowserContext()
    const viewer = await open(viewerContext, `/boards/${id}`)
    await mode(viewer, false)
    await viewer.waitForFunction((id) => Boolean(window.__excalidrawAPI.getFiles()[id]?.dataURL), {}, fileId)
    assert.equal(
      await viewer.evaluate((id) => window.__excalidrawAPI.getFiles()[id].dataURL, fileId),
      uploadedData,
      'A different identity must load the recovered image from cloud storage',
    )
    await viewerContext.close()
    await guestContext.close()
    await ownerContext.close()
  })
  await run('pending-close-reopen', async () => {
    const context = await browser.createBrowserContext()
    const page = await open(context)
    const id = await ownerBoard(page)
    await page.goto(`${base}/boards/${id}`)
    await page.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await page.setOfflineMode(true)
    await draw(page)
    const fileId = await insertImage(page)
    const uploadedData = await page.evaluate((id) => window.__excalidrawAPI.getFiles()[id].dataURL, fileId)
    await page.waitForFunction(
      async (id) => {
        const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
        const board = await workspaceApi.loadBoard(id)
        return (
          board?.scene.elements.some((e) => e.type === 'image') &&
          Object.values(board.scene.files ?? {}).some((f) => f.dataURL)
        )
      },
      {},
      id,
    )
    const ids = await page.evaluate(() =>
      window.__excalidrawAPI
        .getSceneElements()
        .filter((e) => !e.isDeleted)
        .map((e) => e.id),
    )
    let warned = false
    page.on('dialog', async (dialog) => {
      warned ||= dialog.type() === 'beforeunload'
      await dialog.dismiss()
    })
    await page.close({ runBeforeUnload: true })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    assert.equal(warned, true, 'Pending cloud changes must warn even after local save completes')
    assert.equal(page.isClosed(), false, 'Cancelling close must keep the board open')
    page.removeAllListeners('dialog')
    page.on('dialog', (dialog) => dialog.accept())
    await closeTab(page)
    const reopened = await open(context, `/boards/${id}`)
    await reopened.waitForFunction(() => Boolean(window.__excalidrawAPI))
    assert.deepEqual(
      await reopened.evaluate(() =>
        window.__excalidrawAPI
          .getSceneElements()
          .filter((e) => !e.isDeleted)
          .map((e) => e.id),
      ),
      ids,
      'Pending local edits survive closing every app tab',
    )
    await reopened.waitForFunction((id) => Boolean(window.__excalidrawAPI.getFiles()[id]?.dataURL), {}, fileId)
    assert.equal(await reopened.evaluate((id) => window.__excalidrawAPI.getFiles()[id]?.dataURL, fileId), uploadedData)
    await reopened.waitForSelector('.sync-status-pill--saved')
    await closeTab(reopened)
    const saved = await open(context, `/boards/${id}`)
    await saved.waitForFunction(() => Boolean(window.__excalidrawAPI))
    assert.deepEqual(
      await saved.evaluate(() =>
        window.__excalidrawAPI
          .getSceneElements()
          .filter((e) => !e.isDeleted)
          .map((e) => e.id),
      ),
      ids,
    )
    await saved.waitForFunction((id) => Boolean(window.__excalidrawAPI.getFiles()[id]?.dataURL), {}, fileId)
    assert.equal(await saved.evaluate((id) => window.__excalidrawAPI.getFiles()[id]?.dataURL, fileId), uploadedData)
    await context.close()
  })
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2))
  await browser.close()
}
