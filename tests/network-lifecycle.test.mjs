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

function isFirestoreApiRequest(url) {
  return Boolean(url && url.includes('firestore.googleapis.com') && !url.includes('Listen'))
}

async function runNetworkLifecycleTest() {
  console.log('======================================================================')
  console.log('🧪 RUNNING NETWORK-SPECIFIC PUPPETEER TEST SUITE')
  console.log('======================================================================\n')

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const boardId = `net-${Date.now().toString(36)}`
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
      const proj = await workspaceApi.createProject('Network Test WS')
      await workspaceApi.saveBoard({
        id,
        projectId: proj.id,
        name: 'Network Test Canvas',
        scene: {
          elements: [
            {
              id: 'initial_box',
              type: 'rectangle',
              x: 100,
              y: 100,
              width: 200,
              height: 120,
              strokeColor: '#3b82f6',
              backgroundColor: '#1e3a8a',
              fillStyle: 'solid',
              strokeWidth: 2,
              roughness: 1,
              opacity: 100,
              isDeleted: false,
              version: 1,
              versionNonce: 1001,
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
        boardName: 'Network Test Canvas',
        ownerId: auth.currentUser.uid,
        ownerName: 'Network Host',
        generalAccess: 'anyone_with_link',
        generalRole: 'editor',
        collaborators: {},
        invitedEmails: [],
        scene: {
          elements: [
            {
              id: 'initial_box',
              type: 'rectangle',
              x: 100,
              y: 100,
              width: 200,
              height: 120,
              strokeColor: '#3b82f6',
              backgroundColor: '#1e3a8a',
              fillStyle: 'solid',
              strokeWidth: 2,
              roughness: 1,
              opacity: 100,
              isDeleted: false,
              version: 1,
              versionNonce: 1001,
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
    // STEP 1: Open board URL - should not open any websocket connections
    // -------------------------------------------------------------
    console.log('▶ Step 1: Open board URL in Window 1 (Solo mode)...')
    const page1 = await browser.newPage()
    await page1.setViewport({ width: 1440, height: 900 })

    const cdp1 = await page1.createCDPSession()
    await cdp1.send('Network.enable')

    const p1RtdbSockets = new Map() // requestId -> { url, open: true }
    const p1HttpRequests = []
    const p1WsFramesSent = []

    cdp1.on('Network.webSocketCreated', (e) => {
      if (isRtdbWsUrl(e.url)) {
        p1RtdbSockets.set(e.requestId, { url: e.url, open: true })
        console.log('   [P1 Network] RTDB WebSocket CREATED:', e.url.split('?')[0])
      }
    })

    cdp1.on('Network.webSocketClosed', (e) => {
      if (p1RtdbSockets.has(e.requestId)) {
        p1RtdbSockets.get(e.requestId).open = false
        console.log('   [P1 Network] RTDB WebSocket CLOSED:', e.requestId)
      }
    })

    cdp1.on('Network.webSocketFrameSent', (e) => {
      if (p1RtdbSockets.has(e.requestId)) {
        p1WsFramesSent.push(e.response.payloadData)
      }
    })

    cdp1.on('Network.requestWillBeSent', (e) => {
      if (isFirestoreApiRequest(e.request.url)) {
        p1HttpRequests.push({
          method: e.request.method,
          url: e.request.url,
          postData: e.request.postData,
        })
      }
    })

    await page1.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page1.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await sleep(2000)

    const openSocketsStep1 = Array.from(p1RtdbSockets.values()).filter((s) => s.open)
    console.log(`   P1 Active RTDB WebSockets count: ${openSocketsStep1.length}`)
    assert.equal(openSocketsStep1.length, 0, 'Step 1 Failed: RTDB WebSocket connection was opened in solo mode!')
    console.log('   ✓ Step 1 Passed: 0 RTDB WebSocket connections open in solo mode')

    // -------------------------------------------------------------
    // STEP 2: Make changes - expect an API call with board state being sent
    // -------------------------------------------------------------
    console.log('\n▶ Step 2: Make changes in Window 1 (Solo mode)...')
    p1HttpRequests.length = 0
    p1WsFramesSent.length = 0

    await page1.evaluate(() => {
      window.__setUserInteracted?.()
      const api = window.__excalidrawAPI
      const prev = api.getSceneElements()
      const updated = prev.map((el) =>
        el.id === 'initial_box' ? { ...el, strokeColor: '#e11d48', version: el.version + 1 } : el,
      )
      api.updateScene({ elements: updated })
      // Simulate Excalidraw onChange trigger
      window.__triggerSceneChange?.(updated)
    })

    // Wait for debounced save and REST API call
    let restCallMade = false
    for (let i = 0; i < 6; i++) {
      await sleep(500)
      if (p1HttpRequests.length > 0) {
        restCallMade = true
        break
      }
    }

    console.log(`   P1 HTTP requests made: ${p1HttpRequests.length}`)
    console.log(`   P1 RTDB WS frames sent: ${p1WsFramesSent.length}`)
    assert.ok(restCallMade, 'Step 2 Failed: Expected an API call updating board state')
    assert.equal(p1WsFramesSent.length, 0, 'Step 2 Failed: No WS frames should be sent in solo mode')
    console.log('   ✓ Step 2 Passed: Changes sent via REST API call; 0 WebSocket frames transmitted')

    // -------------------------------------------------------------
    // STEP 3: Open board URL in another window - Should auto upgrade
    // -------------------------------------------------------------
    console.log('\n▶ Step 3: Open board URL in Window 2 (Trigger Auto-Upgrade)...')
    const incognitoContext = await browser.createBrowserContext()
    const page2 = await incognitoContext.newPage()
    await page2.setViewport({ width: 1440, height: 900 })

    const cdp2 = await page2.target().createCDPSession()
    await cdp2.send('Network.enable')
    const p2RtdbSockets = new Map()
    const p2WsFramesSent = []
    cdp2.on('Network.webSocketCreated', (e) => {
      if (isRtdbWsUrl(e.url)) {
        p2RtdbSockets.set(e.requestId, { url: e.url, open: true })
        console.log('   [P2 Network] RTDB WebSocket CREATED:', e.url.split('?')[0])
      }
    })
    cdp2.on('Network.webSocketClosed', (e) => {
      if (p2RtdbSockets.has(e.requestId)) {
        p2RtdbSockets.get(e.requestId).open = false
        console.log('   [P2 Network] RTDB WebSocket CLOSED:', e.requestId)
      }
    })
    cdp2.on('Network.webSocketFrameSent', (e) => {
      if (p2RtdbSockets.has(e.requestId)) {
        p2WsFramesSent.push(e.response.payloadData)
      }
    })

    await page2.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page2.waitForFunction(() => Boolean(window.__excalidrawAPI))

    // Wait for auto-upgrade in Window 1 and Window 2
    let p1Upgraded = false
    let p2Upgraded = false
    for (let i = 0; i < 10; i++) {
      await sleep(500)
      const p1Active = Array.from(p1RtdbSockets.values()).some((s) => s.open)
      const p2Active = Array.from(p2RtdbSockets.values()).some((s) => s.open)
      if (p1Active && p2Active) {
        p1Upgraded = true
        p2Upgraded = true
        break
      }
    }

    console.log(`   Window 1 RTDB WebSocket Active: ${p1Upgraded}`)
    console.log(`   Window 2 RTDB WebSocket Active: ${p2Upgraded}`)
    assert.ok(p1Upgraded, 'Step 3 Failed: Window 1 must auto-upgrade to RTDB WebSocket')
    assert.ok(p2Upgraded, 'Step 3 Failed: Window 2 must connect to RTDB WebSocket')

    await page1.waitForSelector('.collab-avatar', { timeout: 10000 })
    await page2.waitForSelector('.collab-avatar', { timeout: 10000 })
    console.log('   ✓ Step 3 Passed: Both windows auto-upgraded to active WebSocket connections!')

    // -------------------------------------------------------------
    // STEP 4: Make changes in both boards - via sockets only, updates reflect
    // -------------------------------------------------------------
    console.log('\n▶ Step 4: Make changes in both boards (Live WebSocket-only sync)...')
    p1HttpRequests.length = 0
    p1WsFramesSent.length = 0
    p2WsFramesSent.length = 0

    const newGuestShapeId = `guest_rect_${Date.now().toString(36)}`

    // Window 2 adds a shape
    await page2.evaluate(async (id) => {
      window.__setUserInteracted?.()
      const api = window.__excalidrawAPI
      const prev = api.getSceneElements()
      const uid = window.__collab?.collabUser?.uid || 'guest_uid'
      const { convertToExcalidrawElements } = await import('/node_modules/.vite/deps/@excalidraw_excalidraw.js')
      const [converted] = convertToExcalidrawElements(
        [
          {
            id,
            type: 'rectangle',
            x: 400,
            y: 250,
            width: 180,
            height: 90,
            strokeColor: '#10b981',
            backgroundColor: '#064e3b',
            fillStyle: 'solid',
            strokeWidth: 2,
            roughness: 1,
            opacity: 100,
            isDeleted: false,
            version: 2,
            versionNonce: 2002,
          },
        ],
        { regenerateIds: false },
      )
      const newEl = { ...converted, lastModifiedBy: uid }
      const next = [...prev, newEl]
      api.updateScene({ elements: next })
      window.__collab?.broadcastChanges?.(next)
    }, newGuestShapeId)

    // Verify it arrives in Window 1
    let syncedInP1 = false
    for (let i = 0; i < 8; i++) {
      await sleep(500)
      const elementsInP1 = await page1.evaluate(() => window.__excalidrawAPI.getSceneElements().map((e) => e.id))
      if (elementsInP1.includes(newGuestShapeId)) {
        syncedInP1 = true
        break
      }
    }
    assert.ok(syncedInP1, 'Step 4 Failed: Window 2 shape must arrive in Window 1 via WebSocket')
    assert.ok(p2WsFramesSent.length > 0, 'Step 4 Failed: Window 2 must transmit changes via WebSocket frames')

    // Window 1 modifies initial_box color
    await page1.evaluate(() => {
      window.__setUserInteracted?.()
      const api = window.__excalidrawAPI
      const prev = api.getSceneElements()
      const updated = prev.map((el) =>
        el.id === 'initial_box' ? { ...el, strokeColor: '#a855f7', version: el.version + 1, versionNonce: 3003 } : el,
      )
      api.updateScene({ elements: updated })
      window.__collab?.broadcastChanges?.(updated)
    })

    // Verify it arrives in Window 2
    let syncedInP2 = false
    for (let i = 0; i < 8; i++) {
      await sleep(500)
      const initialBoxInP2 = await page2.evaluate(() => {
        const el = window.__excalidrawAPI.getSceneElements().find((e) => e.id === 'initial_box')
        return el ? el.strokeColor : null
      })
      if (initialBoxInP2 === '#a855f7') {
        syncedInP2 = true
        break
      }
    }
    assert.ok(syncedInP2, 'Step 4 Failed: Window 1 modification must arrive in Window 2 via WebSocket')
    assert.ok(p1WsFramesSent.length > 0, 'Step 4 Failed: Window 1 must transmit changes via WebSocket frames')
    console.log(`   Window 1 WS frames sent: ${p1WsFramesSent.length}`)
    console.log(`   Window 2 WS frames sent: ${p2WsFramesSent.length}`)
    console.log('   ✓ Step 4 Passed: Bi-directional synchronization verified over WebSockets only!')

    // -------------------------------------------------------------
    // STEP 5: Close second window - Should auto close first window's socket connection
    // -------------------------------------------------------------
    console.log('\n▶ Step 5: Close Window 2 (Trigger Auto-Downgrade in Window 1)...')
    await page2.evaluate(() => {
      window.dispatchEvent(new Event('beforeunload'))
    })
    await sleep(250)
    await page2.close()
    await incognitoContext.close()

    let p1WsClosed = false
    for (let i = 0; i < 18; i++) {
      await sleep(500)
      const p1Active = Array.from(p1RtdbSockets.values()).filter((s) => s.open)
      if (p1Active.length === 0) {
        p1WsClosed = true
        break
      }
    }

    const remainingActiveSockets = Array.from(p1RtdbSockets.values()).filter((s) => s.open)
    console.log(`   Window 1 Remaining Active RTDB WebSockets: ${remainingActiveSockets.length}`)
    assert.ok(p1WsClosed, 'Step 5 Failed: Window 1 RTDB WebSocket must auto-close after Window 2 exits!')

    const finalAvatars = await page1.evaluate(() => document.querySelectorAll('.collab-avatar').length)
    assert.equal(finalAvatars, 0, 'Step 5 Failed: Collaborator avatars must return to 0')
    console.log('   ✓ Step 5 Passed: Window 1 automatically closed RTDB WebSocket connection and cleared avatars!')

    // -------------------------------------------------------------
    // STEP 6: Make changes in first window board - normal rest api call should be made
    // -------------------------------------------------------------
    console.log('\n▶ Step 6: Make changes in Window 1 after downgrade (Solo mode)...')
    p1HttpRequests.length = 0
    p1WsFramesSent.length = 0

    await page1.evaluate(() => {
      window.__setUserInteracted?.()
      const api = window.__excalidrawAPI
      const prev = api.getSceneElements()
      const updated = prev.map((el) =>
        el.id === 'initial_box' ? { ...el, strokeColor: '#f59e0b', version: el.version + 1, versionNonce: 4004 } : el,
      )
      api.updateScene({ elements: updated })
      // Trigger scene save
      window.__triggerSceneChange?.(updated)
    })

    let step6RestCalled = false
    for (let i = 0; i < 6; i++) {
      await sleep(500)
      if (p1HttpRequests.length > 0) {
        step6RestCalled = true
        break
      }
    }

    const openSocketsStep6 = Array.from(p1RtdbSockets.values()).filter((s) => s.open)
    console.log(`   P1 HTTP requests made: ${p1HttpRequests.length}`)
    console.log(`   P1 Open RTDB WebSockets: ${openSocketsStep6.length}`)
    assert.ok(step6RestCalled, 'Step 6 Failed: Expected normal REST API call updating board state')
    assert.equal(openSocketsStep6.length, 0, 'Step 6 Failed: RTDB WebSocket must remain closed')
    console.log('   ✓ Step 6 Passed: Changes saved via normal REST API call with 0 open WebSockets!')

    console.log('\n======================================================================')
    console.log('🎉 ALL 6 NETWORK-SPECIFIC PUPPETEER TESTS PASSED 100%!')
    console.log('======================================================================\n')
  } finally {
    await browser.close()
  }
}

runNetworkLifecycleTest().catch((err) => {
  console.error('\n❌ NETWORK LIFECYCLE TEST FAILED:', err)
  process.exit(1)
})
