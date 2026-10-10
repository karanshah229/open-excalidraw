import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { writeFile, mkdir } from 'node:fs/promises'
if (process.env.GCLOUD_PROJECT !== 'demo-regression') throw new Error('Requires isolated regression emulators')
await mkdir('.system_generated/slides', { recursive: true })
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
const auditCalls = [],
  auditFlows = []
let auditPhase = null
const auditStarts = new WeakMap()
owner.on('request', (request) => {
  if (!auditPhase || request.method() !== 'POST' || !request.url().includes(':45001/')) return
  let data
  try {
    data = JSON.parse(request.postData() || '{}').data
  } catch {
    // Non-JSON requests have no callable operation to record.
  }
  const item = {
    phase: auditPhase,
    endpoint: request.url().split('/').pop(),
    operation: data?.action || data?.operation || null,
    started: Date.now(),
  }
  auditCalls.push(item)
  auditStarts.set(request, item)
})
owner.on('requestfinished', (request) => {
  const item = auditStarts.get(request)
  if (item) item.durationMs = Date.now() - item.started
})
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
  // Publish using the actual Slides header and Share dialog, then open as a fresh audience.
  await owner.goto(`${base}/boards/${id}`)
  await owner.waitForSelector('.slides-toggle')
  if (!(await owner.$('.slides-panel'))) await owner.click('.slides-toggle')
  assert.equal(await owner.$eval('.board-sidebar-header', (node) => node.textContent.includes('Slides ·')), false)
  await owner.waitForFunction(() => document.querySelectorAll('.slide-card img').length === 2)
  await owner.screenshot({ path: '.system_generated/slides/shared-presentation-header.png' })
  await owner.bringToFront()
  await ownerContext.overridePermissions(base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'])
  await owner.click('.slides-share-presentation')
  await owner.waitForSelector('.google-share-copy-btn:not(:disabled)')
  assert.equal(await owner.$eval('.google-share-copy-btn', (node) => node.textContent.trim()), 'Copy Link')
  assert.equal(
    await owner.$('.google-share-hint'),
    null,
    'Slides opens the same board Share dialog without a special hint',
  )
  const slideDialog = await owner.$eval('.google-share-dialog', (node) => node.textContent)
  await owner.click('.google-share-done-btn')
  await owner.click('.header-share-btn')
  await owner.waitForSelector('.google-share-copy-btn:not(:disabled)')
  assert.equal(
    await owner.$eval('.google-share-dialog', (node) => node.textContent),
    slideDialog,
    'Both triggers open the identical board Share modal',
  )
  await owner.click('[aria-label="Sharing options explained"]')
  await owner.waitForSelector('.google-share-popover-info')
  assert.match(await owner.$eval('.google-share-popover-info', (node) => node.textContent), /Present.*speaker notes/)
  await owner.keyboard.press('Escape')
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
  await owner.evaluate(() => {
    window.__auditCanvas = document.querySelector('.excalidraw')
  })
  const menuChoice = async (label, choice) => {
    await owner.click(`[aria-label="${label}"]`)
    const option = await owner.evaluateHandle(
      (text) => [...document.querySelectorAll('[role="menuitem"]')].find((n) => n.textContent.trim() === text),
      choice,
    )
    await option.asElement().click()
    await owner.waitForFunction(
      () =>
        Boolean(document.querySelector('.google-share-copy-btn')) &&
        !document.querySelector('.google-share-copy-btn').disabled,
    )
  }
  const checkCanvas = async () =>
    assert.equal(
      await owner.evaluate(
        () => window.__auditCanvas === document.querySelector('.excalidraw') && window.__auditCanvas.isConnected,
      ),
      true,
      'Permission changes keep the same canvas mounted',
    )
  auditPhase = 'viewer-to-presentation'
  await menuChoice('General access role', 'Present')
  await checkCanvas()
  assert.equal(
    auditCalls.filter((c) => c.phase === auditPhase).length,
    1,
    'Presentation permission change makes one callable request',
  )
  // Permission snapshots can drain earlier drawing work. Establish durable
  // quiescence before attributing requests to the clipboard-only action.
  await owner.evaluate(async () => {
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    await workspaceApi.flushCloud()
  })
  await owner.waitForFunction(
    async (id) => {
      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
      const { sceneService } = await import('/src/features/scenes/scene-service.ts')
      const local = await workspaceApi.loadBoard(id)
      const cloud = await sceneService.load(id)
      return !window.__pendingScene?.() && local?.syncStatus === 'synced' && local.cloudRevisionId === cloud?.revisionId
    },
    { polling: 200 },
    id,
  )
  auditPhase = 'copy-existing-presentation'
  await owner.click('.google-share-copy-btn')
  await owner.waitForFunction(() =>
    document.querySelector('.google-share-copy-btn').textContent.includes('Link copied'),
  )
  await new Promise((resolve) => setTimeout(resolve, 200))
  await checkCanvas()
  assert.equal(await owner.evaluate(() => navigator.clipboard.readText()), `${base}/boards/${id}`)
  auditPhase = 'restrict-presentation'
  await menuChoice('General access setting', 'Restricted')
  await checkCanvas()
  auditPhase = 'copy-restricted-presentation'
  await owner.click('.google-share-copy-btn')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(auditCalls.filter((c) => c.phase === auditPhase).length, 0)
  assert.equal(
    await owner.$eval('[aria-label="General access setting"]', (n) => n.textContent.includes('Restricted')),
    true,
    'Copy never reopens public access',
  )
  auditPhase = 'restore-public-presentation'
  await menuChoice('General access setting', 'Anyone with the link')
  await checkCanvas()
  for (const selector of ['.google-share-role-trigger', '.google-share-general-select-btn']) {
    await owner.hover(selector)
    const padding = await owner.$eval(selector, (node) => {
      const style = getComputedStyle(node)
      return { x: parseFloat(style.paddingLeft), y: parseFloat(style.paddingTop) }
    })
    assert(padding.x >= 10 && padding.y >= 6, `${selector} hover retains comfortable padding`)
  }
  await owner.screenshot({ path: '.system_generated/slides/sharing-fixed-modal.png' })
  auditPhase = null
  await viewer.goto(`${base}/boards/${id}`)
  await viewer.waitForSelector('.shared-presentation-landing button:not(:disabled)')
  assert.equal(
    await viewer.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }),
    false,
    'Present access must not warn about unsaved drawing changes',
  )
  let unloadDialogs = 0
  viewer.on('dialog', async (dialog) => {
    unloadDialogs++
    await dialog.accept()
  })
  await viewer.click('.shared-slideshow-start')
  await viewer.click('[aria-label="End presentation"]')
  await viewer.reload()
  await viewer.waitForSelector('.shared-slideshow-start:not(:disabled)')
  assert.equal(unloadDialogs, 0, 'Reload after presenting does not open a dirty-tab dialog')

  assert.equal(
    await viewer.$('.app-header .header-share-btn[title="Share board"]'),
    null,
    'Presentation recipients never see editor controls',
  )
  assert.equal(await viewer.$('.excalidraw-container'), null, 'Presentation access does not mount the editor')
  await viewer.screenshot({ path: '.system_generated/slides/sharing-fixed-presentation-landing.png' })
  assert.equal(await viewer.$('.shared-presentation-host.theme--dark'), null)
  await owner.evaluate(async (boardId) => {
    const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { document } = await workspaceApi.loadBoardWithProject(boardId)
    await sharingService.updateSharedScene(boardId, {
      ...document.scene,
      appState: { ...document.scene.appState, viewBackgroundColor: '#ffffff', theme: 'dark' },
    })
  }, id)
  await viewer.waitForSelector('.shared-presentation-host.theme--dark')
  const buttonStyle = await viewer.$eval('.shared-slideshow-start', (node) => {
    const style = getComputedStyle(node)
    return { color: style.color, background: style.backgroundColor, opacity: style.opacity }
  })
  assert.equal(buttonStyle.opacity, '1', 'Enabled start button is fully opaque')
  assert.notEqual(buttonStyle.color, buttonStyle.background, 'Start label contrasts with primary button')
  await viewer.click('[aria-label="Presentation options"]')
  await viewer.waitForSelector('[role="menuitem"]')
  await viewer.screenshot({ path: '.system_generated/slides/shared-start-combo-dark.png' })

  assert.equal(
    auditCalls.filter((c) => c.phase === 'copy-existing-presentation').length,
    0,
    'Copy link should make zero API calls',
  )
} catch (error) {
  await owner.screenshot({ path: '.system_generated/slides/sharing-audit-final.png' })
  throw error
} finally {
  await writeFile(
    '.system_generated/sharing-slide-browser-audit.json',
    JSON.stringify(
      {
        auditFlows,
        auditCalls,
        copyContract: {
          expectedCalls: 0,
          actualCalls: auditCalls.filter((c) => c.phase === 'copy-existing-presentation').length,
        },
      },
      null,
      2,
    ),
  )
  await browser.close()
}
