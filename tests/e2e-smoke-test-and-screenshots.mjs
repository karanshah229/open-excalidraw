import puppeteer from 'puppeteer-core'

const ARTIFACT_DIR = '/Users/karan/.gemini/antigravity/brain/a6b56a5d-05f3-42f2-b79b-7ceed663f504'
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

async function runE2ESmokeTest() {
  console.log('====================================================')
  console.log('📸 RUNNING LIVE E2E SMOKE TEST & CAPTURING SCREENSHOTS')
  console.log('====================================================\n')

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const boardId = `smoke-board-${Date.now().toString(36)}`
    const boardUrl = `http://localhost:5173/boards/${boardId}`
    console.log(`Target board URL: ${boardUrl}`)

    const shareConfig = {
      boardId,
      boardName: 'Real-Time Design Review',
      ownerId: 'owner-karan',
      ownerName: 'Karan Shah',
      generalAccess: 'anyone_with_link',
      generalRole: 'editor',
      invitedEmails: [],
      collaborators: {},
      scene: {
        elements: [
          {
            id: 'sample_box_1',
            type: 'rectangle',
            x: 250,
            y: 180,
            width: 260,
            height: 120,
            strokeColor: '#3b82f6',
            backgroundColor: '#1e3a8a',
            fillStyle: 'solid',
            strokeWidth: 2,
            roughness: 1,
            opacity: 100,
            isDeleted: false,
            version: 1,
            versionNonce: 101,
          },
          {
            id: 'sample_text_1',
            type: 'text',
            x: 280,
            y: 225,
            width: 200,
            height: 30,
            text: 'Real-Time Sync Active',
            fontSize: 20,
            fontFamily: 1,
            textAlign: 'center',
            verticalAlign: 'middle',
            strokeColor: '#ffffff',
            isDeleted: false,
            version: 1,
            versionNonce: 102,
          },
        ],
        appState: { viewBackgroundColor: '#121212' },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    // ------------------------------------------------------------------
    // TAB 1: OWNER (Host / Alice)
    // ------------------------------------------------------------------
    console.log('1. Launching Tab 1 (Host / Creator)...')
    const page1 = await browser.newPage()
    await page1.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })

    page1.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('[Collab]') || text.includes('Anonymous')) {
        console.log(`   [Tab 1 Log] ${text}`)
      }
    })

    await page1.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
    await page1.evaluate((cfg) => {
      localStorage.setItem('agentic-whiteboard:library:v1', '[]')
      localStorage.setItem(`agentic-whiteboard:share:${cfg.boardId}`, JSON.stringify(cfg))
    }, shareConfig)

    await page1.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page1.waitForSelector('.excalidraw', { timeout: 15000 })
    console.log('   ✓ Tab 1: Excalidraw mounted with initial canvas elements')

    // ------------------------------------------------------------------
    // TAB 2: ANONYMOUS GUEST (Collaborator / Anonymous Mumbai)
    // ------------------------------------------------------------------
    console.log('\n2. Launching Tab 2 (Guest / Collaborator)...')
    const page2 = await browser.newPage()
    await page2.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })

    page2.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('[Collab]') || text.includes('Anonymous')) {
        console.log(`   [Tab 2 Log] ${text}`)
      }
    })

    await page2.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
    await page2.evaluate((cfg) => {
      localStorage.setItem('agentic-whiteboard:library:v1', '[]')
      localStorage.setItem(`agentic-whiteboard:share:${cfg.boardId}`, JSON.stringify(cfg))
    }, shareConfig)

    await page2.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page2.waitForSelector('.excalidraw', { timeout: 15000 })
    console.log('   ✓ Tab 2: Excalidraw mounted as Anonymous Collaborator')

    // Allow presence handshakes to establish in RTDB
    await new Promise((r) => setTimeout(r, 2000))

    // ------------------------------------------------------------------
    // 3. SIMULATE LIVE COLLABORATION POINTER MOVEMENTS
    // ------------------------------------------------------------------
    console.log('\n3. Moving guest pointer on Tab 2 across canvas coordinates...')
    for (let offset = 0; offset <= 200; offset += 40) {
      await page2.mouse.move(450 + offset, 280 + offset * 0.5)
      await new Promise((r) => setTimeout(r, 60))
    }
    await new Promise((r) => setTimeout(r, 1500))

    // ------------------------------------------------------------------
    // 4. CAPTURE HIGH-RES SCREENSHOTS
    // ------------------------------------------------------------------
    const pathOwner = `${ARTIFACT_DIR}/collab_owner_view.png`
    const pathGuest = `${ARTIFACT_DIR}/collab_guest_view.png`

    console.log('\n4. Capturing screenshots...')
    await page1.screenshot({ path: pathOwner, fullPage: false })
    console.log(`   ✓ Saved Host View: ${pathOwner}`)

    await page2.screenshot({ path: pathGuest, fullPage: false })
    console.log(`   ✓ Saved Collaborator View: ${pathGuest}`)

    console.log('\n====================================================')
    console.log('🎉 E2E SMOKE TEST COMPLETE & SCREENSHOTS CAPTURED!')
    console.log('====================================================\n')
  } catch (err) {
    console.error('❌ E2E Smoke test error:', err)
    throw err
  } finally {
    await browser.close()
  }
}

void runE2ESmokeTest()
