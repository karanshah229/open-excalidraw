import puppeteer from 'puppeteer-core'
import assert from 'node:assert'

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function runInactiveTabTest() {
  console.log('======================================================================')
  console.log('🧪 VERIFYING INACTIVE TAB PRESENCE & GHOST CURSOR SUPPRESSION')
  console.log('======================================================================')

  const boardId = `inactive-${Date.now().toString(36)}`
  const boardUrl = `${BASE_URL}/boards/${boardId}`
  console.log(`📌 Test Board URL: ${boardUrl}\n`)

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    // -------------------------------------------------------------
    // Window 1: Host creates board in local workspace and opens it
    // -------------------------------------------------------------
    console.log('▶ Step 1: Launching Window 1 (Host on Main Monitor)...')
    const page1 = await browser.newPage()
    await page1.setViewport({ width: 1280, height: 800 })

    await page1.goto(BASE_URL, { waitUntil: 'domcontentloaded' })

    await page1.evaluate(async (id) => {
      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      const { signInOwner: signInAnonymously, updateProfile } = await import('/tests/regression-fixture.ts')
      const { sharingService } = await import('/src/features/sharing/sharing-service.ts')

      const auth = getFirebaseAuth()
      let u = auth?.currentUser
      if ((!u || u.isAnonymous) && auth) {
        const cred = await signInAnonymously(auth)
        u = cred.user
      }
      if (u) {
        await updateProfile(u, {
          displayName: 'Karan Shah',
          photoURL: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Karan',
        })
      }

      const proj = await workspaceApi.createProject('My Workspace')
      await workspaceApi.saveBoard({
        id,
        projectId: proj.id,
        name: 'Inactive Presence Board',
        scene: {
          elements: [
            {
              id: 'owner_box',
              type: 'rectangle',
              x: 200,
              y: 150,
              width: 200,
              height: 100,
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
          ],
          appState: { viewBackgroundColor: '#ffffff' },
        },
        revision: 1,
        syncStatus: 'synced',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      // Share with anyone as editor
      const config = await sharingService.getShareConfig(id)
      await (
        await import('/tests/regression-fixture.ts')
      ).seedSharedBoard({
        ...config,
        generalAccess: 'anyone_with_link',
        generalRole: 'editor',
      })
    }, boardId)

    await page1.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page1.waitForSelector('.excalidraw', { timeout: 15000 })
    await page1.waitForFunction(() => Boolean(window.__excalidrawAPI))
    console.log('   ✓ Window 1 loaded board from local workspace')

    // -------------------------------------------------------------
    // Window 2: Incognito (Guest on Second Monitor)
    // -------------------------------------------------------------
    console.log('\n▶ Step 2: Launching Window 2 (Incognito on Second Monitor)...')
    const incognitoContext = await browser.createBrowserContext()
    const page2 = await incognitoContext.newPage()
    await page2.setViewport({ width: 1280, height: 800 })
    await page2.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page2.waitForSelector('.excalidraw', { timeout: 15000 })
    await page2.waitForFunction(() => Boolean(window.__excalidrawAPI))
    console.log('   ✓ Window 2 loaded in Incognito context')

    // Wait for both windows to auto-upgrade to live collab
    console.log('\n▶ Step 3: Verifying Auto-Upgrade to Live Collaboration...')
    let upgraded = false
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      const p1Active = await page1.evaluate(() => window.__lazyCollab?.isLazyCollabActive)
      const p2Active = await page2.evaluate(() => window.__lazyCollab?.isLazyCollabActive)
      if (p1Active && p2Active) {
        upgraded = true
        break
      }
    }
    assert.ok(upgraded, 'Both windows must auto-upgrade to live collaboration')
    console.log('   ✓ Both windows auto-upgraded to live collaboration (WebSockets active)')

    // Verify collaborator avatars appear
    let avatarsInP2 = 0
    for (let i = 0; i < 12; i++) {
      await sleep(500)
      avatarsInP2 = await page2.evaluate(() => document.querySelectorAll('.collab-avatar').length)
      if (avatarsInP2 >= 1) break
    }
    assert.ok(avatarsInP2 >= 1, 'Window 2 must display Host collaborator avatar')
    console.log(`   ✓ Window 2 displays Host avatar in header (count: ${avatarsInP2})`)

    // -------------------------------------------------------------
    // Step 4: Host moves cursor on whiteboard
    // -------------------------------------------------------------
    console.log('\n▶ Step 4: Host moves cursor on canvas; verifying it appears on Window 2...')
    await page1.mouse.move(400, 300)
    await page1.mouse.move(450, 350)
    await sleep(250)

    let cursorSeenInP2 = false
    for (let i = 0; i < 10; i++) {
      await sleep(300)
      const p2Collabs = await page2.evaluate(() => {
        const collabObj = window.__lazyCollab?.activeCollaborators || []
        return collabObj.filter((c) => c.cursor !== null && c.cursor !== undefined)
      })
      if (p2Collabs.length > 0) {
        cursorSeenInP2 = true
        break
      }
    }
    assert.ok(cursorSeenInP2, 'Window 2 must receive Host cursor position while active')
    console.log('   ✓ Host cursor correctly rendered on Window 2 canvas')

    // -------------------------------------------------------------
    // Step 5: User switches away (Window 1 blurs / becomes inactive)
    // -------------------------------------------------------------
    console.log('\n▶ Step 5: Simulating user working on something else (Window 1 inactive/blurred)...')
    await page1.evaluate(() => {
      window.dispatchEvent(new Event('blur'))
      document.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: null }))
    })

    // Immediately verify that Host cursor is cleared from Window 2
    let cursorClearedInP2 = false
    for (let i = 0; i < 10; i++) {
      await sleep(200)
      const p2ActiveCursors = await page2.evaluate(() => {
        const collabs = window.__lazyCollab?.activeCollaborators || []
        return collabs.filter((c) => c.cursor !== null && c.cursor !== undefined)
      })
      if (p2ActiveCursors.length === 0) {
        cursorClearedInP2 = true
        break
      }
    }
    assert.ok(cursorClearedInP2, 'Host cursor must be cleared immediately when window blurs / becomes inactive')
    console.log('   ✓ Host cursor immediately disappeared from Window 2 canvas on blur!')

    // -------------------------------------------------------------
    // Step 6: Monitor for 16 seconds while Window 1 is inactive
    // (Verifies that presence avatar does NOT flap and cursor does NOT reappear)
    // -------------------------------------------------------------
    console.log('\n▶ Step 6: Monitoring Window 2 for 16s while Window 1 remains inactive...')
    console.log('   (Verifying presence avatar does NOT flap and ghost cursor does NOT flicker)')
    let presenceFlapped = false
    let ghostCursorAppeared = false

    const startTime = Date.now()
    while (Date.now() - startTime < 16000) {
      await sleep(1000)
      const elapsed = Math.round((Date.now() - startTime) / 1000)

      const status = await page2.evaluate(() => {
        const avatars = document.querySelectorAll('.collab-avatar').length
        const collabs = window.__lazyCollab?.activeCollaborators || []
        const cursorsWithCoords = collabs.filter((c) => c.cursor !== null && c.cursor !== undefined)
        return {
          avatars,
          activeCount: collabs.length,
          ghostCursors: cursorsWithCoords.length,
        }
      })

      if (status.avatars === 0 || status.activeCount === 0) {
        console.warn(`   ⚠️ Warning: Presence flapped at ${elapsed}s! Avatars: ${status.avatars}`)
        presenceFlapped = true
      }
      if (status.ghostCursors > 0) {
        console.warn(`   ⚠️ Warning: Ghost cursor reappeared at ${elapsed}s!`)
        ghostCursorAppeared = true
      }
    }

    assert.ok(!presenceFlapped, 'Presence avatar must NOT disappear/flap while Window 1 is in background')
    assert.ok(!ghostCursorAppeared, 'Ghost cursor must NOT reappear while Window 1 is inactive')
    console.log('   ✓ Presence remained 100% stable: 0 flapping observed during 16s inactive period!')
    console.log('   ✓ Ghost cursor stayed 100% suppressed: 0 flicker observed!')

    // -------------------------------------------------------------
    // Step 7: Host refocuses and moves cursor again
    // -------------------------------------------------------------
    console.log('\n▶ Step 7: Host refocuses Window 1 and resumes drawing...')
    await page1.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await page1.mouse.move(500, 400)
    await page1.mouse.move(520, 420)
    await sleep(300)

    let cursorResumedInP2 = false
    for (let i = 0; i < 10; i++) {
      await sleep(300)
      const p2Collabs = await page2.evaluate(() => {
        const collabs = window.__lazyCollab?.activeCollaborators || []
        return collabs.filter((c) => c.cursor !== null && c.cursor !== undefined)
      })
      if (p2Collabs.length > 0) {
        cursorResumedInP2 = true
        break
      }
    }
    assert.ok(cursorResumedInP2, 'Host cursor must smoothly resume when user moves pointer again')
    console.log('   ✓ Host cursor smoothly resumed upon active interaction!')

    console.log('\n======================================================================')
    console.log('🎉 ALL INACTIVE TAB PRESENCE & CURSOR SUPPRESSION CHECKS PASSED 100%!')
    console.log('======================================================================')
  } finally {
    await browser.close()
  }
}

runInactiveTabTest().catch((err) => {
  console.error('\n❌ TEST FAILED:', err)
  process.exit(1)
})
