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

    // Authenticate as Karan Shah with profile picture
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

    page1.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('[Collab]') || msg.type() === 'error') {
        console.log(`   [Tab 1 Log] ${text}`)
      }
    })

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

    await page2.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page2.evaluate((cfg) => {
      localStorage.setItem('agentic-whiteboard:library:v1', '[]')
      localStorage.setItem(`agentic-whiteboard:share:${cfg.boardId}`, JSON.stringify(cfg))
    }, shareConfig)

    await page2.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page2.waitForSelector('.excalidraw', { timeout: 15000 })
    await page2.waitForFunction(() => Boolean(window.__excalidrawAPI))
    console.log('   ✓ Tab 2: Excalidraw mounted as Anonymous Guest')

    // Allow presence handshakes to establish
    await sleep(3500)

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

      assert.ok(canvasBox, 'Canvas element must be found')
      await page2.mouse.move(canvasBox.x, canvasBox.y)
      await sleep(1000)

      // Tab 1 should receive Tab 2's pointer in activeCollaborators / excalidrawCollaborators
      const tab1RemotePointers = await page1.evaluate(() => {
        const collabMap = window.__collab?.excalidrawCollaborators
        if (!collabMap) return []
        const list = []
        for (const [sid, c] of collabMap.entries()) {
          list.push({ sessionId: sid, pointer: c.pointer, username: c.username })
        }
        return list
      })

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
        api.updateScene({ elements: updated })
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

      await sleep(2000)

      // Tab 1 should temporarily see Tab 2 drop
      const hostCollabCountMidSleep = await page1.evaluate(() => {
        return document.querySelectorAll('.collab-avatar').length
      })
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
    // TEST 8: User-Scoped Undo/Redo Isolation (Ctrl+Z)
    // =================================================================
    console.log('\n🧪 Test 8: User-Scoped Undo Isolation (Preserves Co-worker Shapes)')
    {
      const hostShapeId = 'host_preserved_rect'
      const guestShapeId = 'guest_undone_circle'

      // 1. Host creates shape A
      await page1.evaluate((id) => {
        window.__setUserInteracted?.()
        const api = window.__excalidrawAPI
        const prev = api.getSceneElements()
        const uid = window.__collab?.collabUser?.uid || 'host_uid'
        const shape = {
          id,
          type: 'rectangle',
          x: 150,
          y: 350,
          width: 120,
          height: 80,
          strokeColor: '#3b82f6',
          isDeleted: false,
          version: 20,
          versionNonce: 101,
          lastModifiedBy: uid,
        }
        const updated = [...prev, shape]
        api.updateScene({ elements: updated })
        window.__collab?.broadcastChanges?.(updated)
      }, hostShapeId)

      await sleep(1500)

      // 2. Guest records prior state, then creates shape B
      await page2.evaluate((id) => {
        window.__setUserInteracted?.()
        const api = window.__excalidrawAPI
        const prev = api.getSceneElements()
        window.__collab?.recordUserAction?.(prev)

        const uid = window.__collab?.collabUser?.uid || 'guest_uid'
        const shape = {
          id,
          type: 'ellipse',
          x: 350,
          y: 350,
          width: 100,
          height: 100,
          strokeColor: '#ec4899',
          isDeleted: false,
          version: 20,
          versionNonce: 202,
          lastModifiedBy: uid,
        }
        const updated = [...prev, shape]
        api.updateScene({ elements: updated })
        window.__collab?.broadcastChanges?.(updated)
      }, guestShapeId)

      await sleep(2000)

      // Verify both shapes are visible on both screens
      const hostCountBefore = await page1.evaluate(
        (hId, gId) => {
          const els = window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted)
          return { hasHost: els.some((e) => e.id === hId), hasGuest: els.some((e) => e.id === gId) }
        },
        hostShapeId,
        guestShapeId,
      )

      assert.equal(hostCountBefore.hasHost, true, 'Host shape must exist before undo')
      assert.equal(hostCountBefore.hasGuest, true, 'Guest shape must exist before undo')

      // 3. Guest performs User-Scoped Undo
      await page2.evaluate(() => {
        window.__collab?.performScopedUndo?.()
      })

      await sleep(2500)

      // 4. Assert Host's shape was PRESERVED, while Guest's shape was UNDONE
      const hostCheckAfter = await page1.evaluate(
        (hId, gId) => {
          const els = window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted)
          return { hasHost: els.some((e) => e.id === hId), hasGuest: els.some((e) => e.id === gId) }
        },
        hostShapeId,
        guestShapeId,
      )

      const guestCheckAfter = await page2.evaluate(
        (hId, gId) => {
          const els = window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted)
          return { hasHost: els.some((e) => e.id === hId), hasGuest: els.some((e) => e.id === gId) }
        },
        hostShapeId,
        guestShapeId,
      )

      assert.equal(hostCheckAfter.hasHost, true, "Host shape must be intact on Host screen after Guest's undo")
      assert.equal(guestCheckAfter.hasHost, true, "Host shape must be intact on Guest screen after Guest's undo")
      assert.equal(hostCheckAfter.hasGuest, false, "Guest shape must be removed from Host screen after Guest's undo")
      assert.equal(guestCheckAfter.hasGuest, false, "Guest shape must be removed from Guest screen after Guest's undo")

      console.log('   ✓ User-scoped undo rolled back Guest action while preserving Host shape on both screens')
      passedTests++
    }

    // =================================================================
    // TEST 9: Soft Deletion via Tombstones
    // =================================================================
    console.log('\n🧪 Test 9: Soft Deletion & Tombstone Synchronization')
    {
      const tombstoneId = 'host_preserved_rect'

      // Host soft-deletes the shape
      await page1.evaluate((id) => {
        const api = window.__excalidrawAPI
        const prev = api.getSceneElements()
        const updated = prev.map((e) => (e.id === id ? { ...e, isDeleted: true, version: e.version + 1 } : e))
        api.updateScene({ elements: updated })
        window.__collab?.broadcastChanges?.(updated)
      }, tombstoneId)

      await sleep(2000)

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

    // Save final visual verification screenshots
    await page1.screenshot({ path: `${ARTIFACT_DIR}/live_e2e_host_final.png` })
    await page2.screenshot({ path: `${ARTIFACT_DIR}/live_e2e_guest_final.png` })

    console.log('\n======================================================================')
    console.log(`🎉 ALL ${passedTests}/9 LIVE MULTI-BROWSER E2E TESTS PASSED!`)
    console.log('======================================================================\n')
  } finally {
    await browser.close()
  }
}

runLiveE2ECollaborationSuite().catch((err) => {
  console.error('\n❌ LIVE E2E SUITE FAILED:', err)
  process.exit(1)
})
