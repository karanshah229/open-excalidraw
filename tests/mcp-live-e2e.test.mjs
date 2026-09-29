import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import path from 'node:path'
import { Client } from '../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE_URL = 'http://localhost:5173'
const BRIDGE_PORT = 8787

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runLiveMcpE2ETest() {
  console.log('======================================================================')
  console.log('🤖 RUNNING LIVE MCP SERVER & BROWSER BOARD INTERACTION E2E TEST')
  console.log('======================================================================\n')

  let client
  let transport
  let browser
  let page

  try {
    // ------------------------------------------------------------------
    // 1. Launch MCP Server Process over Stdio
    // ------------------------------------------------------------------
    console.log('1. Starting MCP Server child process...')
    const mcpEntry = path.resolve('packages/mcp/dist/index.js')
    transport = new StdioClientTransport({
      command: 'node',
      args: [mcpEntry],
      env: { ...process.env, AGENTIC_WHITEBOARD_BRIDGE_PORT: String(BRIDGE_PORT) },
    })
    client = new Client({ name: 'e2e-test-agent', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport)

    const listRes = await client.listTools()
    console.log(`   ✓ MCP server connected over stdio (${listRes.tools.length} tools registered)\n`)

    // ------------------------------------------------------------------
    // 2. Launch Puppeteer Browser & Open a Whiteboard Room
    // ------------------------------------------------------------------
    const boardId = `mcp-live-test-${Date.now().toString(36)}`
    const boardUrl = `${BASE_URL}/boards/${boardId}`
    console.log(`2. Launching Chrome to live board: ${boardUrl}`)

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })

    page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })

    // Seed shared board permissions so board opens immediately in editor mode
    const shareConfig = {
      boardId,
      boardName: 'MCP Live Integration Board',
      ownerId: 'local-owner',
      ownerName: 'Test Engineer',
      generalAccess: 'anyone_with_link',
      generalRole: 'editor',
      invitedEmails: [],
      collaborators: {},
      scene: {
        elements: [],
        appState: { viewBackgroundColor: '#ffffff' },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.evaluate(async (cfg) => {
      localStorage.setItem('agentic-whiteboard:library:v1', '[]')
      localStorage.setItem(`agentic-whiteboard:share:${cfg.boardId}`, JSON.stringify(cfg))
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      const { signInAnonymously } = await import('/src/features/collaboration/anonymous-user.ts')
      const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
      const auth = getFirebaseAuth()
      let u = auth?.currentUser
      if (!u && auth) {
        const cred = await signInAnonymously(auth)
        u = cred.user
      }
      const actualConfig = { ...cfg, ownerId: u ? u.uid : cfg.ownerId }
      try {
        await sharingService.saveShareConfig(actualConfig)
      } catch (e) {
        console.warn('Share config firestore save deferred:', e?.message)
      }
    }, shareConfig)

    page.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('[Collab]') || msg.type() === 'error') {
        console.log(`   [Browser] ${text}`)
      }
    })

    await page.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.excalidraw', { timeout: 15_000 })
    await page.waitForFunction(() => Boolean(window.__excalidrawAPI))
    console.log('   ✓ Live board opened in browser with Excalidraw mounted\n')

    // Wait for the browser WebSocket bridge to connect to the MCP server
    console.log('3. Waiting for browser adapter to connect to MCP WebSocket bridge...')
    let connected = false
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      const capRes = await client.callTool({ name: 'get_capabilities', arguments: {} })
      const text = capRes.content?.[0]?.text
      if (text) {
        const data = JSON.parse(text)
        if (data.whiteboardConnected) {
          connected = true
          console.log(`   ✓ Browser adapter connected! Current revision: ${data.revision}\n`)
          break
        }
      }
    }
    assert.ok(connected, 'Browser adapter failed to connect to MCP bridge within 10s')

    // ------------------------------------------------------------------
    // 4. Test: clear_canvas
    // ------------------------------------------------------------------
    console.log('4. Calling tool: clear_canvas...')
    const clearRes = await client.callTool({ name: 'clear_canvas', arguments: {} })
    const clearData = JSON.parse(clearRes.content[0].text)
    assert.ok(clearData.ok, 'clear_canvas should succeed')
    console.log('   ✓ Canvas cleared')

    // ------------------------------------------------------------------
    // 5. Test: insert_library_item (Microservice & Database Cluster)
    // ------------------------------------------------------------------
    console.log('\n5. Calling tool: insert_library_item (Order Service)...')
    const serviceRes = await client.callTool({
      name: 'insert_library_item',
      arguments: {
        template: 'microservice',
        label: 'Order Service API',
        x: 100,
        y: 150,
      },
    })
    const serviceData = JSON.parse(serviceRes.content[0].text)
    assert.ok(serviceData.ok, 'insert_library_item (microservice) should succeed')
    assert.equal(serviceData.template, 'microservice')
    assert.ok(serviceData.insertedCount >= 2, `Expected >= 2 inserted elements, got ${serviceData.insertedCount}`)
    const serviceId = serviceData.insertedIds[0]
    console.log(`   ✓ Inserted microservice box: id=${serviceId}`)

    console.log('\n6. Calling tool: insert_library_item (Orders Database)...')
    const dbRes = await client.callTool({
      name: 'insert_library_item',
      arguments: {
        template: 'database_cluster',
        label: 'Orders PostgreSQL DB',
        x: 450,
        y: 150,
      },
    })
    const dbData = JSON.parse(dbRes.content[0].text)
    assert.ok(dbData.ok, 'insert_library_item (database_cluster) should succeed')
    assert.ok(dbData.insertedCount >= 2, `Expected >= 2 inserted elements, got ${dbData.insertedCount}`)
    const dbId = dbData.insertedIds[0]
    console.log(`   ✓ Inserted database cluster box: id=${dbId}`)

    // ------------------------------------------------------------------
    // 7. Test: add_elements (Connecting Arrow)
    // ------------------------------------------------------------------
    console.log('\n7. Calling tool: add_elements (Binding Arrow)...')
    const arrowRes = await client.callTool({
      name: 'add_elements',
      arguments: {
        elements: [
          {
            type: 'arrow',
            x: 320,
            y: 200,
            width: 130,
            height: 0,
            startBinding: { elementId: serviceId },
            endBinding: { elementId: dbId },
            strokeColor: '#3b82f6',
            strokeWidth: 2,
          },
        ],
      },
    })
    const arrowData = JSON.parse(arrowRes.content[0].text)
    assert.ok(arrowData.ok, 'add_elements should succeed')
    console.log(`   ✓ Arrow added. Total elements on board: ${arrowData.elementCount}`)

    // ------------------------------------------------------------------
    // 8. Test: get_canvas & find_elements
    // ------------------------------------------------------------------
    console.log('\n8. Calling tool: get_canvas (full)...')
    const canvasRes = await client.callTool({ name: 'get_canvas', arguments: { detail: 'full' } })
    const canvasData = JSON.parse(canvasRes.content[0].text)
    const activeElements = canvasData.scene.elements.filter((e) => !e.isDeleted)
    assert.ok(activeElements.length >= 5, `Expected at least 5 active elements, got ${activeElements.length}`)
    console.log(`   ✓ get_canvas verified: ${activeElements.length} active shapes on live canvas`)

    console.log('\n9. Calling tool: find_elements (search: "PostgreSQL")...')
    const findRes = await client.callTool({ name: 'find_elements', arguments: { query: 'PostgreSQL' } })
    const findData = JSON.parse(findRes.content[0].text)
    assert.ok(findData.ok)
    assert.ok(findData.count >= 1, 'find_elements should locate the database node')
    console.log(`   ✓ find_elements returned ${findData.count} match(es) for 'PostgreSQL'`)

    // ------------------------------------------------------------------
    // 10. Test: auto_layout (Horizontal Arrangement)
    // ------------------------------------------------------------------
    console.log('\n10. Calling tool: auto_layout (horizontal)...')
    const layoutRes = await client.callTool({
      name: 'auto_layout',
      arguments: {
        layout: 'horizontal',
        spacing: 100,
        startX: 120,
        startY: 180,
      },
    })
    const layoutData = JSON.parse(layoutRes.content[0].text)
    assert.ok(layoutData.ok, 'auto_layout should succeed')
    console.log('   ✓ auto_layout successfully aligned shapes along horizontal pipeline')

    // ------------------------------------------------------------------
    // 11. Test: set_selection & get_selection
    // ------------------------------------------------------------------
    console.log('\n11. Calling tool: set_selection...')
    const selectRes = await client.callTool({
      name: 'set_selection',
      arguments: { ids: [serviceId] },
    })
    const selectData = JSON.parse(selectRes.content[0].text)
    assert.ok(selectData.ok)
    assert.deepEqual(selectData.selectedIds, [serviceId])
    console.log('   ✓ Selection set on serviceId in browser')

    // ------------------------------------------------------------------
    // 12. Test: zoom_to_content
    // ------------------------------------------------------------------
    console.log('\n12. Calling tool: zoom_to_content...')
    const zoomRes = await client.callTool({
      name: 'zoom_to_content',
      arguments: { animate: false },
    })
    const zoomData = JSON.parse(zoomRes.content[0].text)
    assert.ok(zoomData.ok, 'zoom_to_content should succeed')
    console.log('   ✓ Viewport centered on diagram content')

    // ------------------------------------------------------------------
    // 13. Test: set_canvas_background
    // ------------------------------------------------------------------
    console.log('\n13. Calling tool: set_canvas_background (#1e1e24)...')
    const bgRes = await client.callTool({
      name: 'set_canvas_background',
      arguments: { color: '#1e1e24' },
    })
    const bgData = JSON.parse(bgRes.content[0].text)
    assert.ok(bgData.ok)
    console.log('   ✓ Canvas background updated to dark theme')

    // ------------------------------------------------------------------
    // 14. Test: export_image (SVG vector export)
    // ------------------------------------------------------------------
    console.log('\n14. Calling tool: export_image (format: svg)...')
    const exportRes = await client.callTool({
      name: 'export_image',
      arguments: { darkMode: true, exportBackground: true },
    })
    const exportData = JSON.parse(exportRes.content[0].text)
    assert.ok(exportData.ok, 'export_image should succeed')
    assert.equal(exportData.format, 'svg')
    assert.ok(exportData.svg.includes('<svg') && exportData.svg.includes('</svg>'), 'Must produce valid SVG XML')
    console.log(`   ✓ Exported standalone SVG image (${exportData.svg.length} characters)`)

    // ------------------------------------------------------------------
    // 15. Verify Live State in Browser via Puppeteer DOM / Excalidraw API
    // ------------------------------------------------------------------
    console.log('\n15. Verifying live browser state directly via Puppeteer window.__excalidrawAPI...')
    const browserState = await page.evaluate(() => {
      const api = window.__excalidrawAPI
      if (!api) return null
      const elements = api.getSceneElements().filter((e) => !e.isDeleted)
      const appState = api.getAppState()
      return {
        elementCount: elements.length,
        types: elements.map((e) => e.type),
        viewBackgroundColor: appState.viewBackgroundColor,
      }
    })

    assert.ok(browserState, 'window.__excalidrawAPI must be available in development mode')
    assert.ok(browserState.elementCount >= 5, `Expected >= 5 elements in browser, got ${browserState.elementCount}`)
    assert.equal(browserState.viewBackgroundColor, '#1e1e24', 'Browser canvas background must match MCP change')
    console.log(`   ✓ Verified in Puppeteer browser: ${browserState.elementCount} live elements, background: ${browserState.viewBackgroundColor}`)

    // ------------------------------------------------------------------
    // 16. Test Workspace & Sharing Queries
    // ------------------------------------------------------------------
    console.log('\n16. Calling tool: get_share_info...')
    const shareRes = await client.callTool({
      name: 'get_share_info',
      arguments: { boardId },
    })
    const shareInfo = JSON.parse(shareRes.content[0].text)
    assert.ok(shareInfo.ok)
    assert.ok(shareInfo.shareUrl.includes(boardId))
    console.log(`   ✓ get_share_info returned shareUrl: ${shareInfo.shareUrl}`)

    console.log('\n======================================================================')
    console.log('🎉 ALL 16 LIVE MCP SERVER & BROWSER INTERACTIONS VERIFIED!')
    console.log('======================================================================\n')
  } finally {
    if (page) await page.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    if (client) await client.close().catch(() => {})
  }
}

void runLiveMcpE2ETest().catch((err) => {
  console.error('\n❌ MCP Live E2E Test Failed:', err)
  process.exit(1)
})
