import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const require = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
const { createServer, preview } = await import(require.resolve('vite'))
const root = fileURLToPath(new URL('../apps/whiteboard', import.meta.url)),
  port = 5198
let server = await createServer({ root, mode: 'e2e', server: { host: '127.0.0.1', port, strictPort: true } })
await server.listen()
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  defaultViewport: null,
})
const page = await browser.newPage(),
  errors = []
page.on('pageerror', (error) => errors.push(error.message))
await page.setViewport({ width: 1400, height: 900 })
const base = `http://127.0.0.1:${port}`
try {
  await page.goto(base)
  const boardId = await page.evaluate(async () => {
    const { isFirebaseConfigured } = await import('/src/lib/firebase.ts')
    if (isFirebaseConfigured) throw new Error('Production fixture requires Firebase disabled.')
    localStorage.setItem('agentic-whiteboard:local-workspace', 'true')
    const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
    const { convertToExcalidrawElements } = await import('/tests/frame-reload-fixture.ts')
    const { noteKey, writeNoteDraft } = await import('/src/features/slides/notes-store.ts')
    const project = await workspaceApi.createProject('Production slides')
    const board = await workspaceApi.createBoard(project.id, 'Production slides')
    const elements = convertToExcalidrawElements(
      [
        {
          type: 'rectangle',
          id: 'production-content',
          x: 100,
          y: 100,
          width: 250,
          height: 120,
          label: { text: 'Production slide' },
        },
        {
          type: 'frame',
          id: 'production-slide',
          x: 50,
          y: 50,
          width: 600,
          height: 400,
          children: ['production-content'],
          customData: { agenticWhiteboard: { slide: { schemaVersion: 1, orderKey: '0/1' } } },
        },
      ],
      { regenerateIds: false },
    )
    await workspaceApi.saveBoard({ ...board, scene: { elements, appState: { viewBackgroundColor: '#ffffff' } } })
    await writeNoteDraft({
      key: noteKey('local-user', board.id, 'production-slide'),
      text: 'Production private notes',
      revision: 0,
      dirty: true,
      mutationId: crypto.randomUUID(),
    })
    return board.id
  })
  await page.goto('about:blank')
  await server.close()
  const production = await preview({ root, preview: { host: '127.0.0.1', port, strictPort: true } })
  server = { close: () => new Promise((resolve) => production.httpServer.close(resolve)) }
  // A stale deployment chunk must reload once and recover the persisted board.
  await page.setRequestInterception(true)
  let failedChunks = 0,
    persistentFailures = 0
  let chunkFailure = 'once'
  // Keep one interceptor installed. Disabling it while requests are queued
  // can make Puppeteer's pending continue() calls fail before app assertions.
  page.on('request', async (request) => {
    const editorChunk = /\/assets\/board-editor-[^/]+\.js/.test(request.url())
    if (editorChunk && (chunkFailure === 'always' || (chunkFailure === 'once' && failedChunks === 0))) {
      if (chunkFailure === 'always') persistentFailures++
      else failedChunks++
      await request.respond({ status: 404, contentType: 'text/html', body: '<!doctype html>Missing chunk' })
    } else await request.continue()
  })
  await page.goto(`${base}/boards/${boardId}`)
  await page.waitForSelector('.slides-panel, .slides-toggle')
  assert.equal(failedChunks, 1, 'Production recovery exercises a real missing editor chunk')
  chunkFailure = 'none'
  assert.equal(await page.evaluate(() => !!window.__excalidrawAPI), false, 'Running production bundle')
  await page.waitForFunction(() => document.body.textContent.includes('Slide 1'))
  const toolbarPosition = await page.$eval('.shapes-section', (node) => node.getBoundingClientRect().x)
  if (!(await page.$('.slides-panel'))) await page.click('.slides-toggle')
  assert.equal(
    await page.$eval('.shapes-section', (node) => node.getBoundingClientRect().x),
    toolbarPosition,
    'Production toolbar stays fixed on panel opening',
  )
  await page.click('.board-panel-rail [aria-label="Help"]')
  await page.waitForSelector('.HelpDialog')
  await page.waitForFunction(() => !!document.activeElement?.closest('.HelpDialog'))
  await page.keyboard.press('Escape')
  await page.waitForSelector('.HelpDialog', { hidden: true })

  await page.waitForSelector('.slide-card img')
  assert.equal(await page.$('.sidebar--docked'), null, 'Production sidebar defaults to unpinned')
  await page.click('[data-testid="sidebar-dock"]')
  await page.waitForSelector('.sidebar--docked')

  await page.click('.slide-actions button:last-child')
  await page.waitForFunction(() => document.querySelector('#slide-notes-input')?.value === 'Production private notes')
  await page.setViewport({ width: 540, height: 900 })
  await page.waitForSelector('.excalidraw--mobile')
  await page.waitForSelector('.slide-card img')
  assert.equal(await page.$$eval('.sidebar', (nodes) => nodes.length), 1, 'Production mobile resize keeps one sidebar')
  await page.click('.board-panel-rail [aria-label="Library"]')
  await page.waitForFunction(() => !document.querySelector('.slides-panel'))
  assert.equal(await page.$$eval('.sidebar', (nodes) => nodes.length), 1)
  await page.click('.slides-toggle')
  await page.waitForFunction(() => document.querySelector('#slide-notes-input')?.value === 'Production private notes')
  await page.setViewport({ width: 1400, height: 900 })
  await page.waitForFunction(
    () =>
      !document.querySelector('.excalidraw-container.excalidraw--mobile') &&
      !!document.querySelector('.sidebar--docked'),
  )
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.$$eval('.sidebar', (nodes) => nodes.length), 1)

  for (const trigger of await page.$$('.App-toolbar__extra-tools-trigger')) {
    if ((await trigger.boundingBox())?.width) {
      await trigger.click()
      break
    }
  }
  await page.waitForSelector('[data-testid="toolbar-slide"]', { visible: true })
  await page.click('[data-testid="toolbar-slide"]')
  await page.mouse.move(300, 650)
  await page.mouse.down()
  await page.mouse.move(600, 820, { steps: 12 })
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelectorAll('.slide-card').length === 2)
  await page.click('[aria-label="Presentation options"]')
  assert.equal(await page.$('#presenter-notes-input'), null)
  const popupTarget = browser.waitForTarget((target) => target.opener() === page.target())
  await page.click('.slides-presentation-menu [role="menuitem"]:last-child')
  await page.waitForSelector('.fullscreen-slides img')
  const speakerPage = await (await popupTarget).page()
  await speakerPage.waitForFunction(
    () => document.querySelector('#presenter-notes-input')?.value === 'Production private notes',
  )
  await page.bringToFront()
  await page.click('.fullscreen-slide-content')
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), false, 'Presenter view stays windowed')
  assert.equal(
    await page.$eval('.fullscreen-slide-content', (node) => node.textContent.includes('Production private notes')),
    false,
  )
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => document.querySelector('.fullscreen-slides')?.dataset.slideNumber === '2')
  await speakerPage.click('#presenter-notes-input')
  // Escape closes this window on keydown, before Puppeteer's keyup can complete.
  await speakerPage.keyboard.press('Escape').catch((error) => {
    if (error.constructor.name !== 'TargetCloseError') throw error
  })
  await page.waitForFunction(() => !document.querySelector('.fullscreen-slides'))
  assert(speakerPage.isClosed(), 'Escape from speaker notes closes both presentation windows')
  await page.waitForFunction(() =>
    document.querySelector('#header-status-slot')?.textContent.includes('Synced locally'),
  )
  await page.reload()
  await page.waitForSelector('.slides-panel, .slides-toggle')
  if (!(await page.$('.slides-panel'))) await page.click('.slides-toggle')
  await page.waitForFunction(() => document.querySelectorAll('.slide-card').length === 2)
  await page.waitForSelector('.sidebar--docked')
  assert.deepEqual(await page.$$eval('.slide-card > span', (nodes) => nodes.map((node) => node.textContent)), [
    'Slide 1',
    'Slide 2',
  ])
  let activeEditorReloads = 0
  const countEditorReloads = (frame) => {
    if (frame === page.mainFrame()) activeEditorReloads++
  }
  page.on('framenavigated', countEditorReloads)
  await page.evaluate(() => window.dispatchEvent(new Event('vite:preloadError')))
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(activeEditorReloads, 0, 'Chunk recovery never auto-reloads an active drawing')
  page.off('framenavigated', countEditorReloads)
  // A persistent failure must stop after one automatic reload and offer Retry.
  await page.evaluate(() => sessionStorage.removeItem('agentic-whiteboard:chunk-recovery'))
  chunkFailure = 'always'
  const secondChunkFailure = page.waitForResponse(
    (response) =>
      /\/assets\/board-editor-[^/]+\.js/.test(response.url()) && response.status() === 404 && persistentFailures === 2,
  )
  await page.reload()
  // The first error screen can render briefly before automatic recovery. The
  // second response belongs to the reloaded document, where the loop stops.
  await secondChunkFailure
  // Automatic chunk recovery can replace the document during this wait.
  // Poll a boolean instead of transferring an element from the old context.
  await page.waitForFunction(() =>
    Boolean(document.querySelector('.access-denied-card [role="alert"], .access-denied-card button')),
  )
  assert.equal(await page.$eval('.access-denied-title', (node) => node.textContent), 'Could not load this page')
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(persistentFailures, 2, 'Persistent failure reloads only once')
  chunkFailure = 'none'
  await page.click('.access-denied-card button')
  await page.waitForSelector('.slides-toggle')
  assert.equal(await page.$('.slides-panel'), null, 'Recovery reload keeps Slides collapsed')
  await page.click('.slides-toggle')
  await page.waitForSelector('.slide-card')
  assert.equal(await page.$$eval('.slide-card', (nodes) => nodes.length), 2, 'Manual reload preserves saved slides')
  assert.deepEqual(errors, [])
  console.log(
    'PASS production bundle: Slide toolbar/creation, numbering, thumbnails, private local notes, windowed Presenter view, Escape exit, persisted reload, missing-chunk recovery, loop prevention and active-editor protection',
  )
} catch (error) {
  await page.screenshot({ path: '.system_generated/slides/production-failure.png' })
  console.error(await page.evaluate(() => document.body.innerText))
  throw error
} finally {
  await browser.close()
  await server.close()
}
