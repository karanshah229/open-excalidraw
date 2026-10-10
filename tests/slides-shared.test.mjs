import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { mkdir } from 'node:fs/promises'
if (process.env.GCLOUD_PROJECT !== 'demo-regression') throw new Error('Requires isolated regression emulators')
const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:15190'
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const ownerContext = await browser.createBrowserContext(),
  viewerContext = await browser.createBrowserContext()
const owner = await ownerContext.newPage(),
  viewer = await viewerContext.newPage()
for (const page of [owner, viewer]) {
  page.setDefaultTimeout(30000)
  await page.setViewport({ width: 1400, height: 900 })
}
try {
  await owner.goto(base)
  const id = await owner.evaluate(async () => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const { signInOwner } = await import('/tests/regression-fixture.ts')
    const { user } = await signInOwner(getFirebaseAuth())
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
    const { convertToExcalidrawElements } = await import('/tests/frame-reload-fixture.ts')
    const { slideCustomData } = await import('/src/features/slides/slide-model.ts')
    const project = await workspaceApi.createProject('Shared slides')
    const board = await workspaceApi.createBoard(project.id, 'Shared slides')
    const elements = convertToExcalidrawElements(
      [
        {
          type: 'frame',
          children: [],
          id: 'slide-one',
          x: 100,
          y: 100,
          width: 400,
          height: 300,
          customData: slideCustomData({}, '0/1'),
        },
        {
          type: 'frame',
          children: [],
          id: 'slide-two',
          x: 700,
          y: 100,
          width: 400,
          height: 300,
          customData: slideCustomData({}, '1/1'),
        },
      ],
      { regenerateIds: false },
    )
    const scene = { elements, appState: { viewBackgroundColor: '#ffffff' } }
    await workspaceApi.saveBoard({ ...board, scene })
    await workspaceApi.flushCloud()
    const config = await sharingService.getShareConfig(board.id, { ownerId: user.uid, boardName: board.name, scene })
    await sharingService.saveShareConfig({ ...config, generalAccess: 'anyone_with_link', generalRole: 'viewer', scene })
    return board.id
  })
  await owner.goto(`${base}/boards/${id}`)
  await owner.waitForSelector('.slide-card')
  await viewer.goto(`${base}/boards/${id}`)
  await viewer.waitForFunction(() => document.querySelectorAll('.slide-card').length === 2)
  assert.equal(await viewer.$('.slide-properties'), null)
  const camera = await viewer.evaluate(() => {
    const s = window.__excalidrawAPI.getAppState()
    return [s.scrollX, s.scrollY, s.zoom.value]
  })
  assert.equal(await owner.$('.slide-properties input'), null)
  const movedId = await owner.evaluate(
    () => window.__excalidrawAPI.getSceneElements().find((element) => element.customData?.agenticWhiteboard?.slide).id,
  )
  await owner.click('[aria-label="Move slide later"]')
  await viewer.waitForFunction(
    async (id) => {
      const { getSlides } = await import('/src/features/slides/slide-model.ts')
      return getSlides(window.__excalidrawAPI.getSceneElements())[1]?.id === id
    },
    {},
    movedId,
  )
  assert.deepEqual(
    await viewer.evaluate(() => {
      const s = window.__excalidrawAPI.getAppState()
      return [s.scrollX, s.scrollY, s.zoom.value]
    }),
    camera,
  )
  await owner.click('.slide-actions button:last-child')
  await owner.waitForFunction(
    () => document.querySelector('#slide-notes-input') && !document.querySelector('#slide-notes-input').disabled,
  )
  await owner.setRequestInterception(true)
  const failNotes = (request) => {
    if (request.url().endsWith('/slideNotes') && request.method() === 'POST')
      void request.respond({
        status: 404,
        contentType: 'text/plain',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: 'Not Found',
      })
    else void request.continue()
  }
  owner.on('request', failNotes)
  await owner.type('#slide-notes-input', 'Cloud-only editor talking points')
  await owner.waitForFunction(() =>
    document.querySelector('.slide-notes [role="status"]')?.textContent.includes('service unavailable'),
  )
  assert.equal(
    await owner.$eval('#slide-notes-input', (node) => node.value),
    'Cloud-only editor talking points',
    'Failure preserves local typing',
  )
  await owner.waitForSelector('.slide-notes-retry')
  owner.off('request', failNotes)
  await owner.setRequestInterception(false)
  await owner.click('.slide-notes-retry')

  await owner.waitForFunction(
    () => document.querySelector('.slide-notes [role="status"]')?.textContent === 'All notes saved',
  )
  assert.equal(
    await viewer.evaluate(() =>
      JSON.stringify(window.__excalidrawAPI.getSceneElements()).includes('Cloud-only editor talking points'),
    ),
    false,
  )
  await owner.reload()
  await owner.waitForSelector('.slide-card')
  await owner.click('[aria-label="Go to slide 2"]')
  await owner.click('.slide-actions button:last-child')
  await owner.waitForFunction(
    () => document.querySelector('#slide-notes-input')?.value === 'Cloud-only editor talking points',
  )
  await viewer.click('[aria-label="Present slides"]')
  await viewer.waitForSelector('.fullscreen-slides img')
  assert.equal(await viewer.$('.presenter-notes'), null, 'Viewer presentation never exposes editor notes')
  assert.equal(await viewer.$('[aria-label="Open speaker view"]'), null, 'Viewer cannot open speaker window')
  assert.equal(
    await viewer.$eval('.fullscreen-slides', (n) => n.textContent.includes('Cloud-only editor talking points')),
    false,
  )
  await viewer.keyboard.press('Escape')
  await viewer.waitForSelector('.fullscreen-slides', { hidden: true })

  // Exercise the real board loader and fallback with authenticated emulator
  // identities. Inject the failure at the cloud-sharing read, not the resolver.
  const cached = await owner.evaluate(async (boardId) => {
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    const details = await workspaceApi.loadBoardWithProject(boardId)
    if (!details || details.project.ownerId !== getFirebaseAuth().currentUser.uid)
      throw new Error('Fixture must contain a private owner-local board')
    return details
  }, id)
  await viewer.evaluate(async (details) => {
    const { workspaceStore, workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    await workspaceStore.upsertProject(details.project)
    await workspaceStore.upsertBoard(details.document)
    const local = await workspaceApi.loadBoardWithProject(details.document.id)
    if (local) throw new Error('The viewer must not load another owner’s private workspace cache')
  }, cached)
  const injectSharingTimeout = async (request) => {
    if (new URL(request.url()).pathname === '/src/features/sharing/sharing-service.ts') {
      const response = await fetch(request.url())
      await request.respond({
        status: response.status,
        contentType: 'application/javascript',
        body: `${await response.text()}
          const originalBoardRead = sharingService.getSharedBoard;
          sharingService.getSharedBoard = async function(...args) {
            if (sessionStorage.getItem('e2e:board-read-timeout') === args[0]) {
              window.__boardReadTimeouts = (window.__boardReadTimeouts || 0) + 1;
              throw new Error('Firestore getDoc timeout');
            }
            return originalBoardRead.apply(this, args);
          }`,
      })
    } else await request.continue()
  }
  await mkdir('.system_generated/slides', { recursive: true })
  for (const page of [owner, viewer]) {
    await page.evaluate((boardId) => sessionStorage.setItem('e2e:board-read-timeout', boardId), id)
    await page.setRequestInterception(true)
    page.on('request', injectSharingTimeout)
    await page.reload()
  }
  await owner.waitForFunction(() => document.querySelectorAll('.slide-card').length === 2)
  assert(await owner.evaluate(() => window.__boardReadTimeouts > 0), 'Owner actually encountered the read timeout')
  assert.equal(await owner.$('.access-denied-title'), null, 'Owner opens the local copy without Retry')
  assert.deepEqual(
    await owner.evaluate(() =>
      window.__excalidrawAPI
        .getSceneElements()
        .map((element) => element.id)
        .sort(),
    ),
    cached.document.scene.elements
      .filter((element) => !element.isDeleted)
      .map((element) => element.id)
      .sort(),
    'Owner-local scene survives cloud-read failure',
  )
  assert(await owner.$('[aria-label="Duplicate slide"]'), 'Owner retains editing controls')
  await owner.click('[aria-label="Sync status and board details"]')
  await owner.waitForSelector('.sync-simple-desc')
  assert.equal(
    await owner.$eval('.sync-simple-desc', (node) => node.textContent),
    'Saved to this device. Syncing to cloud.',
  )
  await owner.keyboard.press('Escape')
  await owner.screenshot({ path: '.system_generated/slides/owner-local-timeout-recovery.png' })
  await viewer.waitForSelector('.access-denied-title')
  assert(await viewer.evaluate(() => window.__boardReadTimeouts > 0), 'Viewer actually encountered the read timeout')
  assert.equal(await viewer.$eval('.access-denied-title', (node) => node.textContent), 'Could not load board')
  assert.equal(await viewer.$('.excalidraw'), null, 'Another owner’s cached scene stays inaccessible')
  assert.equal(await viewer.$('.slide-card'), null, 'Cached slide previews are not exposed')
  await viewer.screenshot({ path: '.system_generated/slides/viewer-cached-board-timeout-blocked.png' })
  for (const page of [owner, viewer]) {
    await page.evaluate(() => sessionStorage.removeItem('e2e:board-read-timeout'))
    page.off('request', injectSharingTimeout)
    await page.setRequestInterception(false)
  }
  await viewer.click('.access-denied-card button')
  await viewer.waitForFunction(() => document.querySelectorAll('.slide-card').length === 2)
  assert.equal(await viewer.$('[aria-label="Duplicate slide"]'), null, 'Retry restores authorized viewer access only')
  // Firebase also creates anonymous identities for guest visitors. A private
  // local workspace must still use local notes, never that cloud identity.
  const guest = await viewer.evaluate(async (scene) => {
    const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
    if (!getFirebaseAuth().currentUser?.isAnonymous) throw new Error('Guest fixture requires anonymous Firebase auth')
    localStorage.setItem('agentic-whiteboard:local-workspace', 'true')
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { getSlides } = await import('/src/features/slides/slide-model.ts')
    const project = await workspaceApi.createProject('Guest local slides')
    if (project.ownerId !== 'local-user') throw new Error('Guest fixture requires a local-only project')
    const board = await workspaceApi.createBoard(project.id, 'Guest local notes')
    await workspaceApi.saveBoard({ ...board, scene })
    return { boardId: board.id, slideId: getSlides(scene.elements)[0].id }
  }, cached.document.scene)
  let guestNoteCalls = 0
  const countGuestNotes = (request) => {
    if (request.url().endsWith('/slideNotes')) guestNoteCalls++
  }
  viewer.on('request', countGuestNotes)
  viewer.once('dialog', async (dialog) => {
    assert.equal(
      dialog.type(),
      'beforeunload',
      'Only the existing viewer unload guard may interrupt fixture navigation',
    )
    await dialog.accept()
  })
  await viewer.goto(`${base}/boards/${guest.boardId}`)
  await viewer.waitForSelector('.slide-card')
  await viewer.click('[aria-label="Sync status and board details"]')
  await viewer.waitForSelector('.sync-simple-desc')
  assert.equal(await viewer.$eval('.sync-simple-desc', (node) => node.textContent), 'Saved to this device only.')
  await viewer.keyboard.press('Escape')
  await viewer.click('.slide-actions button:last-child')
  await viewer.waitForFunction(() => document.querySelector('#slide-notes-input')?.disabled === false)
  await viewer.type('#slide-notes-input', 'Guest notes stay on this device')
  await viewer.waitForFunction(
    async ({ boardId, slideId }) => {
      const { readNoteDraft, noteKey } = await import('/src/features/slides/notes-store.ts')
      return (await readNoteDraft(noteKey('local-user', boardId, slideId)))?.text === 'Guest notes stay on this device'
    },
    {},
    guest,
  )
  await viewer.reload()
  await viewer.waitForSelector('.slide-card')
  await viewer.click('.slide-actions button:last-child')
  await viewer.waitForFunction(
    () => document.querySelector('#slide-notes-input')?.value === 'Guest notes stay on this device',
  )
  await viewer.click('[aria-label="Presentation options"]')
  const speakerTarget = browser.waitForTarget((target) => target.opener() === viewer.target())
  await viewer.click('.slides-presentation-menu [role="menuitem"]:last-child')
  const guestSpeaker = await (await speakerTarget).page()
  await guestSpeaker.waitForFunction(
    () => document.querySelector('#presenter-notes-input')?.value === 'Guest notes stay on this device',
  )
  assert.equal(await guestSpeaker.$eval('#presenter-notes-input', (node) => node.readOnly), true)
  assert.equal(guestNoteCalls, 0, 'Anonymous guest-local notes never call the cloud notes service')
  await guestSpeaker.click('[aria-label="End presentation"]')
  await viewer.waitForSelector('.fullscreen-slides', { hidden: true })
  viewer.off('request', countGuestNotes)
  console.log(
    'PASS shared viewer slide updates, remote reorder without camera movement, editor cloud notes/reload, audience privacy, owner-local timeout recovery, cached-viewer access protection and anonymous guest-local notes/reload/presenter view',
  )
} finally {
  await browser.close()
}
