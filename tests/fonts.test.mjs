import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const require = createRequire(new URL('../apps/whiteboard/package.json', import.meta.url))
const { createServer, preview } = await import(require.resolve('vite'))
const root = fileURLToPath(new URL('../apps/whiteboard', import.meta.url))
const port = 5199
const base = `http://127.0.0.1:${port}`
const names = [
  'Arial',
  'Times New Roman',
  'Helvetica',
  'Verdana',
  'Georgia',
  'Courier New',
  'Trebuchet MS',
  'Tahoma',
  'Segoe UI',
  'Calibri',
  'Roboto',
  'Open Sans',
  'Inter',
  'Lato',
  'Montserrat',
  'Poppins',
  'Noto Sans',
  'Merriweather',
  'Playfair Display',
  'Fira Code',
]
let server = await createServer({ root, mode: 'e2e', server: { host: '127.0.0.1', port, strictPort: true } })
await server.listen()
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const page = await browser.newPage()
// Control the idle boundary so startup assertions do not race the browser scheduler.
await page.evaluateOnNewDocument(() => {
  const callbacks = new Map()
  let next = 0
  window.requestIdleCallback = (callback) => {
    callbacks.set(++next, callback)
    return next
  }
  window.cancelIdleCallback = (id) => callbacks.delete(id)
  window.__fontIdleCallbacks = callbacks
  window.__releaseFontIdle = () => {
    for (const [id, callback] of callbacks) {
      callbacks.delete(id)
      callback({ didTimeout: false, timeRemaining: () => 50 })
    }
  }
})
const errors = []
const failedFonts = []
const bundledFiles = [
  'roboto',
  'opensans',
  'inter',
  'lato',
  'montserrat',
  'poppins',
  'notosans',
  'merriweather',
  'playfairdisplay',
  'firacode',
].map((slug) => `${slug}.woff2`)
const fontResponses = new Map()
const fontRequests = []
const pendingFontRequests = []
let holdFontDownloads = true
let fontPhase = 'startup'
let rejectFonts = false
await page.setCacheEnabled(false)
await page.setRequestInterception(true)
page.on('request', (request) => {
  const file = new URL(request.url()).pathname.split('/').pop()
  if (bundledFiles.includes(file)) {
    fontRequests.push({ file, phase: fontPhase })
    if (rejectFonts) {
      void request.respond({ status: 503, contentType: 'text/plain', body: 'Font temporarily unavailable' })
      return
    }
    if (holdFontDownloads) {
      pendingFontRequests.push(request)
      return
    }
  }
  void request.continue().catch(() => {})
})
page.on('pageerror', (error) => errors.push(error.message))
page.on('response', (response) => {
  if (response.url().includes('/fonts/') && response.status() >= 400 && !rejectFonts) failedFonts.push(response.url())
  const file = new URL(response.url()).pathname.split('/').pop()
  if (bundledFiles.includes(file)) fontResponses.set(file, response.status())
})
await page.setViewport({ width: 1400, height: 900 })

async function openPicker() {
  await page.waitForSelector('[data-testid="font-family-show-fonts"]', { visible: true })
  await page.click('[data-testid="font-family-show-fonts"]')
  await page.waitForSelector('input[placeholder="Quick search"]', { visible: true })
}
async function selectSearch(name, id, production = false) {
  const input = await page.$('input[placeholder="Quick search"]')
  await input.click({ clickCount: 3 })
  await input.type(name)
  await page.waitForFunction(
    (family) => {
      const entries = [...document.querySelectorAll('.fonts button')]
      return entries.length === 1 && entries[0].textContent.trim() === family
    },
    {},
    name,
  )
  await page.click(`.fonts button[value="${id}"]`)
  await page.waitForFunction(() => !document.querySelector('input[placeholder="Quick search"]'))
  if (production) return
  await page.waitForFunction(
    (familyId) =>
      window.__excalidrawAPI
        .getSceneElements()
        .some((element) => element.type === 'text' && element.fontFamily === familyId),
    {},
    id,
  )
}
async function selectText() {
  await page.evaluate(() => {
    const api = window.__excalidrawAPI
    const text = api.getSceneElements().find((element) => element.type === 'text' && !element.isDeleted)
    api.setActiveTool({ type: 'selection' })
    api.updateScene({ appState: { selectedElementIds: { [text.id]: true } } })
  })
}
async function verifyLazyFontLoading() {
  assert.deepEqual(fontRequests, [], 'A fresh board does not request additional fonts before opening the picker')
  await page.waitForFunction(() => window.__fontIdleCallbacks.size > 0)
  fontPhase = 'background'
  await page.evaluate(() => window.__releaseFontIdle())
  await page.waitForFunction(
    () =>
      [...document.fonts].filter(
        (font) => font.status === 'loading' && ['Roboto', 'Open Sans'].includes(font.family.replace(/^"|"$/g, '')),
      ).length === 2,
  )
  assert.equal(fontRequests.length, 2, 'Background loading starts with two concurrent font requests')
  fontPhase = 'picker'
  await openPicker()
  const available = await page.$$eval('.fonts button', (nodes) => nodes.map((node) => node.textContent.trim()))
  for (const name of names) assert(available.includes(name), `${name} appears in font search`)
  assert.equal(available.filter((name) => name === 'Helvetica').length, 1)
  assert.equal(fontResponses.size, 0, 'All 20 names appear while bundled font downloads are still pending')
  await page.waitForSelector('.font-loading-feedback')
  assert.equal(await page.$eval('.properties-content', (node) => getComputedStyle(node).cursor), 'progress')
  assert(await page.$('.fonts button[aria-busy="true"]'), 'Pending fonts expose a busy state')
  holdFontDownloads = false
  await Promise.all(pendingFontRequests.map((request) => request.continue().catch(() => {})))
  await page.waitForFunction(() => {
    const expected = [
      'Roboto',
      'Open Sans',
      'Inter',
      'Lato',
      'Montserrat',
      'Poppins',
      'Noto Sans',
      'Merriweather',
      'Playfair Display',
      'Fira Code',
    ]
    const loaded = [...document.fonts]
      .filter((font) => font.status === 'loaded')
      .map((font) => font.family.replace(/^"|"$/g, ''))
    return expected.every((name) => loaded.includes(name))
  })
  for (const file of bundledFiles) assert.equal(fontResponses.get(file), 200, `${file} downloads successfully`)
  await page.waitForFunction(() => !document.querySelector('.font-loading-feedback'))
  assert.equal(await page.$eval('.properties-content', (node) => node.dataset.fontsLoading), 'false')
  assert(
    fontRequests.every(({ phase }) => phase === 'background' || phase === 'picker'),
    'Font requests begin only after the idle boundary or an explicit picker open',
  )
  console.log(
    'Network: all names visible before downloads complete; idle queue starts two requests, picker accelerates the remainder; all ten returned HTTP 200.',
  )
}

async function checkWarmOfflineFonts() {
  const requestsBefore = fontRequests.length
  await page.setOfflineMode(true)
  await page.waitForFunction(() => document.querySelector('.font-loading-feedback')?.textContent.includes('Offline'))
  assert.equal(
    await page.evaluate(
      () =>
        [...document.fonts].filter(
          (font) =>
            font.status === 'loaded' &&
            [
              'Roboto',
              'Open Sans',
              'Inter',
              'Lato',
              'Montserrat',
              'Poppins',
              'Noto Sans',
              'Merriweather',
              'Playfair Display',
              'Fira Code',
            ].includes(font.family.replace(/^"|"$/g, '')),
        ).length,
    ),
    10,
    'Downloaded fonts remain usable offline',
  )
  assert.equal(fontRequests.length, requestsBefore, 'Going offline does not redownload fonts')
  await page.setOfflineMode(false)
  await page.waitForFunction(() => !document.querySelector('.font-loading-feedback'))
}

async function checkFailureRecovery(emptyBoardId, offline) {
  fontRequests.length = 0
  fontResponses.clear()
  holdFontDownloads = false
  rejectFonts = !offline
  fontPhase = 'startup'
  await page.goto(`${base}/boards/${emptyBoardId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.excalidraw canvas', { visible: true })
  await waitForSave()
  await page.waitForFunction(() => window.__fontIdleCallbacks.size > 0)
  assert.deepEqual(fontRequests, [], 'No additional fonts requested during initial board load')
  if (offline) await page.setOfflineMode(true)
  fontPhase = 'background'
  await page.evaluate(() => window.__releaseFontIdle())
  await page.waitForFunction(
    () =>
      [...document.fonts].filter(
        (font) =>
          font.status === 'error' &&
          [
            'Roboto',
            'Open Sans',
            'Inter',
            'Lato',
            'Montserrat',
            'Poppins',
            'Noto Sans',
            'Merriweather',
            'Playfair Display',
            'Fira Code',
          ].includes(font.family.replace(/^"|"$/g, '')),
      ).length === 10,
  )
  console.log(`Failure ${offline ? 'offline' : '503'}: opening picker after failed downloads`)
  await page.keyboard.press('t')
  await openPicker()
  const available = await page.$$eval('.fonts button', (nodes) => nodes.map((node) => node.textContent.trim()))
  for (const name of names) assert(available.includes(name), `${name} remains searchable when download fails`)
  await page.waitForSelector('.fonts button[value="2010"][data-font-load-state="error"]')
  assert((await page.$eval('.fonts button[value="2010"]', (node) => node.title)).includes('fallback'))
  assert.equal(
    await page.$eval('.properties-content', (node) => node.dataset.fontsLoading),
    'false',
    'A failure clears the loading cursor',
  )
  assert(
    (await page.$eval('.font-loading-feedback', (node) => node.textContent)).includes(
      offline ? 'Offline' : 'couldn’t load',
    ),
  )
  // Selecting an unavailable face is allowed; its generic fallback keeps editing usable.
  console.log('Failure: selecting unavailable Roboto and entering text')
  await selectSearch('Roboto', 2010, true)
  await page.keyboard.press('Escape')
  await page.keyboard.press('t')
  await page.mouse.click(600, 350)
  await page.keyboard.type('Offline fallback text')
  await page.keyboard.press('Escape')
  await page.keyboard.down('Meta')
  await page.keyboard.press('a')
  await page.keyboard.up('Meta')
  console.log('Failure: reopening picker to recover')
  await openPicker()
  if (offline) await page.setOfflineMode(false)
  else {
    for (const file of bundledFiles) assert.equal(fontResponses.get(file), 503, `${file} simulated failure`)
    rejectFonts = false
    await page.click('.font-loading-feedback button')
  }
  await page.waitForFunction(() => !document.querySelector('.font-loading-feedback'))
  for (const file of bundledFiles) assert.equal(fontResponses.get(file), 200, `${file} recovers`)
  assert(await page.$('.fonts button[value="2010"].dropdown-menu-item--selected'), 'Retry preserves the selected font')
  const recoveredText = await page.evaluate(() => {
    const api = window.__excalidrawAPI
    if (!api) return null
    const element = api.getSceneElements().find((element) => element.type === 'text' && !element.isDeleted)
    const context = document.createElement('canvas').getContext('2d')
    context.font = `${element.fontSize}px Roboto, sans-serif`
    return {
      text: element.text,
      fontFamily: element.fontFamily,
      width: element.width,
      measured: context.measureText(element.text).width,
    }
  })
  if (recoveredText) {
    assert.equal(recoveredText.text, 'Offline fallback text')
    assert.equal(recoveredText.fontFamily, 2010)
    assert(
      Math.abs(recoveredText.width - recoveredText.measured) < 1.1,
      'Recovery refreshes text dimensions using the downloaded font',
    )
  }

  await waitForSave()
  console.log(
    offline
      ? 'Offline: names, usable text fallback, and automatic online recovery passed.'
      : 'Failure: fallback, cleared busy state, and explicit Retry passed.',
  )
}

async function waitForSave() {
  await page.waitForFunction(() =>
    document.querySelector('#header-status-slot')?.textContent.includes('Synced locally'),
  )
}

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  const { boardId, emptyBoardId, offlineBoardId, failedBoardId, productionOfflineId, productionFailedId } =
    await page.evaluate(async () => {
      const { isFirebaseConfigured } = await import('/src/lib/firebase.ts')
      if (isFirebaseConfigured) throw new Error('Font fixture requires Firebase disabled.')
      localStorage.setItem('agentic-whiteboard:local-workspace', 'true')
      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
      const project = await workspaceApi.createProject('Font test')
      const board = await workspaceApi.createBoard(project.id, 'Font test')
      const emptyBoard = await workspaceApi.createBoard(project.id, 'Fresh production font test')
      const offlineBoard = await workspaceApi.createBoard(project.id, 'Offline fonts')
      const failedBoard = await workspaceApi.createBoard(project.id, 'Failed font downloads')
      const productionOffline = await workspaceApi.createBoard(project.id, 'Production offline fonts')
      const productionFailed = await workspaceApi.createBoard(project.id, 'Production failed font downloads')
      return {
        boardId: board.id,
        emptyBoardId: emptyBoard.id,
        offlineBoardId: offlineBoard.id,
        failedBoardId: failedBoard.id,
        productionOfflineId: productionOffline.id,
        productionFailedId: productionFailed.id,
      }
    })
  await page.goto(`${base}/boards/${boardId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__excalidrawAPI)
  assert.equal(await page.evaluate(() => window.__excalidrawAPI.getAppState().currentItemFontFamily), 5)
  // Enter text through the real editor to check the untouched handwritten default.
  await page.keyboard.press('t')
  await page.mouse.click(600, 350)
  await page.keyboard.type('Handwritten default')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => window.__excalidrawAPI.getSceneElements().some((element) => element.type === 'text'))
  assert.equal(
    await page.evaluate(
      () => window.__excalidrawAPI.getSceneElements().find((element) => element.type === 'text').fontFamily,
    ),
    5,
  )
  await selectText()
  await verifyLazyFontLoading()
  await checkWarmOfflineFonts()
  await selectSearch('Roboto', 2010)
  await waitForSave()
  await page.reload()
  await page.waitForFunction(() =>
    window.__excalidrawAPI?.getSceneElements().some((element) => element.fontFamily === 2010),
  )
  await selectText()
  await openPicker()
  await selectSearch('Times New Roman', 2001)
  assert.equal(
    await page.evaluate(
      () => window.__excalidrawAPI.getSceneElements().find((element) => element.type === 'text').fontFamily,
    ),
    2001,
  )
  await openPicker()
  await selectSearch('Fira Code', 2019)
  await waitForSave()
  const exported = await page.evaluate(async () => {
    const { exportToSvg, exportToBlob, restoreElements } = await import('/tests/fonts-fixture.ts')
    const api = window.__excalidrawAPI
    const elements = api.getSceneElements()
    const options = { elements, appState: api.getAppState(), files: api.getFiles() }
    const svg = await exportToSvg(options)
    const png = await exportToBlob({ ...options, mimeType: 'image/png' })
    const system = elements.map((element) => ({ ...element, fontFamily: 2001 }))
    const systemSvg = await exportToSvg({ ...options, elements: system })
    return {
      svg: svg.outerHTML,
      systemSvg: systemSvg.outerHTML,
      pngBytes: png.size,
      restored: restoreElements(JSON.parse(JSON.stringify(elements)), null).map((element) => element.fontFamily),
    }
  })
  assert(exported.svg.includes('Fira Code'))
  assert(exported.svg.includes('data:font/woff2'), 'SVG embeds portable web font bytes')
  assert(exported.systemSvg.includes('Times New Roman, serif'), 'System SVG keeps its generic fallback')
  assert(exported.pngBytes > 1000, 'PNG renders text')
  assert.deepEqual(exported.restored, [2019], 'JSON restore preserves custom IDs')

  await checkFailureRecovery(offlineBoardId, true)
  await checkFailureRecovery(failedBoardId, false)
  // Reuse the saved board in a real production build using only its visible UI.
  await page.goto('about:blank')
  await server.close()
  const production = await preview({ root, preview: { host: '127.0.0.1', port, strictPort: true } })
  server = { close: () => new Promise((resolve) => production.httpServer.close(resolve)) }
  fontRequests.length = 0
  pendingFontRequests.length = 0
  fontResponses.clear()
  holdFontDownloads = true
  fontPhase = 'startup'
  await page.goto(`${base}/boards/${emptyBoardId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.excalidraw canvas', { visible: true })
  await waitForSave()
  await page.keyboard.press('t')
  await verifyLazyFontLoading()
  await checkWarmOfflineFonts()

  await page.goto(`${base}/boards/${boardId}`)
  await page.waitForSelector('.excalidraw canvas', { visible: true })
  await waitForSave()
  await page.mouse.click(1050, 600)
  await page.keyboard.down('Meta')
  await page.keyboard.press('a')
  await page.keyboard.up('Meta')
  await openPicker()
  assert(await page.$('.fonts button[value="2019"].dropdown-menu-item--selected'), 'Production restores Fira Code')
  const productionNames = await page.$$eval('.fonts button', (nodes) => nodes.map((node) => node.textContent.trim()))
  for (const name of names) assert(productionNames.includes(name), `${name} appears in production`)
  await selectSearch('Open Sans', 2011, true)
  await page.waitForFunction(() => document.fonts.check('20px "Open Sans"', 'Handwritten default'))
  await waitForSave()
  await page.reload()
  await page.waitForSelector('.excalidraw canvas', { visible: true })
  await waitForSave()
  await page.mouse.click(1050, 600)
  await page.keyboard.down('Meta')
  await page.keyboard.press('a')
  await page.keyboard.up('Meta')
  await openPicker()
  assert(await page.$('.fonts button[value="2011"].dropdown-menu-item--selected'), 'Production persists Open Sans')
  await checkFailureRecovery(productionOfflineId, true)
  await checkFailureRecovery(productionFailedId, false)
  assert.deepEqual(failedFonts, [])
  assert.deepEqual(errors, [])
  console.log(
    'Fonts: default, 20 searchable families, selection, reload, JSON restore, SVG/PNG exports, and production passed.',
  )
} catch (error) {
  console.log(
    'Failed UI state:',
    await page.evaluate(() => ({
      text: document.body.innerText.slice(-2500),
      popup: window.__excalidrawAPI?.getAppState().openPopup,
      elements: window.__excalidrawAPI
        ?.getSceneElements()
        .map(({ type, text, fontFamily }) => ({ type, text, fontFamily })),
    })),
  )
  await page.screenshot({ path: '/tmp/whiteboard-font-failure.png' })
  throw error
} finally {
  await browser.close()
  if (server.close) await server.close()
  else await new Promise((resolve) => server.httpServer.close(resolve))
}
