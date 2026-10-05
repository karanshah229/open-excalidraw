import puppeteer from 'puppeteer-core'
import assert from 'node:assert'

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function runAutoZoomCenterTest() {
  console.log('======================================================================')
  console.log('🧪 VERIFYING BOARD AUTO-ZOOM & CENTERING WITH PADDING ON INITIAL LOAD')
  console.log('======================================================================\n')

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const page = await browser.newPage()
    page.on('console', (msg) => console.log('PAGE LOG:', msg.text()))
    const viewportWidth = 1280
    const viewportHeight = 800
    await page.setViewport({ width: viewportWidth, height: viewportHeight })

    // -------------------------------------------------------------
    // Test Case 1: Large Diagram (2600px wide) - Must zoom out (zoom < 1) & center
    // -------------------------------------------------------------
    console.log('▶ Test Case 1: Large Diagram (width: 2600px, height: 900px)...')
    const largeBoardId = `zoom-large-${Date.now().toString(36)}`
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })

    await page.evaluate(async (id) => {
      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
      const proj = await workspaceApi.createProject('Test Project')
      await workspaceApi.saveBoard({
        id,
        projectId: proj.id,
        name: 'Large Diagram Board',
        scene: {
          elements: [
            {
              id: 'box_left',
              type: 'rectangle',
              x: -300,
              y: -200,
              width: 400,
              height: 300,
              angle: 0,
              strokeColor: '#1e1e1e',
              backgroundColor: '#a5d8ff',
              fillStyle: 'solid',
              strokeWidth: 2,
              roughness: 1,
              opacity: 100,
              isDeleted: false,
              version: 1,
              versionNonce: 1,
            },
            {
              id: 'box_center',
              type: 'rectangle',
              x: 800,
              y: 0,
              width: 500,
              height: 400,
              angle: 0,
              strokeColor: '#1e1e1e',
              backgroundColor: '#b2f2bb',
              fillStyle: 'solid',
              strokeWidth: 2,
              roughness: 1,
              opacity: 100,
              isDeleted: false,
              version: 1,
              versionNonce: 2,
            },
            {
              id: 'box_right',
              type: 'rectangle',
              x: 1900,
              y: 200,
              width: 400,
              height: 300,
              angle: 0,
              strokeColor: '#1e1e1e',
              backgroundColor: '#ffc9c9',
              fillStyle: 'solid',
              strokeWidth: 2,
              roughness: 1,
              opacity: 100,
              isDeleted: false,
              version: 1,
              versionNonce: 3,
            },
          ],
          appState: { viewBackgroundColor: '#ffffff' },
        },
      })
    }, largeBoardId)

    // Navigate to the large board URL
    console.log(`  Opening board: ${BASE_URL}/boards/${largeBoardId}`)
    await page.goto(`${BASE_URL}/boards/${largeBoardId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () =>
        !!window.__excalidrawAPI && window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length >= 3,
      { timeout: 10000 },
    )
    // Allow auto-zoom and layout stabilization
    await sleep(800)

    const largeState = await page.evaluate(() => {
      const api = window.__excalidrawAPI
      const appState = api.getAppState()
      const els = api.getSceneElements().filter((e) => !e.isDeleted)
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity
      for (const el of els) {
        minX = Math.min(minX, el.x)
        minY = Math.min(minY, el.y)
        maxX = Math.max(maxX, el.x + el.width)
        maxY = Math.max(maxY, el.y + el.height)
      }
      const zoom = appState.zoom.value
      // Project content bounds to screen pixels: screen = (scene + scroll) * zoom
      const screenLeft = (minX + appState.scrollX) * zoom
      const screenTop = (minY + appState.scrollY) * zoom
      const screenRight = (maxX + appState.scrollX) * zoom
      const screenBottom = (maxY + appState.scrollY) * zoom
      return {
        zoom,
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        width: appState.width,
        height: appState.height,
        elementCount: els.length,
        contentBBox: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
        screenBBox: { screenLeft, screenTop, screenRight, screenBottom },
      }
    })

    console.log(`  Content Dimensions: ${largeState.contentBBox.width}px x ${largeState.contentBBox.height}px`)
    console.log(`  Resulting Zoom: ${largeState.zoom} (Expected < 1 to fit screen)`)
    console.log(`  Resulting Scroll: (${Math.round(largeState.scrollX)}, ${Math.round(largeState.scrollY)})`)
    console.log(
      `  Screen Position: Left=${Math.round(largeState.screenBBox.screenLeft)}px, Top=${Math.round(
        largeState.screenBBox.screenTop,
      )}px, Right=${Math.round(largeState.screenBBox.screenRight)}px, Bottom=${Math.round(
        largeState.screenBBox.screenBottom,
      )}px (Viewport: ${viewportWidth}x${viewportHeight})`,
    )

    // Assertions for Large Diagram:
    assert.ok(
      largeState.zoom < 1,
      `Expected zoom to be scaled down (< 1) for large 2600px content, got ${largeState.zoom}`,
    )
    assert.ok(
      largeState.screenBBox.screenLeft >= 10,
      `Expected left padding >= 10px, got ${largeState.screenBBox.screenLeft}px`,
    )
    assert.ok(
      largeState.screenBBox.screenRight <= viewportWidth - 10,
      `Expected right edge within viewport (${viewportWidth}px), got ${largeState.screenBBox.screenRight}px`,
    )
    assert.ok(
      largeState.screenBBox.screenTop >= 40,
      `Expected top padding below header >= 40px, got ${largeState.screenBBox.screenTop}px`,
    )
    assert.ok(
      largeState.screenBBox.screenBottom <= viewportHeight - 10,
      `Expected bottom edge within viewport (${viewportHeight}px), got ${largeState.screenBBox.screenBottom}px`,
    )
    console.log('  ✅ Large diagram correctly scaled (< 1) and centered with padding!\n')

    // -------------------------------------------------------------
    // Test Case 2: Small Diagram (300px wide) - Must NOT over-magnify (maxZoom: 1)
    // -------------------------------------------------------------
    console.log('▶ Test Case 2: Small Diagram (width: 300px, height: 200px)...')
    const smallBoardId = `zoom-small-${Date.now().toString(36)}`
    await page.evaluate(async (id) => {
      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
      const proj = await workspaceApi.createProject('Small Test')
      await workspaceApi.saveBoard({
        id,
        projectId: proj.id,
        name: 'Small Diagram Board',
        scene: {
          elements: [
            {
              id: 'box_small',
              type: 'rectangle',
              x: 100,
              y: 100,
              width: 300,
              height: 200,
              angle: 0,
              strokeColor: '#1e1e1e',
              backgroundColor: '#d0bfff',
              fillStyle: 'solid',
              strokeWidth: 2,
              roughness: 1,
              opacity: 100,
              isDeleted: false,
              version: 1,
              versionNonce: 1,
            },
          ],
          appState: { viewBackgroundColor: '#ffffff' },
        },
      })
    }, smallBoardId)

    await page.goto(`${BASE_URL}/boards/${smallBoardId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () =>
        !!window.__excalidrawAPI && window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length >= 1,
      { timeout: 10000 },
    )
    await sleep(800)

    const smallState = await page.evaluate(() => {
      const api = window.__excalidrawAPI
      const appState = api.getAppState()
      const els = api.getSceneElements().filter((e) => !e.isDeleted)
      const el = els[0]
      const zoom = appState.zoom.value
      const screenLeft = (el.x + appState.scrollX) * zoom
      const screenTop = (el.y + appState.scrollY) * zoom
      const screenRight = (el.x + el.width + appState.scrollX) * zoom
      const screenBottom = (el.y + el.height + appState.scrollY) * zoom
      return {
        zoom,
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        screenBBox: { screenLeft, screenTop, screenRight, screenBottom },
      }
    })

    console.log(`  Resulting Zoom: ${smallState.zoom} (Expected exactly 1, capped at maxZoom: 1)`)
    console.log(
      `  Screen Position: Left=${Math.round(smallState.screenBBox.screenLeft)}px, Top=${Math.round(
        smallState.screenBBox.screenTop,
      )}px, Right=${Math.round(smallState.screenBBox.screenRight)}px, Bottom=${Math.round(
        smallState.screenBBox.screenBottom,
      )}px`,
    )

    // Assertions for Small Diagram:
    assert.strictEqual(smallState.zoom, 1, `Expected zoom to be capped at 1 for small content, got ${smallState.zoom}`)
    assert.ok(
      smallState.screenBBox.screenLeft >= 50 && smallState.screenBBox.screenRight <= viewportWidth - 50,
      `Expected small content centered horizontally within viewport`,
    )
    assert.ok(
      smallState.screenBBox.screenTop >= 50 && smallState.screenBBox.screenBottom <= viewportHeight - 50,
      `Expected small content centered vertically within viewport`,
    )
    console.log('  ✅ Small diagram capped at zoom 1.0 and centered!\n')

    // -------------------------------------------------------------
    // Test Case 3: Architecture-scale fixture. Keep it self-contained: a
    // developer's historical board is neither a stable test dependency nor
    // necessarily accessible under production sharing rules.
    // -------------------------------------------------------------
    console.log('▶ Test Case 3: Target Real-World Architecture Board (2140px wide)...')
    const targetViewportWidth = 1440
    const targetViewportHeight = 900
    await page.setViewport({ width: targetViewportWidth, height: targetViewportHeight })

    const targetBoardId = `zoom-architecture-${Date.now().toString(36)}`
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.evaluate(async (id) => {
      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
      const project = await workspaceApi.createProject('Architecture Zoom Test')
      const elements = Array.from({ length: 24 }, (_, index) => ({
        id: `architecture-node-${index}`,
        type: 'rectangle',
        x: (index % 6) * 420,
        y: Math.floor(index / 6) * 260,
        width: 280,
        height: 150,
        angle: 0,
        strokeColor: '#1e1e1e',
        backgroundColor: '#dbeafe',
        fillStyle: 'solid',
        strokeWidth: 2,
        roughness: 1,
        opacity: 100,
        isDeleted: false,
        version: 1,
        versionNonce: index + 1,
      }))
      await workspaceApi.saveBoard({
        id,
        projectId: project.id,
        name: 'Architecture-scale Zoom Fixture',
        scene: { elements, appState: { viewBackgroundColor: '#ffffff' } },
      })
    }, targetBoardId)

    const targetBoardUrl = `${BASE_URL}/boards/${targetBoardId}`
    await page.goto(targetBoardUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () =>
        !!window.__excalidrawAPI && window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length > 20,
      { timeout: 10000 },
    )
    await sleep(800)

    const targetState = await page.evaluate(() => {
      const api = window.__excalidrawAPI
      const appState = api.getAppState()
      const els = api.getSceneElements().filter((e) => !e.isDeleted)
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity
      for (const el of els) {
        if (el.points && Array.isArray(el.points)) {
          for (const [px, py] of el.points) {
            minX = Math.min(minX, el.x + px)
            minY = Math.min(minY, el.y + py)
            maxX = Math.max(maxX, el.x + px)
            maxY = Math.max(maxY, el.y + py)
          }
        } else {
          minX = Math.min(minX, el.x)
          minY = Math.min(minY, el.y)
          maxX = Math.max(maxX, el.x + el.width)
          maxY = Math.max(maxY, el.y + el.height)
        }
      }
      const zoom = appState.zoom.value
      const screenLeft = (minX + appState.scrollX) * zoom
      const screenTop = (minY + appState.scrollY) * zoom
      const screenRight = (maxX + appState.scrollX) * zoom
      const screenBottom = (maxY + appState.scrollY) * zoom
      return {
        zoom,
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        elementCount: els.length,
        contentWidth: maxX - minX,
        contentHeight: maxY - minY,
        screenBBox: { screenLeft, screenTop, screenRight, screenBottom },
      }
    })

    console.log(`  Element Count: ${targetState.elementCount}`)
    console.log(
      `  Content Dimensions: ${Math.round(targetState.contentWidth)}px x ${Math.round(targetState.contentHeight)}px`,
    )
    console.log(`  Resulting Zoom: ${targetState.zoom}`)
    console.log(
      `  Screen Position: Left=${Math.round(targetState.screenBBox.screenLeft)}px, Top=${Math.round(
        targetState.screenBBox.screenTop,
      )}px, Right=${Math.round(targetState.screenBBox.screenRight)}px, Bottom=${Math.round(
        targetState.screenBBox.screenBottom,
      )}px (Viewport: ${targetViewportWidth}x${targetViewportHeight})`,
    )

    assert.ok(
      targetState.zoom <= 0.6,
      `Expected zoom <= 0.6 for real-world architecture board, got ${targetState.zoom}`,
    )
    assert.ok(targetState.screenBBox.screenLeft >= 40, 'Expected positive left screen padding (>= 40px)')
    assert.ok(
      targetState.screenBBox.screenRight <= targetViewportWidth - 40,
      'Expected diagram right edge within viewport (<= 1400px)',
    )
    assert.ok(
      targetState.screenBBox.screenTop >= 40,
      'Expected diagram top edge below header/floating toolbar (>= 40px)',
    )
    assert.ok(
      targetState.screenBBox.screenBottom <= targetViewportHeight - 40,
      'Expected diagram bottom edge within viewport (<= 860px)',
    )
    console.log('  ✅ Target Architecture Board loads centered and fully visible within viewport with padding!\n')

    console.log('======================================================================')
    console.log('🎉 ALL AUTO-ZOOM AND CENTERING TESTS PASSED!')
    console.log('======================================================================')
  } finally {
    await browser.close()
  }
}

runAutoZoomCenterTest().catch((err) => {
  console.error('❌ Test failed:', err)
  process.exit(1)
})
