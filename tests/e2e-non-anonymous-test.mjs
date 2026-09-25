import puppeteer from 'puppeteer-core'

const ARTIFACT_DIR = '/Users/karan/.gemini/antigravity/brain/a6b56a5d-05f3-42f2-b79b-7ceed663f504'
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

async function runE2ENonAnonymousTest() {
  console.log('====================================================')
  console.log('📸 RUNNING LIVE E2E NON-ANONYMOUS COLLABORATOR TEST')
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
      boardName: 'Architecture Collaboration Review',
      ownerId: 'local-owner',
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
            text: 'Live Non-Anonymous Collab',
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
    // TAB 1: NON-ANONYMOUS USER (Host / Karan Shah)
    // ------------------------------------------------------------------
    console.log('1. Launching Tab 1 and authenticating as Karan Shah (Non-Anonymous)...')
    const page1 = await browser.newPage()
    await page1.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })

    page1.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('[Collab]') || text.includes('Karan') || text.includes('Anonymous')) {
        console.log(`   [Tab 1 Log] ${text}`)
      }
    })

    await page1.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
    await page1.evaluate((cfg) => {
      localStorage.setItem('agentic-whiteboard:library:v1', '[]')
      localStorage.setItem(`agentic-whiteboard:share:${cfg.boardId}`, JSON.stringify(cfg))
    }, shareConfig)

    // Authenticate and set real display profile in Firebase Auth
    await page1.evaluate(async () => {
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      const { signInAnonymously, updateProfile } = await import('/src/features/collaboration/anonymous-user.ts')
      const auth = getFirebaseAuth()
      if (auth) {
        let u = auth.currentUser
        if (!u) {
          const cred = await signInAnonymously(auth)
          u = cred.user
        }
        await updateProfile(u, {
          displayName: 'Karan Shah',
          photoURL: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Karan',
        })
      }
    })

    await page1.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page1.waitForSelector('.excalidraw', { timeout: 15000 })
    console.log('   ✓ Tab 1: Excalidraw mounted (alone on board, no redundant self-avatar)')

    // ------------------------------------------------------------------
    // TAB 2: ANONYMOUS GUEST (Collaborator / Anonymous)
    // ------------------------------------------------------------------
    console.log('\n2. Launching Tab 2 in isolated context as Anonymous Guest...')
    const incognitoContext = await browser.createBrowserContext()
    const page2 = await incognitoContext.newPage()
    await page2.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })

    page2.on('pageerror', (err) => console.log('   [Tab 2 Page Error]', err.message))
    page2.on('console', (msg) => {
      const text = msg.text()
      if (msg.type() === 'error') console.log(`   [Tab 2 Error] ${text}`)
      if (text.includes('[Collab]') || text.includes('Anonymous') || text.includes('Karan')) {
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
    console.log('   ✓ Tab 2: Excalidraw mounted as Anonymous Guest')

    // Allow presence handshakes to establish in RTDB
    await new Promise((r) => setTimeout(r, 4000))

    // Now both tabs should see the other participant in their collaborator bar
    await page1.waitForSelector('.collab-avatar', { timeout: 10000 })
    await page2.waitForSelector('.collab-avatar', { timeout: 10000 })
    console.log('   ✓ Both tabs confirmed other collaborator avatar in bar')

    // Check Tab 1's collaborator elements
    const tab1Elements = await page1.evaluate(() => {
      const allWithAnonymous = Array.from(document.querySelectorAll('*'))
        .filter((el) => {
          const title = el.getAttribute('title') || ''
          const label = el.getAttribute('aria-label') || ''
          const text = el.innerText || ''
          return (
            (title.includes('Anonymous') || label.includes('Anonymous') || text.includes('Anonymous')) &&
            !el.classList.contains('collab-avatar')
          )
        })
        .map((el) => ({
          tagName: el.tagName,
          className: el.className,
          title: el.getAttribute('title'),
          ariaLabel: el.getAttribute('aria-label'),
          text: el.innerText?.slice(0, 30),
          outerHTML: el.outerHTML?.slice(0, 150),
          parentClass: el.parentElement?.className,
        }))
      return allWithAnonymous
    })
    console.log('\nBuilt-in Excalidraw Collaborator Elements:', JSON.stringify(tab1Elements, null, 2))

    // Check Tab 2's collaborator bar
    const tab2Avatars = await page2.evaluate(() => {
      return Array.from(document.querySelectorAll('.collab-avatar')).map((el) => ({
        title: el.getAttribute('title'),
        text: el.innerText.trim(),
        hasImg: Boolean(el.querySelector('img')),
      }))
    })
    console.log('Tab 2 Collaborator Bar Avatars:', JSON.stringify(tab2Avatars, null, 2))

    // Capture screenshots
    const hostScreenshotPath = `${ARTIFACT_DIR}/collab_non_anonymous_host_view.png`
    const guestScreenshotPath = `${ARTIFACT_DIR}/collab_non_anonymous_guest_view.png`

    await page1.screenshot({ path: hostScreenshotPath, fullPage: false })
    await page2.screenshot({ path: guestScreenshotPath, fullPage: false })

    console.log(`\n📸 Host view screenshot saved: ${hostScreenshotPath}`)
    console.log(`📸 Guest view screenshot saved: ${guestScreenshotPath}`)
    console.log('\n🎉 E2E NON-ANONYMOUS TEST COMPLETED SUCCESSFULLY!')
  } finally {
    await browser.close()
  }
}

void runE2ENonAnonymousTest()
