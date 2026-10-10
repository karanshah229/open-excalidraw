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
  await page.evaluateOnNewDocument(() => localStorage.setItem('agentic-whiteboard:theme:v1', 'light'))
}
owner.on('dialog', async (dialog) => {
  assert.equal(dialog.type(), 'beforeunload')
  await dialog.accept()
})
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
          type: 'rectangle',
          id: 'content-one',
          x: 145,
          y: 160,
          width: 310,
          height: 180,
          backgroundColor: '#d0bfff',
          strokeColor: '#6741d9',
          label: { text: 'Product roadmap', fontSize: 30 },
        },
        {
          type: 'rectangle',
          id: 'content-two',
          x: 745,
          y: 160,
          width: 310,
          height: 180,
          backgroundColor: '#b2f2bb',
          strokeColor: '#2b8a3e',
          label: { text: 'From ideas\nto delivery', fontSize: 30 },
        },
        {
          type: 'frame',
          children: ['content-one'],
          id: 'slide-one',
          x: 100,
          y: 100,
          width: 400,
          height: 300,
          customData: slideCustomData({}, '0/1'),
        },
        {
          type: 'frame',
          children: ['content-two'],
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
    const scene = { elements, appState: { viewBackgroundColor: '#ffffff', theme: 'light' } }
    await workspaceApi.saveBoard({ ...board, scene })
    await workspaceApi.flushCloud()
    const config = await sharingService.getShareConfig(board.id, { ownerId: user.uid, boardName: board.name, scene })
    await sharingService.saveShareConfig({ ...config, generalAccess: 'anyone_with_link', generalRole: 'viewer', scene })
    return board.id
  })
  await owner.goto(`${base}/boards/${id}`)
  await owner.waitForSelector('.slides-toggle')
  if (!(await owner.$('.slides-panel'))) await owner.click('.slides-toggle')
  await owner.waitForSelector('.slide-card')
  await viewer.goto(`${base}/boards/${id}`)
  await viewer.waitForSelector('.slides-toggle')
  if (!(await viewer.$('.slides-panel'))) await viewer.click('.slides-toggle')
  await viewer.waitForSelector('.slides-toggle')
  if (!(await viewer.$('.slides-panel'))) await viewer.click('.slides-toggle')
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
  await owner.waitForSelector('.slide-actions button:last-child')
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
  await owner.type('#slide-notes-input', 'Introduce the roadmap and explain the three priorities.')
  await owner.waitForFunction(() =>
    document.querySelector('.slide-notes [role="status"]')?.textContent.includes('service unavailable'),
  )
  assert.equal(
    await owner.$eval('#slide-notes-input', (node) => node.value),
    'Introduce the roadmap and explain the three priorities.',
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
      JSON.stringify(window.__excalidrawAPI.getSceneElements()).includes(
        'Introduce the roadmap and explain the three priorities.',
      ),
    ),
    false,
  )
  await owner.reload()
  await owner.waitForSelector('.slides-toggle')
  if (!(await owner.$('.slides-panel'))) await owner.click('.slides-toggle')
  await owner.waitForSelector('.slide-card')
  await owner.click('[aria-label="Go to slide 2"]')
  await owner.waitForSelector('.slide-actions button:last-child')
  await owner.click('.slide-actions button:last-child')
  await owner.waitForFunction(
    () =>
      document.querySelector('#slide-notes-input')?.value === 'Introduce the roadmap and explain the three priorities.',
  )
  await viewer.click('[aria-label="Present slides"]')
  await viewer.waitForSelector('.fullscreen-slides img')
  assert.equal(await viewer.$('.presenter-notes'), null, 'Viewer presentation never exposes editor notes')
  assert.equal(await viewer.$('[aria-label="Open speaker view"]'), null, 'Viewer cannot open speaker window')
  assert.equal(
    await viewer.$eval('.fullscreen-slides', (n) =>
      n.textContent.includes('Introduce the roadmap and explain the three priorities.'),
    ),
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
  await owner.waitForSelector('.slides-toggle')
  if (!(await owner.$('.slides-panel'))) await owner.click('.slides-toggle')
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
  assert(
    ['Saved to this device. Syncing to cloud.', 'Synced to cloud and this device.'].includes(
      await owner.$eval('.sync-simple-desc', (node) => node.textContent),
    ),
    'A signed-in owner reports cloud status, whether the pending write already completed or not',
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
  await viewer.waitForSelector('.slides-toggle')
  if (!(await viewer.$('.slides-panel'))) await viewer.click('.slides-toggle')
  await viewer.waitForFunction(() => document.querySelectorAll('.slide-card').length === 2)
  assert.equal(await viewer.$('[aria-label="Duplicate slide"]'), null, 'Retry restores authorized viewer access only')
  // Publish using the actual Slides header and Share dialog, then open as a fresh audience.
  await owner.reload()
  await owner.waitForSelector('.slides-toggle')
  if (!(await owner.$('.slides-panel'))) await owner.click('.slides-toggle')
  assert.equal(await owner.$eval('.board-sidebar-header', (node) => node.textContent.includes('Slides ·')), false)
  await owner.waitForFunction(() => document.querySelectorAll('.slide-card img').length === 2)
  await owner.screenshot({ path: '.system_generated/slides/shared-presentation-header.png' })
  await owner.bringToFront()
  await ownerContext.overridePermissions(base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'])
  await owner.click('.slides-share-presentation')
  await owner.waitForSelector('.google-share-copy-btn:not(:disabled)')
  await owner.evaluate(() => {
    window.__shareDialogRemovals = 0
    new MutationObserver((changes) => {
      for (const change of changes)
        for (const node of change.removedNodes)
          if (
            node.nodeType === 1 &&
            (node.matches('.google-share-dialog') || node.querySelector('.google-share-dialog'))
          )
            window.__shareDialogRemovals++
    }).observe(document.body, { childList: true, subtree: true })
  })
  await owner.click('[aria-label="General access role"]')
  const presentationOption = await owner.evaluateHandle(() =>
    [...document.querySelectorAll('[role="menuitem"]')].find((n) => n.textContent.trim() === 'Present'),
  )
  await presentationOption.asElement().click()
  await owner.waitForFunction(() => !document.querySelector('.google-share-copy-btn').disabled)
  await owner.click('.google-share-copy-btn')
  await owner.waitForFunction(
    () =>
      document.querySelector('.google-share-copy-btn')?.textContent.includes('Link copied') ||
      document.querySelector('.google-share-dialog [role="alert"]'),
    { timeout: 60000 },
  )
  assert.equal(
    await owner.$eval('.google-share-dialog', (n) => n.querySelector('[role="alert"]')?.textContent ?? ''),
    '',
  )
  assert.equal(await owner.evaluate(() => window.__shareDialogRemovals), 0, 'Publishing keeps the Share dialog mounted')
  assert.equal(await owner.evaluate(() => navigator.clipboard.readText()), `${base}/boards/${id}`)
  await owner.evaluate(() =>
    Promise.all(
      document
        .querySelector('.google-share-dialog')
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    ),
  )
  await owner.screenshot({ path: '.system_generated/slides/shared-presentation-share-dialog.png' })
  const audienceContext = await browser.createBrowserContext()
  const audience = await audienceContext.newPage()
  await audience.setViewport({ width: 1400, height: 900 })
  await audience.evaluateOnNewDocument(() => localStorage.setItem('agentic-whiteboard:theme:v1', 'light'))
  await audience.goto(`${base}/boards/${id}`)
  await audience.waitForSelector('.shared-presentation-landing button:not(:disabled)')
  assert(
    await audience.$eval('.shared-presentation-start', (node) => {
      const box = node.getBoundingClientRect()
      return Math.abs(box.left + box.width / 2 - innerWidth / 2) < 2
    }),
    'Start button is centered across the full browser viewport',
  )
  assert.equal(
    await audience.$('.shared-presentation-host.theme--dark'),
    null,
    'White board uses Excalidraw light theme',
  )
  await audience.click('.shared-slideshow-start')
  await audience.waitForSelector('.shared-presentation nav')
  assert.equal(await audience.$('.presenter-notes'), null, 'Slideshow has no notes')
  await audience.click('[aria-label="Next slide"]')
  await audience.waitForFunction(() =>
    document.querySelector('.shared-presentation nav span')?.textContent.includes('2 / 2'),
  )
  await audience.click('[aria-label="End presentation"]')
  await audience.waitForSelector('.shared-slideshow-start')
  await audience.screenshot({ path: '.system_generated/slides/shared-presentation-landing.png' })
  assert.equal(await audience.$('.presenter-notes'), null, 'Landing never exposes notes before starting')
  assert.equal(await audience.$('header.app-header'), null)
  await audience.evaluate(() => {
    window.__realOpen = window.open
    window.open = () => null
  })
  await audience.click('[aria-label="Presentation options"]')
  await audience.waitForSelector('[role="menuitem"]')
  await audience.evaluate(() =>
    [...document.querySelectorAll('[role="menuitem"]')]
      .find((node) => node.textContent.includes('Presenter View'))
      .click(),
  )
  await audience.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes('Allow popups'))
  await audience.evaluate(() => {
    window.open = window.__realOpen
    delete window.__realOpen
  })
  const sharedSpeakerTarget = browser.waitForTarget((target) => target.opener() === audience.target())
  await audience.click('[aria-label="Presentation options"]')
  await audience.waitForSelector('[role="menuitem"]')
  await audience.evaluate(() =>
    [...document.querySelectorAll('[role="menuitem"]')]
      .find((node) => node.textContent.includes('Presenter View'))
      .click(),
  )
  const sharedSpeaker = await (await sharedSpeakerTarget).page()
  await sharedSpeaker.setViewport({ width: 1400, height: 900 })
  await audience.waitForSelector('.shared-presentation img')
  assert.equal(await audience.$('.excalidraw-container canvas'), null, 'Presentation receives no board editor')
  assert.equal(await audience.$('.presenter-notes'), null, 'Notes exist only in the speaker window')
  assert.equal(await audience.$('nav'), null, 'Navigation controls exist only in the speaker window')
  await sharedSpeaker.waitForSelector('.shared-presenter .speaker-view-preview img')
  await sharedSpeaker.click('[aria-label="Next slide"]')
  await sharedSpeaker.waitForFunction(() =>
    document.querySelector('.shared-presenter nav span')?.textContent.includes('2 / 2'),
  )
  await sharedSpeaker.waitForFunction(() => {
    const image = document.querySelector('.shared-presenter .speaker-view-preview img')
    return image?.alt === 'Slide 2' && image.complete && image.naturalWidth > 0
  })
  await sharedSpeaker.waitForFunction(
    () =>
      document.querySelector('#shared-presenter-notes')?.value ===
      'Introduce the roadmap and explain the three priorities.',
  )
  assert.equal(await sharedSpeaker.$eval('#shared-presenter-notes', (node) => node.readOnly), true)
  await sharedSpeaker.click('#shared-presenter-notes')
  await sharedSpeaker.keyboard.type('Cannot change published notes')
  assert.equal(
    await sharedSpeaker.$eval('#shared-presenter-notes', (node) => node.value),
    'Introduce the roadmap and explain the three priorities.',
  )
  await sharedSpeaker.waitForFunction(() => document.querySelectorAll('.speaker-filmstrip img').length === 2)
  await sharedSpeaker.click('[aria-label="Pause timer"]')
  await sharedSpeaker.click('[aria-label="Reset timer"]')
  assert.equal(await sharedSpeaker.$eval('[aria-label="Presentation timer"]', (node) => node.textContent), '00:00:00')
  await sharedSpeaker.screenshot({ path: '.system_generated/slides/shared-presentation-speaker-view.png' })
  await sharedSpeaker.click('[aria-label="Go to slide 1"]')
  await sharedSpeaker.waitForFunction(
    () =>
      document.querySelector('.speaker-view-preview img')?.alt === 'Slide 1' &&
      document.querySelector('#shared-presenter-notes')?.value === '',
  )
  await sharedSpeaker.click('[aria-label="Go to slide 2"]')
  await sharedSpeaker.waitForFunction(
    () =>
      document.querySelector('#shared-presenter-notes')?.value ===
      'Introduce the roadmap and explain the three priorities.',
  )
  await sharedSpeaker.click('[aria-label="Increase notes text size"]')
  assert.equal(await sharedSpeaker.$eval('.presenter-notes', (node) => getComputedStyle(node).fontSize), '22px')
  await audience.waitForFunction(() => document.querySelector('.fullscreen-slide-content img')?.alt === 'Slide 2')
  await audience.bringToFront()
  if (!(await audience.evaluate(() => Boolean(document.fullscreenElement)))) {
    await audience.click('[aria-label="Fullscreen presentation"]')
  }
  await audience.waitForFunction(() => Boolean(document.fullscreenElement))
  await audience.screenshot({ path: '.system_generated/slides/shared-presentation-audience.png' })
  await sharedSpeaker.click('[aria-label="End presentation"]')
  await audience.waitForSelector('.shared-presentation-landing button')
  assert.equal(await audience.evaluate(() => Boolean(document.fullscreenElement)), false)
  await audience.goto(`${base}/boards/${id}`)
  await audience.waitForSelector('.shared-presentation-landing button:not(:disabled)')
  assert.equal(
    await audience.$('.excalidraw-container'),
    null,
    'Presentation role opens the start screen without editor controls',
  )
  await audienceContext.close()
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
  await viewer.waitForSelector('.slides-toggle')
  if (!(await viewer.$('.slides-panel'))) await viewer.click('.slides-toggle')
  await viewer.waitForSelector('.slide-card')
  await viewer.click('[aria-label="Sync status and board details"]')
  await viewer.waitForSelector('.sync-simple-desc')
  assert.equal(await viewer.$eval('.sync-simple-desc', (node) => node.textContent), 'Saved to this device only.')
  await viewer.keyboard.press('Escape')
  if (!(await viewer.$('.slides-panel'))) await viewer.click('.slides-toggle')
  await viewer.waitForSelector('.slide-actions button:last-child')
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
  await viewer.waitForSelector('.slides-toggle')
  if (!(await viewer.$('.slides-panel'))) await viewer.click('.slides-toggle')
  await viewer.waitForSelector('.slide-card')
  await viewer.waitForSelector('.slide-actions button:last-child')
  await viewer.click('.slide-actions button:last-child')
  await viewer.waitForFunction(
    () => document.querySelector('#slide-notes-input')?.value === 'Guest notes stay on this device',
  )
  await viewer.bringToFront()
  assert.equal(
    await viewer.evaluate(() => window.__excalidrawAPI.getAppState().defaultSidebarDockedPreference),
    false,
    'Guest presenter flow exercises the unpinned sidebar',
  )
  await viewer.click('[aria-label="Presentation options"]')
  await viewer.waitForSelector('.slides-presentation-menu [role="menuitem"]', { visible: true })
  assert.equal(
    await viewer.$$eval('.slides-presentation-menu [role="menuitem"]', (items) => items.at(-1)?.textContent.trim()),
    'Presenter view',
  )
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
    'PASS shared viewer slide updates, remote reorder without camera movement, editor cloud notes/reload, live read-only speaker notes/controls, presentation access, owner-local timeout recovery, cached-viewer access protection and anonymous guest-local notes/reload/presenter view',
  )
} catch (error) {
  console.error('Shared slides error', error)
  console.error(
    'Shared slides failure state',
    await owner.evaluate(() => ({
      dialog: document.querySelector('.google-share-dialog')?.textContent,
      dialogRemovals: window.__shareDialogRemovals,
      boardLoading: document.querySelector('.workspace-loading')?.textContent,
      accessDenied: document.querySelector('.access-denied-title')?.textContent,
      focus: document.hasFocus(),
    })),
  )
  console.error(
    'Guest failure state',
    await viewer
      .evaluate(async () => {
        const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
        const details = await workspaceApi.loadBoardWithProject(location.pathname.split('/').pop())
        return {
          viewMode: window.__excalidrawAPI?.getAppState().viewModeEnabled,
          collab: window.__lazyCollab,
          status: details?.document.syncStatus,
          owner: details?.project.ownerId,
          cards: document.querySelectorAll('.slide-card').length,
          actions: document.querySelectorAll('.slide-actions button').length,
          text: document.body.textContent.slice(-1600),
        }
      })
      .catch((diagnosticError) => ({ diagnosticError: String(diagnosticError) })),
  )
  await viewer.screenshot({ path: '.system_generated/slides/shared-guest-failure.png' })
  await owner.screenshot({ path: '.system_generated/slides/shared-presentation-failure.png' })
  throw error
} finally {
  await browser.close()
}
