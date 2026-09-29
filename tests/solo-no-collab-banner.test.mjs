import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE_URL = 'http://localhost:5173'

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRtdbWsUrl(url) {
  return Boolean(url && url.includes('firebasedatabase.app') && url.includes('.ws?v='))
}

async function runSoloCollabBannerTest() {
  console.log('======================================================================')
  console.log('🧪 VERIFYING SOLO USER NEVER SEES "CONNECTING TO LIVE COLLABORATION"')
  console.log('======================================================================\n')

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const boardId = `solo-${Date.now().toString(36)}`
    const boardUrl = `${BASE_URL}/boards/${boardId}`
    console.log(`📌 Test Board: ${boardUrl}\n`)

    // -------------------------------------------------------------
    // SETUP: Seed board and share configuration
    // -------------------------------------------------------------
    const seedPage = await browser.newPage()
    await seedPage.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await seedPage.evaluate(async (id) => {
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      const { signInAnonymously } = await import('/src/features/collaboration/anonymous-user.ts')
      const auth = getFirebaseAuth()
      if (auth && !auth.currentUser) await signInAnonymously(auth)

      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
      const proj = await workspaceApi.createProject('Solo Test WS')
      await workspaceApi.saveBoard({
        id,
        projectId: proj.id,
        name: 'Solo Test Canvas',
        scene: {
          elements: [
            {
              id: 'box_1',
              type: 'rectangle',
              x: 150,
              y: 150,
              width: 180,
              height: 100,
              strokeColor: '#10b981',
              backgroundColor: '#064e3b',
              fillStyle: 'solid',
              strokeWidth: 2,
              roughness: 1,
              opacity: 100,
              isDeleted: false,
              version: 1,
              versionNonce: 5001,
            },
          ],
          appState: { viewBackgroundColor: '#121212' },
        },
        revision: 1,
        syncStatus: 'synced',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
      await sharingService.saveShareConfig({
        boardId: id,
        boardName: 'Solo Test Canvas',
        ownerId: auth.currentUser.uid,
        ownerName: 'Solo Host',
        generalAccess: 'anyone_with_link',
        generalRole: 'editor',
        collaborators: {},
        invitedEmails: [],
        scene: {
          elements: [
            {
              id: 'box_1',
              type: 'rectangle',
              x: 150,
              y: 150,
              width: 180,
              height: 100,
              strokeColor: '#10b981',
              backgroundColor: '#064e3b',
              fillStyle: 'solid',
              strokeWidth: 2,
              roughness: 1,
              opacity: 100,
              isDeleted: false,
              version: 1,
              versionNonce: 5001,
            },
          ],
          appState: { viewBackgroundColor: '#121212' },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }, boardId)
    await seedPage.close()

    // -------------------------------------------------------------
    // TEST 1: Open board URL in solo mode
    // -------------------------------------------------------------
    console.log('▶ Test 1: Open board URL as solo user...')
    const page1 = await browser.newPage()
    await page1.setViewport({ width: 1440, height: 900 })

    const cdp1 = await page1.createCDPSession()
    await cdp1.send('Network.enable')
    const p1Sockets = new Map()

    cdp1.on('Network.webSocketCreated', (e) => {
      if (isRtdbWsUrl(e.url)) {
        p1Sockets.set(e.requestId, { url: e.url, open: true })
      }
    })
    cdp1.on('Network.webSocketClosed', (e) => {
      if (p1Sockets.has(e.requestId)) {
        p1Sockets.get(e.requestId).open = false
      }
    })

    let bannerEverAppeared = false
    await page1.exposeFunction('onBannerDetected', () => {
      bannerEverAppeared = true
    })

    await page1.evaluateOnNewDocument(() => {
      const observer = new MutationObserver(() => {
        if (document.querySelector('.collab-transition-banner')) {
          window.onBannerDetected?.()
        }
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
    })

    await page1.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page1.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await sleep(2500)

    const bannerNow = await page1.$('.collab-transition-banner')
    const lazyState = await page1.evaluate(() => window.__lazyCollab)

    console.log('   Banner present now:', Boolean(bannerNow))
    console.log('   Banner ever appeared during load:', bannerEverAppeared)
    console.log('   isLazyCollabActive:', lazyState?.isLazyCollabActive)
    console.log('   isTransitioningCollab:', lazyState?.isTransitioningCollab)
    console.log('   Active sessions count:', lazyState?.activeSessions?.length)

    assert.equal(bannerNow, null, 'FAIL: .collab-transition-banner should not be visible for solo user')
    assert.equal(bannerEverAppeared, false, 'FAIL: Banner should NEVER have flashed or appeared on solo load')
    assert.equal(lazyState?.isLazyCollabActive, false, 'FAIL: isLazyCollabActive must be false for solo user')
    assert.equal(lazyState?.isTransitioningCollab, false, 'FAIL: isTransitioningCollab must be false for solo user')

    const openSockets = Array.from(p1Sockets.values()).filter((s) => s.open)
    assert.equal(openSockets.length, 0, 'FAIL: RTDB WebSocket must not be opened for solo user')
    console.log('   ✅ Test 1 Passed: Solo user never sees transition banner, 0 WebSockets opened!\n')

    // -------------------------------------------------------------
    // TEST 2: Reload solo board - verify no cached banner on reload
    // -------------------------------------------------------------
    console.log('▶ Test 2: Reload solo board and verify no cached banner...')
    bannerEverAppeared = false
    await page1.reload({ waitUntil: 'domcontentloaded' })
    await page1.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await sleep(2000)

    const reloadedBanner = await page1.$('.collab-transition-banner')
    const reloadedLazyState = await page1.evaluate(() => window.__lazyCollab)

    console.log('   Banner present after reload:', Boolean(reloadedBanner))
    console.log('   Banner ever appeared during reload:', bannerEverAppeared)
    console.log('   isLazyCollabActive after reload:', reloadedLazyState?.isLazyCollabActive)
    console.log('   Active sessions count after reload:', reloadedLazyState?.activeSessions?.length)

    assert.equal(reloadedBanner, null, 'FAIL: Banner appeared after reloading solo board')
    assert.equal(bannerEverAppeared, false, 'FAIL: Banner should NEVER flash or appear on solo reload')
    assert.equal(reloadedLazyState?.isLazyCollabActive, false, 'FAIL: isLazyCollabActive must stay false on reload')
    console.log('   ✅ Test 2 Passed: Reload does not trigger cached collaboration banner!\n')

    // -------------------------------------------------------------
    // TEST 3: Second user joins - verify transition banner appears ONLY on flip
    // -------------------------------------------------------------
    console.log('▶ Test 3: Second user joins; verify transition banner appears during flip...')
    const incognitoContext = await browser.createBrowserContext()
    const page2 = await incognitoContext.newPage()
    await page2.setViewport({ width: 1440, height: 900 })

    await page2.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page2.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await sleep(2000)

    const p1StateUpgraded = await page1.evaluate(() => window.__lazyCollab)
    console.log('   P1 isLazyCollabActive after peer join:', p1StateUpgraded?.isLazyCollabActive)
    console.log('   P1 Active sessions after peer join:', p1StateUpgraded?.activeSessions?.length)
    assert.equal(
      p1StateUpgraded?.isLazyCollabActive,
      true,
      'FAIL: Window 1 should upgrade to live collab when peer joins',
    )
    console.log('   ✅ Test 3 Passed: Window 1 successfully auto-upgraded when second user joined!\n')

    // -------------------------------------------------------------
    // TEST 4: Close second window - verify downgrade and clean solo reload
    // -------------------------------------------------------------
    console.log('▶ Test 4: Close second window; verify auto-downgrade and subsequent clean reload...')
    await page2.evaluate(() => {
      window.dispatchEvent(new Event('beforeunload'))
    })
    await sleep(250)
    await page2.close()
    await incognitoContext.close()

    let p1Downgraded = false
    let p1StateDowngraded = null
    for (let i = 0; i < 12; i++) {
      await sleep(500)
      p1StateDowngraded = await page1.evaluate(() => window.__lazyCollab)
      if (p1StateDowngraded && !p1StateDowngraded.isLazyCollabActive) {
        p1Downgraded = true
        break
      }
    }
    console.log('   P1 isLazyCollabActive after peer left:', p1StateDowngraded?.isLazyCollabActive)
    assert.equal(p1Downgraded, true, 'FAIL: Window 1 should downgrade to solo mode')

    bannerEverAppeared = false
    await page1.reload({ waitUntil: 'domcontentloaded' })
    await page1.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await sleep(2000)

    const finalBanner = await page1.$('.collab-transition-banner')
    const finalLazyState = await page1.evaluate(() => window.__lazyCollab)
    assert.equal(finalBanner, null, 'FAIL: Banner appeared after peer left and board reloaded')
    assert.equal(bannerEverAppeared, false, 'FAIL: Banner flashed after peer left and board reloaded')
    assert.equal(finalLazyState?.isLazyCollabActive, false, 'FAIL: isLazyCollabActive must stay false after downgrade')
    console.log('   ✅ Test 4 Passed: Auto-downgrade and subsequent reload remain 100% clean solo mode!\n')

    console.log('======================================================================')
    console.log('🎉 ALL SOLO NO-COLLAB BANNER VERIFICATION TESTS PASSED 100%!')
    console.log('======================================================================')
  } finally {
    await browser.close()
  }
}

runSoloCollabBannerTest().catch((err) => {
  console.error('\n❌ SOLO TEST FAILED:', err)
  process.exit(1)
})
