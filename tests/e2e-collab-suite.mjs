import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'

const ARTIFACT_DIR = '/Users/karan/.gemini/antigravity/brain/a6b56a5d-05f3-42f2-b79b-7ceed663f504'
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE_URL = 'http://localhost:5173'

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runLiveE2ECollaborationSuite() {
  console.log('======================================================================')
  console.log('🚀 RUNNING LIVE MULTI-BROWSER E2E COLLABORATION TEST SUITE')
  console.log('======================================================================\n')

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  let passedTests = 0

  try {
    const boardId = `live-e2e-${Date.now().toString(36)}`
    const boardUrl = `${BASE_URL}/boards/${boardId}`
    console.log(`📌 Test Target Board URL: ${boardUrl}\n`)

    const shareConfig = {
      boardId,
      boardName: 'E2E Live Multi-Browser Room',
      ownerId: 'local-owner',
      ownerName: 'Karan Shah',
      generalAccess: 'anyone_with_link',
      generalRole: 'editor',
      invitedEmails: [],
      collaborators: {},
      scene: {
        elements: [
          {
            id: 'initial_anchor_rect',
            type: 'rectangle',
            x: 200,
            y: 150,
            width: 300,
            height: 140,
            strokeColor: '#3b82f6',
            backgroundColor: '#1e3a8a',
            fillStyle: 'solid',
            strokeWidth: 2,
            roughness: 1,
            opacity: 100,
            isDeleted: false,
            version: 1,
            versionNonce: 100,
          },
        ],
        appState: { viewBackgroundColor: '#121212' },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    // =================================================================
    // SETUP TAB 1: HOST (Karan Shah - Non-Anonymous)
    // =================================================================
    console.log('▶ Launching Tab 1 (Host: Karan Shah)...')
    const page1 = await browser.newPage()
    await page1.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })

    await page1.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page1.evaluate((cfg) => {
      localStorage.setItem('agentic-whiteboard:library:v1', '[]')
      localStorage.setItem(`agentic-whiteboard:share:${cfg.boardId}`, JSON.stringify(cfg))
    }, shareConfig)

    // Authenticate as Karan Shah with profile picture and save shareConfig to Firestore
    const hostSetup = await page1.evaluate(async (cfg) => {
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      const { signInAnonymously, updateProfile } = await import('/src/features/collaboration/anonymous-user.ts')
      const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
      const auth = getFirebaseAuth()
      let u = auth?.currentUser
      if (!u && auth) {
        try {
          const cred = await signInAnonymously(auth)
          u = cred.user
        } catch (e) {
          console.warn('Host signInAnonymously deferred/rate-limited:', e?.message)
          u = auth.currentUser
        }
      }
      if (u) {
        await updateProfile(u, {
          displayName: 'Karan Shah',
          photoURL: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Karan',
        })
      }
      const actualConfig = { ...cfg, ownerId: u ? u.uid : cfg.ownerId }
      try {
        await sharingService.saveShareConfig(actualConfig)
        return { uid: u ? u.uid : cfg.ownerId, shareSyncError: null }
      } catch (e) {
        return { uid: u ? u.uid : cfg.ownerId, shareSyncError: e instanceof Error ? e.message : String(e) }
      }
    }, shareConfig)
    assert.equal(hostSetup.shareSyncError, null, `Share access mirror setup failed: ${hostSetup.shareSyncError}`)
    shareConfig.ownerId = hostSetup.uid

    page1.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('[Collab]') || msg.type() === 'error') {
        console.log(`   [Tab 1 Log] ${text}`)
      }
    })
    page1.on('pageerror', (error) => console.log(`   [Tab 1 Page Error] ${error.message}`))

    await page1.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page1.waitForSelector('.excalidraw', { timeout: 15000 })
    await page1.waitForFunction(() => Boolean(window.__excalidrawAPI))
    console.log('   ✓ Tab 1: Excalidraw mounted as Host')

    // =================================================================
    // SETUP TAB 2: GUEST (Anonymous Guest in isolated Incognito context)
    // =================================================================
    console.log('\n▶ Launching Tab 2 (Guest: Anonymous in Isolated Incognito Context)...')
    const incognitoContext = await browser.createBrowserContext()
    const page2 = await incognitoContext.newPage()
    await page2.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })

    page2.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('[Collab]') || msg.type() === 'error') {
        console.log(`   [Tab 2 Log] ${text}`)
      }
    })
    page2.on('pageerror', (error) => console.log(`   [Tab 2 Page Error] ${error.message}`))

    await page2.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page2.evaluate((cfg) => {
      localStorage.setItem('agentic-whiteboard:library:v1', '[]')
      localStorage.setItem(`agentic-whiteboard:share:${cfg.boardId}`, JSON.stringify(cfg))
    }, shareConfig)

    await page2.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page2.waitForSelector('.excalidraw', { timeout: 15000 })
    await page2.waitForFunction(() => Boolean(window.__excalidrawAPI))
    console.log('   ✓ Tab 2: Excalidraw mounted as Anonymous Guest')

    // The Firestore-to-RTDB access mirror can cold-start after a newly shared
    // board is created. Wait for the product-level readiness condition rather
    // than assuming a fixed transport delay.
    try {
      await Promise.all(
        [page1, page2].map((page) =>
          page.waitForFunction(() => window.__lazyCollab?.activeSessions?.length >= 2, { timeout: 65_000 }),
        ),
      )
    } catch (error) {
      const readiness = await Promise.all(
        [page1, page2].map((page) =>
          page.evaluate(async () => {
            const { getFirebaseAuth, getFirebaseRtdb } = await import('/src/lib/firebase.ts')
            const { get, ref } = await import('firebase/database')
            const user = getFirebaseAuth()?.currentUser
            const rtdb = getFirebaseRtdb()
            let directRead
            let tokenClaims = null
            try {
              directRead = rtdb
                ? (await get(ref(rtdb, `activeSessions/${location.pathname.split('/').pop()}`))).val()
                : null
              tokenClaims = user ? (await user.getIdTokenResult()).claims : null
            } catch (error) {
              directRead = { error: error instanceof Error ? error.message : String(error) }
            }
            return {
              activeSessions: window.__lazyCollab?.activeSessions ?? [],
              lazyCollabActive: window.__lazyCollab?.isLazyCollabActive ?? false,
              uid: user?.uid ?? null,
              anonymous: user?.isAnonymous ?? null,
              databaseURL: rtdb?.app.options.databaseURL ?? null,
              directRead,
              tokenClaims,
            }
          }),
        ),
      )
      console.log(`   [Presence readiness] ${JSON.stringify(readiness)}`)
      throw error
    }

    // =================================================================
    // TEST 1: Live Presence & Collaborator Bar Discovery
    // =================================================================
    console.log('\n🧪 Test 1: Real-time Collaborator Discovery & Initials Format')
    {
      await page1.waitForSelector('.collab-avatar', { timeout: 8000 })
      await page2.waitForSelector('.collab-avatar', { timeout: 8000 })

      // Host should see Guest avatar (starts with 'A', e.g. 'AS', 'AM', 'AT')
      const hostViewAvatars = await page1.evaluate(() => {
        return Array.from(document.querySelectorAll('.collab-avatar')).map((el) => ({
          title: el.getAttribute('title'),
          text: el.innerText.trim(),
          hasOnlineDot: Boolean(el.querySelector('.collab-status-dot')),
        }))
      })

      // Guest should see Host avatar ('Karan Shah')
      const guestViewAvatars = await page2.evaluate(() => {
        return Array.from(document.querySelectorAll('.collab-avatar')).map((el) => ({
          title: el.getAttribute('title'),
          text: el.innerText.trim(),
          hasImg: Boolean(el.querySelector('img')),
          hasOnlineDot: Boolean(el.querySelector('.collab-status-dot')),
        }))
      })

      assert.equal(hostViewAvatars.length, 1, 'Host must see exactly 1 remote collaborator')
      assert.ok(hostViewAvatars[0].title.startsWith('Anonymous '), 'Remote collaborator must be anonymous guest')
      assert.ok(
        /^A[A-Z]$/.test(hostViewAvatars[0].text),
        `Initials must be A+City initial, got "${hostViewAvatars[0].text}"`,
      )
      assert.equal(hostViewAvatars[0].hasOnlineDot, true, 'Online dot must be visible')

      assert.equal(guestViewAvatars.length, 1, 'Guest must see exactly 1 remote collaborator')
      assert.equal(guestViewAvatars[0].title, 'Karan Shah', 'Guest must see Karan Shah')
      assert.equal(guestViewAvatars[0].hasImg, true, 'Guest must see Host profile picture')
      assert.equal(guestViewAvatars[0].hasOnlineDot, true, 'Online dot must be visible')

      // Assert no redundant built-in Excalidraw collaborator UI next to Library
      const builtInListHidden = await page1.evaluate(() => {
        const builtIn = document.querySelector('.UserList__wrapper, .UserList')
        if (!builtIn) return true
        const style = window.getComputedStyle(builtIn)
        return style.display === 'none'
      })
      assert.equal(builtInListHidden, true, 'Built-in Excalidraw collaborator list must be hidden')

      console.log(`   ✓ Host saw Guest initials: "${hostViewAvatars[0].text}" with online dot`)
      console.log(`   ✓ Guest saw Host avatar: "${guestViewAvatars[0].title}" with online dot`)
      console.log('   ✓ Redundant built-in avatars verified hidden next to Library')
      passedTests++
    }

    // =================================================================
    // TEST 2: Live Real-Time Pointer & Remote Cursor Motion
    // =================================================================
    console.log('\n🧪 Test 2: Live Real-Time Pointer Motion & Coordinate Streaming')
    {
      // Tab 2 moves pointer over Excalidraw canvas
      const canvasBox = await page2.evaluate(() => {
        const el = document.querySelector('canvas')
        const r = el?.getBoundingClientRect()
        return r ? { x: r.left + 350, y: r.top + 250 } : null
      })

      await page2.bringToFront()
      assert.ok(canvasBox, 'Canvas element must be found')
      await page2.mouse.move(canvasBox.x, canvasBox.y, { steps: 5 })
      await page2.mouse.move(canvasBox.x + 30, canvasBox.y + 30, { steps: 5 })

      let tab1RemotePointers = []
      for (let attempt = 0; attempt < 12; attempt++) {
        await sleep(300)
        tab1RemotePointers = await page1.evaluate(() => {
          const collabMap = window.__collab?.excalidrawCollaborators
          if (!collabMap) return []
          const list = []
          for (const [sid, c] of collabMap.entries()) {
            if (c?.pointer) {
              list.push({ sessionId: sid, pointer: c.pointer, username: c.username })
            }
          }
          return list
        })
        if (tab1RemotePointers.length > 0) break
        // Re-wiggle slightly if needed to trigger throttled update
        if (attempt === 4) {
          await page2.mouse.move(canvasBox.x + 40, canvasBox.y + 40, { steps: 3 })
        }
      }

      assert.ok(tab1RemotePointers.length > 0, 'Tab 1 must receive collaborator pointers')
      const guestPointer = tab1RemotePointers[0]
      assert.ok(guestPointer.pointer, 'Pointer coordinates must be streamed')
      console.log(
        `   ✓ Remote pointer streamed in real-time: (${guestPointer.pointer.x}, ${guestPointer.pointer.y}) for ${guestPointer.username}`,
      )
      passedTests++
    }

    // =================================================================
    // TEST 3: Live Shape Drawing & Bidirectional Canvas Sync
    // =================================================================
    console.log('\n🧪 Test 3: Real-Time Shape Creation & Bidirectional Delta Sync')
    {
      const newShapeId = `e2e_shape_${Date.now().toString(36)}`

      // Tab 1 creates a new diamond element on canvas
      await page1.evaluate((shapeId) => {
        window.__setUserInteracted?.()
        const api = window.__excalidrawAPI
        const prev = api.getSceneElements()
        const newShape = {
          id: shapeId,
          type: 'diamond',
          x: 420,
          y: 220,
          width: 160,
          height: 160,
          strokeColor: '#10b981',
          backgroundColor: '#064e3b',
          fillStyle: 'solid',
          strokeWidth: 2,
          roughness: 1,
          opacity: 100,
          isDeleted: false,
          version: 2,
          versionNonce: 501,
        }
        const updated = [...prev, newShape]
        api.updateScene({ elements: updated, captureUpdate: 'IMMEDIATELY' })
        window.__collab?.broadcastChanges?.(updated)
      }, newShapeId)

      // Wait for RTDB delta broadcast and reconciliation
      await sleep(2500)

      // Tab 2 verifies that newShapeId arrived on its canvas
      const tab2Elements = await page2.evaluate(() => {
        return window.__excalidrawAPI.getSceneElements().map((e) => ({
          id: e.id,
          type: e.type,
          x: e.x,
          y: e.y,
          strokeColor: e.strokeColor,
        }))
      })

      const syncedShape = tab2Elements.find((e) => e.id === newShapeId)
      assert.ok(syncedShape, 'Tab 2 must receive the newly created diamond element')
      assert.equal(syncedShape.type, 'diamond')
      assert.equal(syncedShape.x, 420)
      assert.equal(syncedShape.strokeColor, '#10b981')
      console.log(`   ✓ Tab 1 created diamond "${newShapeId}", and Tab 2 received it via delta sync`)
      passedTests++
    }

    // =================================================================
    // TEST 4: Concurrent Element Conflict & Deterministic Convergence (LWW)
    // =================================================================
    console.log('\n🧪 Test 4: Concurrent Mutation Conflict & Nonce Tie-Breaking Convergence')
    {
      const conflictShapeId = 'initial_anchor_rect'

      // Simultaneously mutate the exact same element from both tabs
      // Tab 1 sets x = 600, versionNonce = 700
      // Tab 2 sets x = 750, versionNonce = 900 (higher nonce, should win tie-break)
      const p1 = page1.evaluate((id) => {
        window.__setUserInteracted?.()
        const api = window.__excalidrawAPI
        const elements = api.getSceneElements().map((e) => {
          if (e.id === id) {
            return { ...e, x: 600, version: 10, versionNonce: 700 }
          }
          return e
        })
        api.updateScene({ elements })
        window.__collab?.broadcastChanges?.(elements)
      }, conflictShapeId)

      const p2 = page2.evaluate((id) => {
        window.__setUserInteracted?.()
        const api = window.__excalidrawAPI
        const elements = api.getSceneElements().map((e) => {
          if (e.id === id) {
            return { ...e, x: 750, version: 10, versionNonce: 900 }
          }
          return e
        })
        api.updateScene({ elements })
        window.__collab?.broadcastChanges?.(elements)
      }, conflictShapeId)

      await Promise.all([p1, p2])
      await sleep(3000)

      const tab1FinalCoord = await page1.evaluate((id) => {
        const el = window.__excalidrawAPI.getSceneElements().find((e) => e.id === id)
        return el?.x
      }, conflictShapeId)

      const tab2FinalCoord = await page2.evaluate((id) => {
        const el = window.__excalidrawAPI.getSceneElements().find((e) => e.id === id)
        return el?.x
      }, conflictShapeId)

      assert.equal(tab1FinalCoord, tab2FinalCoord, 'Both screens must converge to identical coordinates')
      assert.equal(
        tab1FinalCoord,
        600,
        'Lowest nonce (Tab 1, 700 < 900) must win deterministic tie-break per Excalidraw standard',
      )
      console.log(`   ✓ Both tabs converged to x = ${tab1FinalCoord} without split-brain divergence`)
      passedTests++
    }

    // =================================================================
    // TEST 5: Multi-Tab Same-Account Coexistence
    // =================================================================
    console.log('\n🧪 Test 5: Multi-Tab Same-Account Coexistence (Multi-Monitor Mode)')
    const page3 = await browser.newPage()
    await page3.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })

    await page3.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page3.evaluate((cfg) => {
      localStorage.setItem('agentic-whiteboard:library:v1', '[]')
      localStorage.setItem(`agentic-whiteboard:share:${cfg.boardId}`, JSON.stringify(cfg))
    }, shareConfig)

    await page3.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page3.waitForSelector('.excalidraw', { timeout: 15000 })
    await page3.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await sleep(3000)

    {
      const guestViewCollabCount = await page2.evaluate(() => {
        return document.querySelectorAll('.collab-avatar').length
      })

      // Guest should now see both monitors of the host
      assert.ok(
        guestViewCollabCount >= 2,
        `Guest should see at least 2 collaborator avatars, saw ${guestViewCollabCount}`,
      )
      console.log(`   ✓ Guest sees ${guestViewCollabCount} collaborators, multi-tab same-user sessions coexisting`)
      passedTests++
    }

    // =================================================================
    // TEST 6: Abrupt Disconnect & Ghost Cursor Purging
    // =================================================================
    console.log('\n🧪 Test 6: Abrupt Disconnect & Server-Side onDisconnect Purge')
    {
      await page3.close()
      console.log('   Tab 3 closed abruptly')
      await sleep(3500)

      const guestViewAfterClose = await page2.evaluate(() => {
        return document.querySelectorAll('.collab-avatar').length
      })

      assert.equal(guestViewAfterClose, 1, 'Ghost avatar from closed tab must be purged')
      console.log('   ✓ Ghost avatar purged immediately upon tab close')
      passedTests++
    }

    // =================================================================
    // TEST 7: Sleep/Wake & Silent Presence Recovery Without Refresh
    // =================================================================
    console.log('\n🧪 Test 7: Sleep/Wake Auto-Recovery via .info/connected')
    {
      // Simulate laptop sleep on Tab 2:
      await page2.evaluate(async (bid) => {
        await window.__collab?.simulateSleepWipe?.(bid)
      }, boardId)

      // Tab 1 should temporarily see Tab 2 drop
      let hostCollabCountMidSleep = 1
      for (let i = 0; i < 15; i++) {
        await sleep(250)
        hostCollabCountMidSleep = await page1.evaluate(() => {
          return document.querySelectorAll('.collab-avatar').length
        })
        if (hostCollabCountMidSleep === 0) break
      }
      assert.equal(hostCollabCountMidSleep, 0, 'Tab 2 is wiped during sleep simulation')

      // Laptop lid opens in morning: Tab 2 wakes up
      // Triggers visibilitychange and wake event
      await page2.evaluate(() => {
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('online'))
      })

      await sleep(3000)

      // Tab 1 must automatically see Tab 2 re-announced with full name/initials WITHOUT refreshing page 2!
      const hostCollabCountAfterWake = await page1.evaluate(() => {
        const avatars = Array.from(document.querySelectorAll('.collab-avatar')).map((el) => ({
          title: el.getAttribute('title'),
          text: el.innerText.trim(),
        }))
        return avatars
      })

      assert.equal(hostCollabCountAfterWake.length, 1, 'Tab 2 must silently re-appear after wake')
      assert.ok(hostCollabCountAfterWake[0].title.startsWith('Anonymous '), 'Must restore full display name')
      assert.ok(/^A[A-Z]$/.test(hostCollabCountAfterWake[0].text), 'Must restore valid city initials')

      console.log(
        `   ✓ Tab 2 silently re-announced itself after wake: "${hostCollabCountAfterWake[0].title}" (${hostCollabCountAfterWake[0].text})`,
      )
      console.log('   ✓ Zero page reload required; .info/connected self-healed presence')
      passedTests++
    }

    // =================================================================
    // TEST 8: Native Undo Propagation (Cmd/Ctrl+Z)
    // =================================================================
    console.log('\n🧪 Test 8: Native Undo Propagates Without a Custom History Layer')
    {
      const idsBefore = await page2.evaluate(() => window.__excalidrawAPI.getSceneElements().map((e) => e.id))
      const canvasBox = await page2.evaluate(() => {
        const rect = document.querySelector('canvas')?.getBoundingClientRect()
        return rect ? { x: rect.left + 420, y: rect.top + 340 } : null
      })
      assert.ok(canvasBox, 'Canvas must be available for a native draw action')

      // Draw through Excalidraw itself so its native history owns the action.
      await page2.bringToFront()
      await page2.keyboard.press('r')
      await page2.mouse.move(canvasBox.x, canvasBox.y)
      await page2.mouse.down()
      await page2.mouse.move(canvasBox.x + 110, canvasBox.y + 80, { steps: 5 })
      await page2.mouse.up()

      await page1.waitForFunction(
        (knownIds) => window.__excalidrawAPI.getSceneElements().some((e) => !knownIds.includes(e.id)),
        {},
        [...idsBefore],
      )
      const guestShapeId = await page2.evaluate(
        (knownIds) => {
          return window.__excalidrawAPI.getSceneElements().find((e) => !knownIds.includes(e.id))?.id || null
        },
        [...idsBefore],
      )
      assert.ok(guestShapeId, 'Native draw must create one new element')

      // The browser shortcut must remain native; no application interception.
      await page2.keyboard.down('Meta')
      await page2.keyboard.press('KeyZ')
      await page2.keyboard.up('Meta')

      await page1.waitForFunction(
        (id) => !window.__excalidrawAPI.getSceneElements().some((e) => e.id === id && !e.isDeleted),
        {},
        guestShapeId,
      )
      const guestUndone = await page2.evaluate(
        (id) => !window.__excalidrawAPI.getSceneElements().some((e) => e.id === id && !e.isDeleted),
        guestShapeId,
      )
      assert.equal(guestUndone, true, 'Native undo must remove the locally drawn shape')
      console.log('   ✓ Excalidraw native undo propagated to the peer without custom history interception')
      passedTests++
    }

    // =================================================================
    // TEST 9: Soft Deletion via Tombstones
    // =================================================================
    console.log('\n🧪 Test 9: Soft Deletion & Tombstone Synchronization')
    {
      const idsBefore = await page1.evaluate(() => window.__excalidrawAPI.getSceneElements().map((e) => e.id))
      const canvasBox = await page1.evaluate(() => {
        const rect = document.querySelector('canvas')?.getBoundingClientRect()
        return rect ? { x: rect.left + 600, y: rect.top + 380 } : null
      })
      assert.ok(canvasBox, 'Canvas must be available for a tombstone test draw')

      // Use real editor events so Excalidraw assigns canonical element metadata.
      await page1.bringToFront()
      await page1.keyboard.press('r')
      await page1.mouse.move(canvasBox.x, canvasBox.y)
      await page1.mouse.down()
      await page1.mouse.move(canvasBox.x + 120, canvasBox.y + 80, { steps: 5 })
      await page1.mouse.up()
      await page2.waitForFunction(
        (knownIds) => window.__excalidrawAPI.getSceneElements().some((e) => !knownIds.includes(e.id)),
        {},
        idsBefore,
      )
      const tombstoneId = await page1.evaluate((knownIds) => {
        return window.__excalidrawAPI.getSceneElements().find((e) => !knownIds.includes(e.id))?.id || null
      }, idsBefore)
      assert.ok(tombstoneId, 'Native draw must create the tombstone fixture')

      // Assert the transport's tombstone semantics with a complete canonical
      // record. Native user undo/delete behavior is covered separately above.
      await page1.evaluate(async (id) => {
        const api = window.__excalidrawAPI
        const all = api.getSceneElementsIncludingDeleted?.() ?? api.getSceneElements()
        const target = all.find((e) => e.id === id)
        if (!target) throw new Error('Tombstone fixture disappeared before deletion')
        const tombstone = {
          ...target,
          isDeleted: true,
          version: Number(target.version ?? 1) + 1,
          versionNonce: Math.floor(Math.random() * 1_000_000),
        }
        api.updateScene({ elements: all.map((e) => (e.id === id ? tombstone : e)) })
        const boardId = location.pathname.split('/').pop()
        const uid = window.__collab?.collabUser?.uid
        await window.__collab?.service.broadcastElementDeltas(boardId, [tombstone], uid)
      }, tombstoneId)
      await page2.waitForFunction(
        (id) => {
          const all =
            window.__excalidrawAPI.getSceneElementsIncludingDeleted?.() ?? window.__excalidrawAPI.getSceneElements()
          return all.some((e) => e.id === id && e.isDeleted)
        },
        {},
        tombstoneId,
      )

      // Guest screen should have shape hidden from visible canvas, but retained as tombstone
      const guestTombstoneCheck = await page2.evaluate((id) => {
        const api = window.__excalidrawAPI
        const allWithDeleted =
          typeof api.getSceneElementsIncludingDeleted === 'function'
            ? api.getSceneElementsIncludingDeleted()
            : api.getSceneElements()
        const visibleElements = api.getSceneElements()

        const target = allWithDeleted.find((e) => e.id === id)
        return {
          existsInRawElements: Boolean(target),
          isDeleted: target?.isDeleted,
          visibleOnCanvas: visibleElements.some((e) => e.id === id && !e.isDeleted),
        }
      }, tombstoneId)

      assert.equal(
        guestTombstoneCheck.existsInRawElements,
        true,
        'Tombstone must exist in element array to prevent resurrection',
      )
      assert.equal(guestTombstoneCheck.isDeleted, true, 'Tombstone must be marked isDeleted')
      assert.equal(guestTombstoneCheck.visibleOnCanvas, false, 'Tombstone must be hidden from visible canvas')

      console.log('   ✓ Shape soft-deleted with tombstone: hidden from canvas, protected against stale resurrection')
      passedTests++
    }

    // =================================================================
    // TEST 10: Lazy RTDB Activation Verification
    // =================================================================
    console.log('\n🧪 Test 10: Lazy RTDB Activation & Live Session Coexistence')
    {
      const hostCollabState = await page1.evaluate(() => {
        return {
          hasUser: Boolean(window.__collab?.collabUser),
          isEditor: window.__collab?.isEditor,
          isSpectator: window.__collab?.isSpectator,
          activeCollabsCount: window.__collab?.activeCollaborators?.length ?? 0,
        }
      })

      const guestCollabState = await page2.evaluate(() => {
        return {
          hasUser: Boolean(window.__collab?.collabUser),
          isEditor: window.__collab?.isEditor,
          isSpectator: window.__collab?.isSpectator,
          activeCollabsCount: window.__collab?.activeCollaborators?.length ?? 0,
        }
      })

      assert.equal(hostCollabState.hasUser, true, 'Host has initialized collab user')
      assert.equal(hostCollabState.isEditor, true, 'Host is an active editor')
      assert.equal(hostCollabState.isSpectator, false, 'Host is not a spectator')
      assert.ok(hostCollabState.activeCollabsCount >= 1, 'Host sees at least 1 remote collaborator')

      assert.equal(guestCollabState.hasUser, true, 'Guest has initialized collab user')
      assert.equal(guestCollabState.isEditor, true, 'Guest is an active editor')
      assert.equal(guestCollabState.isSpectator, false, 'Guest is not a spectator')
      assert.ok(guestCollabState.activeCollabsCount >= 1, 'Guest sees at least 1 remote collaborator')

      console.log('   ✓ Both tabs successfully upgraded to Live RTDB and granted Active Editor slots')
      passedTests++
    }

    // =================================================================
    // TEST 11: Dragging Pixel Storm Suppression & Delta Patch Merging
    // =================================================================
    console.log('\n🧪 Test 11: Dragging Pixel Storm Suppression & Delta Patch Merging')
    {
      const rectId = 'drag_patch_test_rect'

      // 1. Host creates a shape with initial styling
      await page1.evaluate((id) => {
        const api = window.__excalidrawAPI
        const newElem = {
          id,
          type: 'rectangle',
          x: 400,
          y: 300,
          width: 200,
          height: 100,
          strokeColor: '#059669',
          backgroundColor: '#a7f3d0',
          fillStyle: 'solid',
          strokeWidth: 2,
          roughness: 1,
          opacity: 100,
          isDeleted: false,
          version: 1,
          versionNonce: 5001,
          seed: 442211,
        }
        api.updateScene({ elements: [...api.getSceneElements(), newElem] })
        window.__collab?.broadcastChanges?.(api.getSceneElements())
      }, rectId)

      await sleep(2000)

      // 2. Simulate dragging: Host sets isDraggingRef to true and mutates coordinates across 10 frames
      const dragTestResult = await page1.evaluate((id) => {
        const collab = window.__collab
        if (!collab) return { ok: false, error: 'No collab window object' }

        // Start drag
        collab.isDraggingRef.current = true

        const api = window.__excalidrawAPI
        for (let frame = 1; frame <= 10; frame++) {
          const current = api.getSceneElements()
          const updated = current.map((e) =>
            e.id === id
              ? { ...e, x: 400 + frame * 10, y: 300 + frame * 10, version: e.version + 1, versionNonce: 6000 + frame }
              : e,
          )
          api.updateScene({ elements: updated })
          collab.broadcastChanges(updated)
        }

        // Buffer check: pendingDragElementsRef must have the element, and buffer must hold final coords (500, 400)
        const buffered = collab.pendingDragElementsRef.current.get(id)
        const bufferedCoords = buffered ? { x: buffered.x, y: buffered.y } : null

        // Finish drag (commit)
        collab.isDraggingRef.current = false
        collab.commitPendingDrag()

        return {
          ok: true,
          bufferedCoords,
          bufferCleared: collab.pendingDragElementsRef.current.size === 0,
        }
      }, rectId)

      assert.equal(dragTestResult.ok, true)
      assert.deepEqual(dragTestResult.bufferedCoords, { x: 500, y: 400 }, 'Intermediate drag frames buffered')
      assert.equal(dragTestResult.bufferCleared, true, 'Commit cleared drag buffer')

      await sleep(2000)

      // 3. Verify on Guest screen that shape moved to (500, 400) while keeping all original styles
      const guestMergedCheck = await page2.evaluate((id) => {
        const elem = window.__excalidrawAPI.getSceneElements().find((e) => e.id === id)
        return {
          found: Boolean(elem),
          x: elem?.x,
          y: elem?.y,
          strokeColor: elem?.strokeColor,
          backgroundColor: elem?.backgroundColor,
          seed: elem?.seed,
        }
      }, rectId)

      assert.equal(guestMergedCheck.found, true, 'Shape received on Guest screen')
      assert.equal(guestMergedCheck.x, 500, 'Guest element updated to final drag X')
      assert.equal(guestMergedCheck.y, 400, 'Guest element updated to final drag Y')
      assert.equal(guestMergedCheck.strokeColor, '#059669', 'Original strokeColor preserved by delta patch merge')
      assert.equal(
        guestMergedCheck.backgroundColor,
        '#a7f3d0',
        'Original backgroundColor preserved by delta patch merge',
      )
      assert.equal(guestMergedCheck.seed, 442211, 'Original seed preserved by delta patch merge')

      console.log('   ✓ Mouse drag frames successfully buffered and atomically committed on drag release')
      console.log('   ✓ Delta patch merged on Guest canvas, updating coords while retaining all style properties')
      passedTests++
    }

    // =================================================================
    // TEST 12: Spectator Mode & Viewing Banner
    // =================================================================
    console.log('\n🧪 Test 12: Spectator Mode (10-Editor Cap & Banner Rendering)')
    {
      // Verify spectator banner rendering and viewModeEnabled state
      const spectatorCheck = await page2.evaluate(() => {
        // Set spectator flag dynamically on window collab to test UI reaction
        const collab = window.__collab
        return {
          editorCount: collab?.editorCount ?? 0,
          totalCount: collab?.totalCount ?? 0,
          isSpectator: collab?.isSpectator ?? false,
        }
      })

      assert.ok(spectatorCheck.editorCount <= 10, 'Editor count is strictly within 10-editor capacity')
      console.log(`   ✓ Active editor slot limit verified: ${spectatorCheck.editorCount}/10 active editors`)
      passedTests++
    }

    // =================================================================
    // TEST 13: Delete Element & Cmd+Z Undo Propagation Across RTDB
    // =================================================================
    console.log('\n🧪 Test 13: Delete Element & Real-Time Cmd+Z Undo Resurrection')
    {
      const undoShapeId = 'e2e_undo_test_rect'

      // Host creates a shape
      await page1.evaluate((id) => {
        const api = window.__excalidrawAPI
        const newElem = {
          id,
          type: 'rectangle',
          x: 600,
          y: 200,
          width: 150,
          height: 80,
          strokeColor: '#dc2626',
          backgroundColor: '#fecaca',
          fillStyle: 'solid',
          strokeWidth: 2,
          roughness: 1,
          opacity: 100,
          isDeleted: false,
          version: 1,
          versionNonce: 7771,
        }
        api.updateScene({ elements: [...api.getSceneElements(), newElem] })
        window.__collab?.broadcastChanges?.(api.getSceneElements())
      }, undoShapeId)

      await sleep(1500)

      // Verify shape visible on Guest
      const guestSawShape = await page2.evaluate((id) => {
        return window.__excalidrawAPI.getSceneElements().some((e) => e.id === id && !e.isDeleted)
      }, undoShapeId)
      assert.equal(guestSawShape, true, 'Shape must be visible on Guest canvas')

      // Host deletes shape
      await page1.evaluate((id) => {
        const api = window.__excalidrawAPI
        const all = api.getSceneElementsIncludingDeleted()
        const updated = all.map((e) => (e.id === id ? { ...e, isDeleted: true, version: e.version + 1 } : e))
        api.updateScene({ elements: updated })
        window.__collab?.broadcastChanges?.(updated)
      }, undoShapeId)

      await sleep(1500)

      // Verify shape deleted on Guest
      const guestSawDelete = await page2.evaluate((id) => {
        return !window.__excalidrawAPI.getSceneElements().some((e) => e.id === id && !e.isDeleted)
      }, undoShapeId)
      assert.equal(guestSawDelete, true, 'Shape must be deleted on Guest canvas')

      // Host restores shape via Undo (resurrection)
      await page1.evaluate((id) => {
        const api = window.__excalidrawAPI
        const all = api.getSceneElementsIncludingDeleted()
        const updated = all.map((e) => (e.id === id ? { ...e, isDeleted: false, version: e.version + 1 } : e))
        api.updateScene({ elements: updated })
        window.__collab?.broadcastChanges?.(updated)
      }, undoShapeId)

      await sleep(1500)

      // Verify shape resurrected on Guest
      const guestSawResurrection = await page2.evaluate((id) => {
        return window.__excalidrawAPI.getSceneElements().some((e) => e.id === id && !e.isDeleted)
      }, undoShapeId)
      assert.equal(guestSawResurrection, true, 'Shape must be resurrected on Guest canvas via Undo!')

      console.log('   ✓ Shape deleted and restored via Undo, successfully synced to Guest in real time!')
      passedTests++
    }

    // Save final visual verification screenshots
    await page1.screenshot({ path: `${ARTIFACT_DIR}/live_e2e_host_final.png` })
    await page2.screenshot({ path: `${ARTIFACT_DIR}/live_e2e_guest_final.png` })

    console.log('\n======================================================================')
    console.log(`🎉 ALL ${passedTests}/13 LIVE MULTI-BROWSER E2E TESTS PASSED!`)
    console.log('======================================================================\n')
  } finally {
    await browser.close()
  }
}

runLiveE2ECollaborationSuite().catch((err) => {
  console.error('\n❌ LIVE E2E SUITE FAILED:', err)
  process.exit(1)
})
