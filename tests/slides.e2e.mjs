import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

const base = process.env.E2E_BASE_URL || 'http://127.0.0.1:5187'
const out = process.env.E2E_ARTIFACT_DIR || '.system_generated/slides'
await mkdir(out, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  defaultViewport: null,
  args: ['--no-sandbox'],
})
const page = await browser.newPage(),
  errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
  if (message.text().includes('Encountered two children with the same key')) errors.push(message.text())
})
await page.setViewport({ width: 1400, height: 900 })
async function tool(name) {
  for (const button of await page.$$('.App-toolbar__extra-tools-trigger')) {
    if ((await button.boundingBox())?.width) {
      await button.click()
      break
    }
  }
  await page.waitForSelector(`[data-testid="toolbar-${name}"]`, { visible: true })
  await page.click(`[data-testid="toolbar-${name}"]`)
}
async function draw(x1, y1, x2, y2) {
  await page.mouse.move(x1, y1)
  await page.mouse.down()
  await page.mouse.move(x2, y2, { steps: 12 })
  await page.mouse.up()
}
async function undo(redo = false) {
  await page.keyboard.down('Meta')
  if (redo) await page.keyboard.down('Shift')
  await page.keyboard.press('z')
  if (redo) await page.keyboard.up('Shift')
  await page.keyboard.up('Meta')
}
try {
  // Do not retain the injected load-failure module across reload tests.
  await page.setCacheEnabled(false)
  await page.goto(base)
  const id = await page.evaluate(async () => {
    const { isFirebaseConfigured } = await import('/src/lib/firebase.ts')
    if (isFirebaseConfigured) throw new Error('Local slide test must not access a Firebase project.')
    localStorage.setItem('agentic-whiteboard:local-workspace', 'true')
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const project = await workspaceApi.createProject('Slides contract')
    return (await workspaceApi.createBoard(project.id, 'Continuous drawing and slides')).id
  })
  // A cloud read failure must show a retryable load error, not "Local save failed".
  await page.setRequestInterception(true)
  const injectLoadFailure = async (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/src/features/workspace/board-loading.ts' && !url.searchParams.has('actual')) {
      await request.respond({
        status: 200,
        contentType: 'application/javascript',
        body: `
          window.__failBoardRead = true;
          export async function resolveBoardSharing(...args) {
            if (window.__failBoardRead) throw new Error('Firestore getDoc timeout');
            const actual = await import('/src/features/workspace/board-loading.ts?actual=1');
            return actual.resolveBoardSharing(...args);
          }
        `,
      })
    } else await request.continue()
  }
  page.on('request', injectLoadFailure)
  await page.goto(`${base}/boards/${id}`)
  await page.waitForSelector('.access-denied-title')
  assert.equal(await page.$eval('.access-denied-title', (node) => node.textContent), 'Could not load board')
  assert.equal(await page.$('.excalidraw'), null, 'Failed access lookup does not mount the editor')
  await page.evaluate(() => {
    window.__failBoardRead = false
  })
  await page.click('.access-denied-card button')
  await page.waitForFunction(() => !!window.__excalidrawAPI)
  await page.waitForSelector('.excalidraw canvas')
  await page.setRequestInterception(false)
  page.off('request', injectLoadFailure)
  assert.equal(await page.$('.slides-controls'), null, 'No slide controls on a board without slides')
  await page.click('.board-panel-rail [aria-label="Library"]')
  await page.waitForSelector('.board-sidebar')
  assert.equal(await page.$('.sidebar--docked'), null, 'Sidebar starts unpinned')
  for (const pinned of [true, false, true]) {
    await page.click('[data-testid="sidebar-dock"]')
    await page.waitForFunction(
      (expected) => window.__excalidrawAPI.getAppState().defaultSidebarDockedPreference === expected,
      {},
      pinned,
    )
    await page.waitForFunction(() => !window.__hasUnsavedChanges())
    await page.reload()
    await page.waitForFunction(() => !!window.__excalidrawAPI)
    await page.waitForSelector('.board-panel-rail')
    assert.equal(await page.$('.sidebar'), null, 'Reload keeps panels closed')
    await page.click('.board-panel-rail [aria-label="Library"]')
    await page.waitForSelector('.board-sidebar')
    assert.equal(
      await page.evaluate(() => window.__excalidrawAPI.getAppState().defaultSidebarDockedPreference),
      pinned,
      'Pin and unpin preferences survive reload',
    )
    assert.equal(await page.$$eval('.sidebar--docked', (nodes) => nodes.length), pinned ? 1 : 0)
  }
  await page.click('[data-testid="sidebar-close"]')
  await page.waitForSelector('.sidebar', { hidden: true })

  await page.click('[data-testid="toolbar-rectangle"]')
  await draw(350, 260, 500, 360)
  await page.waitForFunction(() => window.__excalidrawAPI.getSceneElements().length === 1)
  const rectangle = await page.evaluate(() => window.__excalidrawAPI.getSceneElements()[0])
  await tool('slide')
  await draw(300, 210, 560, 420)
  await page.waitForSelector('.slides-toggle')
  assert.equal(await page.$('.slides-panel'), null, 'Discovering slides does not automatically open the panel')
  const toolbarBeforeSidebar = await page.$eval('.shapes-section', (node) => node.getBoundingClientRect().x)
  await page.click('.slides-toggle')
  await page.waitForSelector('.slide-card')
  const toolbarAfterSidebar = await page.$eval('.shapes-section', (node) => node.getBoundingClientRect().x)
  assert.equal(toolbarAfterSidebar, toolbarBeforeSidebar, 'Opening Slides leaves the main toolbar fixed')
  await page.click('.board-panel-rail [aria-label="Help"]')
  await page.waitForSelector('.HelpDialog')
  await page.waitForFunction(() => !!document.activeElement?.closest('.HelpDialog'))
  assert.equal(
    await page.$eval('.board-canvas .help-icon', (node) => getComputedStyle(node).display),
    'none',
    'Canvas Help is replaced by the rail action',
  )
  await page.keyboard.press('Escape')
  await page.waitForSelector('.HelpDialog', { hidden: true })

  const first = await page.evaluate(() =>
    window.__excalidrawAPI.getSceneElements().find((e) => e.customData?.agenticWhiteboard?.slide),
  )
  const child = await page.evaluate(
    (id) => window.__excalidrawAPI.getSceneElements().find((e) => e.id === id),
    rectangle.id,
  )
  assert.equal(child.x, rectangle.x)
  assert.equal(child.y, rectangle.y)
  assert.equal(child.frameId, first.id)
  assert(first.width >= 250 && first.height >= 200, 'Initial centering must not interrupt frame drawing')
  await undo()
  await page.waitForFunction(
    () => !window.__excalidrawAPI.getSceneElements().some((e) => e.customData?.agenticWhiteboard?.slide),
  )
  assert.equal(
    await page.evaluate(() => window.__excalidrawAPI.getSceneElements().filter((e) => e.type === 'rectangle').length),
    1,
  )
  await undo(true)
  await page.waitForSelector('.slides-toggle')
  if (!(await page.$('.slides-panel'))) await page.click('.slides-toggle')
  await page.waitForFunction(() =>
    window.__excalidrawAPI.getSceneElements().some((e) => e.customData?.agenticWhiteboard?.slide),
  )
  assert.equal(await page.$('[aria-label="Fullscreen slides"]'), null, 'Only Present is exposed on the board')
  assert.equal(await page.$$eval('.sidebar', (nodes) => nodes.length), 1)
  assert(await page.$('.board-sidebar-header [aria-label="Present slides"]'), 'One native header contains Present')
  await page.waitForSelector('.slide-card img')
  await page.screenshot({ path: `${out}/shared-sidebar-slides.png` })
  await page.click('[data-testid="sidebar-close"]')
  await page.waitForSelector('.sidebar', { hidden: true })
  assert.equal(await page.$('.slides-present'), null)
  assert(await page.$('.board-panel-rail .slides-toggle'), 'Rail stays mounted on collapse')
  await page.click('.slides-toggle')
  await page.waitForSelector('.slides-panel')
  await page.click('.board-panel-rail [aria-label="Library"]')
  await page.waitForSelector('[data-testid="library"][data-state="active"]')
  assert.equal(
    await page.$eval('.shapes-section', (node) => node.getBoundingClientRect().x),
    toolbarBeforeSidebar,
    'Library also leaves the toolbar fixed',
  )
  assert.equal(await page.$('.slides-panel'), null, 'Library replaces Slides in the same sidebar')
  assert.equal(await page.$$eval('.sidebar', (nodes) => nodes.length), 1)
  assert.equal(
    await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect()
      const rail = document.querySelector('.board-panel-rail').getBoundingClientRect()
      return sidebar.right <= rail.left
    }),
    true,
    'Rail and sidebar have distinct layout space',
  )
  await page.screenshot({ path: `${out}/shared-sidebar-library.png` })
  await page.click('.board-panel-rail [aria-label="Search"]')
  await page.waitForSelector('[data-testid="search"][data-state="active"]')
  await page.click('.slides-toggle')
  await page.waitForSelector('.slides-panel')
  await page.setViewport({ width: 540, height: 900 })
  await page.waitForSelector('.excalidraw--mobile')
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(
    await page.$$eval('.sidebar', (nodes) => nodes.length),
    1,
    'Responsive fallback never duplicates sidebar',
  )
  await page.waitForSelector('.slide-card img')
  await page.screenshot({ path: `${out}/shared-sidebar-mobile.png` })
  await page.mouse.click(30, 600)
  await page.waitForSelector('.sidebar', { hidden: true })
  await page.click('.slides-toggle')
  await page.waitForSelector('.slides-panel')
  await page.setViewport({ width: 1400, height: 900 })
  await page.waitForSelector('.sidebar--docked')
  assert.equal(await page.$$eval('.sidebar', (nodes) => nodes.length), 1)
  await page.click('.slides-toggle')
  await page.waitForSelector('.sidebar', { hidden: true })
  await page.click('.slides-toggle')
  await page.waitForSelector('.slides-panel')
  await tool('frame')
  await draw(700, 250, 850, 400)
  const ordinary = await page.evaluate(
    () =>
      window.__excalidrawAPI
        .getSceneElements()
        .filter((e) => e.type === 'frame' && !e.customData?.agenticWhiteboard?.slide).length,
  )
  assert.equal(ordinary, 1, 'Frame remains an ordinary frame')
  await page.click('[aria-label="Duplicate slide"]')
  await page.waitForFunction(() => document.querySelectorAll('.slide-card').length === 2)
  const duplicated = await page.evaluate(async () => {
    const { getSlides } = await import('/src/features/slides/slide-model.ts')
    const elements = window.__excalidrawAPI.getSceneElements(),
      slides = getSlides(elements)
    return {
      ids: slides.map((e) => e.id),
      childIds: elements.filter((e) => e.frameId === slides[1].id).map((e) => e.id),
    }
  })
  assert.equal(duplicated.childIds.length, 1)
  assert.notEqual(duplicated.childIds[0], rectangle.id)
  await page.click('[aria-label="Move slide earlier"]')
  await page.waitForFunction(
    (id) =>
      document.querySelector('.slide-card')?.getAttribute('aria-current') === 'true' &&
      window.__excalidrawAPI.getSceneElements().some((e) => e.id === id),
    {},
    duplicated.ids[1],
  )
  assert.equal(await page.$('.slide-properties input'), null, 'Slides have no title editor')
  assert.equal(await page.$eval('.slide-card > span', (node) => node.textContent), 'Slide 1')
  // Old board titles remain harmless native data, but every surface uses slide numbers.
  await page.evaluate((slideId) => {
    const api = window.__excalidrawAPI
    window.__numberedSlide = slideId
    api.updateScene({
      elements: api
        .getSceneElements()
        .map((element) =>
          element.id === window.__numberedSlide
            ? { ...element, name: 'Legacy title', version: element.version + 1, versionNonce: element.versionNonce + 1 }
            : element,
        ),
    })
    api.updateScene({ appState: { editingFrame: window.__numberedSlide } })
  }, duplicated.ids[1])
  await page.waitForFunction(() => window.__excalidrawAPI.getAppState().editingFrame === null)
  assert.equal(await page.$('.slide-properties input'), null)
  assert.equal(await page.$eval('.slide-card > span', (node) => node.textContent), 'Slide 1')
  const ordinaryFrameId = await page.evaluate(() => {
    const api = window.__excalidrawAPI
    const frame = api
      .getSceneElements()
      .find((element) => element.type === 'frame' && !element.customData?.agenticWhiteboard?.slide)
    api.updateScene({ appState: { editingFrame: frame.id } })
    return frame.id
  })
  await page.waitForSelector(`[id$="-frame-name-${ordinaryFrameId}"] input`)
  assert.equal(
    await page.evaluate(() => window.__excalidrawAPI.getAppState().editingFrame),
    ordinaryFrameId,
    'Ordinary Frames retain native name editing',
  )
  await page.evaluate(() => window.__excalidrawAPI.updateScene({ appState: { editingFrame: null } }))
  await page.click('.slide-actions button:last-child')
  await page.waitForFunction(
    () => document.querySelector('#slide-notes-input') && !document.querySelector('#slide-notes-input').disabled,
  )
  await page.type('#slide-notes-input', 'Audience-private talking points')
  await page.waitForFunction(
    async ({ boardId, slideId }) => {
      const { readNoteDraft, noteKey } = await import('/src/features/slides/notes-store.ts')
      return (await readNoteDraft(noteKey('local-user', boardId, slideId)))?.text === 'Audience-private talking points'
    },
    {},
    { boardId: id, slideId: duplicated.ids[1] },
  )
  const selectedBeforeSwitch = await page.$eval('.slide-card[aria-current="true"]', (node) =>
    node.getAttribute('aria-label'),
  )
  await page.click('.board-panel-rail [aria-label="Library"]')
  await page.waitForFunction(() => !document.querySelector('.slides-panel'))
  await page.click('.slides-toggle')
  await page.waitForFunction(
    () => document.querySelector('#slide-notes-input')?.value === 'Audience-private talking points',
  )
  assert.equal(
    await page.$eval('.slide-card[aria-current="true"]', (node) => node.getAttribute('aria-label')),
    selectedBeforeSwitch,
  )
  // A network acknowledgement must preserve newer local typing.
  await page.evaluate(async () => {
    const { writeNoteDraft, acknowledgeNote, readNoteDraft } = await import('/src/features/slides/notes-store.ts')
    const first = { key: 'test:acknowledgement', text: 'Sent', revision: 0, dirty: true, mutationId: 'first' }
    await writeNoteDraft(first)
    await writeNoteDraft({ ...first, text: 'Newer typing', mutationId: 'second' })
    await acknowledgeNote(first, { text: 'Sent', revision: 1, conflict: false, updatedAt: null })
    const latest = await readNoteDraft(first.key)
    if (latest.text !== 'Newer typing' || !latest.dirty || latest.revision !== 1)
      throw new Error('Acknowledgement lost newer typing')
  })
  await page.click('[aria-label="Duplicate slide"]')
  await page.waitForFunction(() => document.querySelectorAll('.slide-card').length === 3)
  await page.waitForFunction(
    () => document.querySelector('#slide-notes-input')?.value === 'Audience-private talking points',
  )
  await undo()
  await page.waitForFunction(() => document.querySelectorAll('.slide-card').length === 2)
  await page.click('[aria-label="Go to slide 1"]')
  await new Promise((resolve) => setTimeout(resolve, 300))
  // Reopening uses cached bytes; refreshing keeps the old image until export completes.
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.slide-card')].every((card) => card.querySelector('img')),
  )
  await page.evaluate(() => {
    window.__previewExports = 0
    window.__originalPreviewToBlob = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      window.__previewExports++
      if (window.__holdPreviewExport) {
        window.__originalPreviewToBlob.call(
          this,
          (blob) => {
            window.__deliverPreview = () => callback(blob)
          },
          ...args,
        )
      } else window.__originalPreviewToBlob.call(this, callback, ...args)
    }
  })
  await page.click('[data-testid="sidebar-close"]')
  await page.click('.slides-toggle')
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.slide-card')].every((card) => card.querySelector('img')),
  )
  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal(
    await page.evaluate(() => window.__previewExports),
    0,
    'Reopening cached thumbnails must not export again',
  )
  const oldPreviewUrl = await page.$eval('.slide-card img', (image) => image.src)
  await page.evaluate(() => {
    window.__holdPreviewExport = true
    const api = window.__excalidrawAPI
    const firstSlide = api.getSceneElements().find((element) => element.id === window.__numberedSlide)
    api.updateScene({
      elements: api.getSceneElements().map((element) =>
        element.frameId === firstSlide.id
          ? {
              ...element,
              strokeColor: '#e03131',
              version: element.version + 1,
              versionNonce: element.versionNonce + 1,
            }
          : element,
      ),
    })
  })
  await page.waitForFunction(() => !!window.__deliverPreview)
  assert.equal(
    await page.$eval('.slide-card img', (image) => image.src),
    oldPreviewUrl,
    'Keep the original image while refreshing',
  )
  assert.equal(await page.$eval('.slides-list', (node) => node.textContent.includes('Loading preview')), false)
  await page.evaluate(() => {
    window.__holdPreviewExport = false
    window.__deliverPreview()
    delete window.__deliverPreview
  })
  await page.waitForFunction(
    (previous) => document.querySelector('.slide-card img')?.src !== previous,
    {},
    oldPreviewUrl,
  )
  await page.screenshot({ path: `${out}/cached-slide-refresh.png` })
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = window.__originalPreviewToBlob
    delete window.__originalPreviewToBlob
  })
  const beforeStage = await page.evaluate(() => {
    const state = window.__excalidrawAPI.getAppState()
    return { x: state.scrollX, y: state.scrollY, zoom: state.zoom.value }
  })
  await page.evaluate(() =>
    window.__excalidrawAPI.updateScene({ appState: { theme: 'dark', viewBackgroundColor: '#ffffff' } }),
  )
  await page.click('[aria-label="Present slides"]')
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('fullscreen-slides'))
  assert.equal(await page.$('.fullscreen-slides nav'), null, 'Audience has no toolbar')
  assert.equal(await page.$('.fullscreen-slides button'), null, 'Audience has no controls')
  // Native browser Escape can leave fullscreen without dispatching a page keydown.
  await page.evaluate(() => document.exitFullscreen())
  await page.waitForSelector('.fullscreen-slides', { hidden: true })
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), false)
  await page.click('[aria-label="Present slides"]')
  await page.waitForFunction(() => !!document.fullscreenElement)
  await page.keyboard.press('Escape')
  await page.waitForSelector('.fullscreen-slides', { hidden: true })
  await page.click('[aria-label="Presentation options"]')
  await page.screenshot({ path: `${out}/presentation-options.png` })
  assert.equal(await page.$$eval('.slides-presentation-menu [role="menuitem"]', (nodes) => nodes.length), 2)
  assert.equal(await page.$('#presenter-notes-input'), null, 'Audience never mounts notes')
  await page.evaluate(() => {
    window.__originalWindowOpen = window.open
    window.open = () => null
  })
  await page.click('.slides-presentation-menu [role="menuitem"]:last-child')
  await page.waitForFunction(() => document.querySelector('.slides-message')?.textContent.includes('Allow popups'))
  assert.equal(await page.$('#presenter-notes-input'), null, 'Blocked popup never falls back to exposing notes')
  await page.evaluate(() => {
    window.open = window.__originalWindowOpen
    delete window.__originalWindowOpen
  })
  await page.waitForSelector('.fullscreen-slides', { hidden: true })
  await page.click('[aria-label="Presentation options"]')
  const popupTarget = browser.waitForTarget((target) => target.opener() === page.target())
  await page.click('.slides-presentation-menu [role="menuitem"]:last-child')
  let speakerPage = await (await popupTarget).page()
  await page.waitForSelector('.fullscreen-slides img')
  assert.equal(
    await page.evaluate(() => !!document.fullscreenElement),
    false,
    'Presenter view never requests fullscreen',
  )
  assert.equal(await page.$('.fullscreen-slides button'), null, 'Presenter launch also keeps audience controls private')
  await speakerPage.waitForFunction(
    () => document.querySelector('#presenter-notes-input')?.value === 'Audience-private talking points',
  )
  assert.equal(await speakerPage.$eval('#presenter-notes-input', (node) => node.readOnly), true)
  await speakerPage.click('#presenter-notes-input')
  await speakerPage.keyboard.type('Cannot edit here')
  assert.equal(
    await speakerPage.$eval('#presenter-notes-input', (node) => node.value),
    'Audience-private talking points',
  )
  await speakerPage.waitForSelector('.speaker-view-preview img')
  await speakerPage.waitForFunction(() => document.querySelectorAll('.speaker-filmstrip img').length === 2)
  await speakerPage.click('[aria-label="Go to slide 2"]')
  await page.waitForFunction(() => document.querySelector('.fullscreen-slides')?.dataset.slideNumber === '2')
  await speakerPage.click('[aria-label="Go to slide 1"]')
  await speakerPage.waitForFunction(
    () => document.querySelector('#presenter-notes-input')?.value === 'Audience-private talking points',
  )
  const layout = await speakerPage.evaluate(() => {
    const slide = document.querySelector('.speaker-view-preview').getBoundingClientRect()
    const notes = document.querySelector('.presenter-notes').getBoundingClientRect()
    const thumbnails = document.querySelector('.speaker-filmstrip').getBoundingClientRect()
    return {
      largeSlide: slide.width > notes.width,
      notesRight: notes.left >= slide.right,
      thumbnailsBelow: thumbnails.top >= slide.bottom,
    }
  })
  assert.deepEqual(layout, { largeSlide: true, notesRight: true, thumbnailsBelow: true })
  await speakerPage.waitForSelector('.speaker-view-preview img')
  await speakerPage.screenshot({ path: `${out}/speaker-window.png` })
  await page.screenshot({ path: `${out}/audience-window.png` })
  assert.equal(await page.$('.presenter-notes'), null, 'Speaker popup is outside the shared window')
  await speakerPage.click('[aria-label="Next slide"]')
  await page.waitForFunction(() => document.querySelector('.fullscreen-slides')?.dataset.slideNumber === '2')
  await speakerPage.keyboard.press('ArrowLeft')
  await page.waitForFunction(() => document.querySelector('.fullscreen-slides')?.dataset.slideNumber === '1')
  await speakerPage.waitForFunction(
    () =>
      document.querySelector('.speaker-filmstrip [aria-current="true"]')?.getAttribute('aria-label') ===
      'Go to slide 1',
  )
  await speakerPage.click('[aria-label="Pause timer"]')
  const pausedTime = await speakerPage.$eval('output', (node) => node.textContent)
  await new Promise((resolve) => setTimeout(resolve, 1100))
  assert.equal(await speakerPage.$eval('output', (node) => node.textContent), pausedTime)
  await speakerPage.click('[aria-label="Reset timer"]')
  assert.equal(await speakerPage.$eval('output', (node) => node.textContent), '00:00:00')
  await speakerPage.close()
  await new Promise((resolve) => setTimeout(resolve, 650))
  await page.bringToFront()
  await page.click('.fullscreen-slide-content')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.fullscreen-slides', { hidden: true })
  await page.click('[aria-label="Presentation options"]')
  const reopenedTarget = browser.waitForTarget(
    (target) => target.opener() === page.target() && target !== speakerPage.target(),
  )
  await page.click('.slides-presentation-menu [role="menuitem"]:last-child')
  speakerPage = await (await reopenedTarget).page()
  await speakerPage.waitForFunction(
    () => document.querySelector('#presenter-notes-input')?.value === 'Audience-private talking points',
  )
  await page.bringToFront()
  await page.click('.fullscreen-slide-content')
  assert.equal(
    await page.evaluate(() => !!document.fullscreenElement),
    false,
    'Presenter view stays windowed, even when clicked',
  )
  await page.keyboard.press('End')
  await page.waitForFunction(() => document.querySelector('.fullscreen-slides')?.dataset.slideNumber === '2')
  await page.keyboard.press('ArrowLeft')
  await page.waitForFunction(() => document.querySelector('.fullscreen-slides')?.dataset.slideNumber === '1')

  assert.equal(await page.$eval('.fullscreen-slide-content', (n) => n.textContent.includes('Audience-private')), false)
  await page.waitForSelector('.fullscreen-slides img')
  // Navigation may still show the cached previous slide while its replacement renders.
  await page.waitForFunction(async () => {
    const image = document.querySelector('.fullscreen-slides img')
    if (!image) return false
    try {
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      return [...ctx.getImageData(5, 5, 1, 1).data].slice(0, 3).every((value) => value < 80)
    } catch {
      return false
    }
  })
  const background = await page.$eval('.fullscreen-slides img', async (image) => {
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    return [...ctx.getImageData(5, 5, 1, 1).data]
  })
  assert(
    background.slice(0, 3).every((value) => value < 80),
    'Dark board presentation must retain its dark background',
  )
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), false)
  const image = await page.$eval('.fullscreen-slides img', (n) => n.getBoundingClientRect().toJSON())
  assert(image.width > 500 && image.height > 400, 'Audience view fills the available viewport')
  await page.screenshot({ path: `${out}/fullscreen.png` })
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => document.querySelector('.fullscreen-slides')?.dataset.slideNumber === '2')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.fullscreen-slides'))
  await page.waitForFunction(() => !document.querySelector('.fullscreen-slides'))
  assert(speakerPage.isClosed(), 'Ending presentation closes speaker window')
  const afterStage = await page.evaluate(() => {
    const state = window.__excalidrawAPI.getAppState()
    return { x: state.scrollX, y: state.scrollY, zoom: state.zoom.value }
  })
  assert.deepEqual(afterStage, beforeStage, 'Fullscreen does not mutate the editor camera')
  await page.click('[aria-label="Previous slide"]')
  await page.waitForFunction(
    () => document.querySelector('#slide-notes-input')?.value === 'Audience-private talking points',
  )
  await page.waitForFunction(() => !window.__hasUnsavedChanges())
  await page.reload()
  await page.waitForFunction(
    () => window.__excalidrawAPI?.getSceneElements().filter((e) => e.customData?.agenticWhiteboard?.slide).length === 2,
  )
  await page.waitForSelector('.slides-toggle')
  assert.equal(await page.$('.slides-panel'), null, 'Reloading a board with slides keeps the panel closed')
  await page.click('.slides-toggle')
  await page.waitForSelector('.slide-actions')
  await page.click('.slide-actions button:last-child')
  await page.waitForFunction(
    () => document.querySelector('#slide-notes-input')?.value === 'Audience-private talking points',
  )
  await page.waitForSelector('.slide-card img')
  assert.equal(
    await page.$eval('.slide-card img', (image) => Math.max(image.naturalWidth, image.naturalHeight)),
    360,
    'Thumbnail canvas scales with its drawing so content is not cropped',
  )
  await page.screenshot({ path: `${out}/board-and-notes.png` })
  await page.click('[aria-label="Remove slide boundary, keep drawings"]')
  await page.waitForFunction(() => document.querySelectorAll('.slide-card').length === 1)
  assert.equal(
    await page.evaluate(() => window.__excalidrawAPI.getSceneElements().filter((e) => e.type === 'rectangle').length),
    2,
  )
  await undo()
  await page.waitForFunction(() => document.querySelectorAll('.slide-card').length === 2)
  assert.equal(await page.$eval('.slides-present', (n) => n.textContent.trim()), 'Slideshow')
  for (let remaining = 2; remaining > 0; remaining--) {
    await page.click('[aria-label="Remove slide boundary, keep drawings"]')
    await page.waitForFunction((count) => document.querySelectorAll('.slide-card').length === count, {}, remaining - 1)
  }
  await page.waitForFunction(
    () => !document.querySelector('.slides-toggle') && !document.querySelector('.slides-panel'),
  )
  assert.equal(await page.$('.slides-toggle'), null, 'Last slide removal hides the Slides rail button')
  assert.equal(await page.$('.slides-panel'), null, 'No empty panel remains after the last slide')
  await undo()
  await page.waitForSelector('.slides-toggle')
  await page.click('.slides-toggle')
  await page.waitForSelector('.slides-present')
  // Warm thumbnails below the viewport after opening, without having to scroll.
  await page.click('[data-testid="sidebar-close"]')
  await page.evaluate(() => {
    const api = window.__excalidrawAPI
    const elements = api.getSceneElements()
    const template = elements.find((element) => element.customData?.agenticWhiteboard?.slide)
    window.__beforeWarmup = elements
    api.updateScene({
      elements: [
        ...elements,
        ...Array.from({ length: 12 }, (_, index) => ({
          ...template,
          id: `warmup-slide-${index}`,
          x: template.x + (index + 1) * 2000,
          name: `Warmup ${index + 1}`,
          customData: { agenticWhiteboard: { slide: { schemaVersion: 1, orderKey: `${index + 100}/1` } } },
        })),
      ],
    })
  })
  await page.click('.slides-toggle')
  await page.waitForSelector('.slide-card:last-child')
  assert.equal(await page.$('.slide-card:last-child img'), null, 'Offscreen preview starts lazy')
  const listPosition = await page.$eval('.slides-list', (node) => node.scrollTop)
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.slide-card')].every((card) => card.querySelector('img')),
  )
  assert.equal(await page.$eval('.slides-list', (node) => node.scrollTop), listPosition, 'Warmup needs no scrolling')
  await page.$eval('.slides-list', (node) => {
    node.scrollTop = node.scrollHeight
  })
  assert.equal(
    await page.$eval('.slide-card:last-child', (node) => node.textContent.includes('Loading preview')),
    false,
    'Offscreen thumbnail is ready when scrolled into view',
  )
  const scrolledPosition = await page.$eval('.slides-list', (node) => node.scrollTop)
  await page.click('.board-panel-rail [aria-label="Library"]')
  await page.waitForFunction(() => !document.querySelector('.slides-panel'))
  await page.click('.slides-toggle')
  await page.waitForSelector('.slide-card:last-child img')
  assert.equal(
    await page.$eval('.slides-list', (node) => node.scrollTop),
    scrolledPosition,
    'Switching tabs restores scroll position',
  )
  assert.equal(
    await page.$eval('.slides-list', (node) => node.textContent.includes('Loading preview')),
    false,
    'Switching tabs reuses warmed previews',
  )
  await page.evaluate(() => window.__excalidrawAPI.updateScene({ elements: window.__beforeWarmup }))
  // A wide slide must fit and center in the canvas left of the open Slides panel.
  await page.evaluate(() => {
    const api = window.__excalidrawAPI
    window.__beforeNavigation = api.getSceneElements()
    api.updateScene({
      elements: window.__beforeNavigation.map((element) =>
        element.customData?.agenticWhiteboard?.slide
          ? { ...element, width: 1800, height: 360, version: element.version + 1 }
          : element,
      ),
    })
  })
  for (const width of [1400, 900]) {
    await page.setViewport({ width, height: 900 })
    await page.click('.slide-card')
    await new Promise((resolve) => setTimeout(resolve, 350))
    const bounds = await page.evaluate(() => {
      const api = window.__excalidrawAPI
      const state = api.getAppState()
      const slide = api.getSceneElements().find((element) => element.customData?.agenticWhiteboard?.slide)
      const start = { x: (slide.x + state.scrollX) * state.zoom.value + state.offsetLeft }
      const end = { x: (slide.x + slide.width + state.scrollX) * state.zoom.value + state.offsetLeft }
      const panel = document.querySelector('.slides-panel').getBoundingClientRect()
      return { left: start.x, right: end.x, panelLeft: panel.left, canvasLeft: state.offsetLeft }
    })
    assert(bounds.left >= bounds.canvasLeft, `Slide stays inside the visible canvas at ${width}px`)
    assert(
      bounds.right < bounds.panelLeft,
      `Slide must not be hidden under Slides at ${width}px: ${JSON.stringify(bounds)}`,
    )
    assert(
      Math.abs((bounds.left + bounds.right) / 2 - (bounds.canvasLeft + bounds.panelLeft) / 2) < 2,
      `Slide centers in the unobstructed canvas at ${width}px`,
    )
    await page.screenshot({ path: `${out}/slide-navigation-panel-${width}.png` })
  }
  await page.evaluate(() => window.__excalidrawAPI.updateScene({ elements: window.__beforeNavigation }))
  assert.deepEqual(errors, [])
  console.log(
    'PASS native Slide/Frame drawing, Library/Slides exclusivity, cached preview reuse/refresh, delayed offscreen warmup, containment, one-step undo, duplication, numbering, reorder, fullscreen, notes, reload and boundary removal',
  )
} catch (error) {
  console.error(
    'Presentation failure state',
    await page.evaluate(() => ({
      fullscreen: !!document.fullscreenElement,
      message: document.querySelector('.presentation-message')?.textContent,
      stage: !!document.querySelector('.fullscreen-slides'),
      focus: document.hasFocus(),
    })),
  )
  await page.screenshot({ path: `${out}/presentation-launch-failure.png` })
  throw error
} finally {
  await browser.close()
}
