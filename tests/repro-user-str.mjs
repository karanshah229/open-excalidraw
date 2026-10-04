import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runUserSTRVerification() {
  console.log('======================================================================')
  console.log('🧪 VERIFYING USER STR: LOCAL OWNER BOARD -> SHARE AS EDITOR -> INCOGNITO')
  console.log('======================================================================\n')

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const boardId = `str-${Date.now().toString(36)}`
    const boardUrl = `${BASE_URL}/boards/${boardId}`
    console.log(`📌 Target Board URL: ${boardUrl}\n`)

    // -------------------------------------------------------------
    // STEP 1: Host creates board in local workspace and opens it
    // -------------------------------------------------------------
    console.log('▶ Step 1: Opening board as Host (Owner with local workspace board)...')
    const page1 = await browser.newPage()
    await page1.setViewport({ width: 1440, height: 900 })

    await page1.goto(BASE_URL, { waitUntil: 'domcontentloaded' })

    // Seed board directly into local workspaceStore (IndexedDB/RxDB mock)
    await page1.evaluate(async (id) => {
      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      const { signInOwner: signInAnonymously, updateProfile } = await import('/tests/regression-fixture.ts')

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

      // Create a project & board in local workspace
      const proj = await workspaceApi.createProject('My Workspace')
      await workspaceApi.saveBoard({
        id,
        projectId: proj.id,
        name: 'Architecture Diagram',
        scene: {
          elements: [
            {
              id: 'owner_core_box',
              type: 'rectangle',
              x: 200,
              y: 150,
              width: 280,
              height: 140,
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
          appState: { viewBackgroundColor: '#121212' },
        },
        revision: 1,
        syncStatus: 'synced',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }, boardId)

    await page1.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page1.waitForSelector('.excalidraw', { timeout: 15000 })
    await page1.waitForFunction(() => Boolean(window.__excalidrawAPI))
    console.log('   ✓ Tab 1 loaded board from local workspace')

    // Confirm solo mode initially: 0 remote collaborator avatars
    const initialAvatars = await page1.evaluate(() => document.querySelectorAll('.collab-avatar').length)
    assert.equal(initialAvatars, 0, 'Solo Host must have 0 collaborator avatars initially')
    console.log('   ✓ Solo Mode confirmed: 0 remote collaborator avatars')

    // -------------------------------------------------------------
    // STEP 2: Share file with anyone as editor
    // -------------------------------------------------------------
    console.log('\n▶ Step 2: Sharing file with anyone as editor via ShareModal...')
    // Open share modal
    await page1.click('.header-share-btn')
    await page1.waitForSelector('[role="dialog"]', { timeout: 5000 })

    await page1.click('[aria-label="General access setting"]')
    await page1.click('.google-share-dropdown-item:last-child')
    await page1.waitForFunction(() => !document.querySelector('.google-share-done-btn').disabled)
    await page1.click('[aria-label="General access role"]')
    await page1.click('.google-share-dropdown-item:last-child')
    await page1.waitForFunction(() => !document.querySelector('.google-share-done-btn').disabled)
    // Policy mutation temporarily blocks reads; wait for the dialog to recover.
    await page1.waitForFunction(() => {
      const done = document.querySelector('.google-share-dialog .google-share-done-btn')
      return done && !done.disabled && done.textContent === 'Done'
    })
    await page1.click('.google-share-dialog .google-share-done-btn')
    await page1.waitForSelector('.google-share-dialog', { hidden: true })
    console.log('   ✓ Board shared as "anyone_with_link" with role "editor"')

    // -------------------------------------------------------------
    // STEP 3: Open in Incognito context
    // -------------------------------------------------------------
    console.log('\n▶ Step 3: Opening board in isolated Incognito context...')
    const incognitoContext = await browser.createBrowserContext()
    const page2 = await incognitoContext.newPage()
    await page2.setViewport({ width: 1440, height: 900 })

    await page2.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page2.waitForSelector('.excalidraw', { timeout: 15000 })
    await page2.waitForFunction(() => Boolean(window.__excalidrawAPI))
    console.log('   ✓ Tab 2 mounted in Incognito')

    // -------------------------------------------------------------
    // STEP 4: Verify Anonymous user shown in Tab 1
    // -------------------------------------------------------------
    console.log('\n▶ Step 4: Verifying Anonymous user avatar appears in Tab 1...')
    await page1.waitForSelector('.collab-avatar', { timeout: 10000 })
    const tab1Avatars = await page1.evaluate(() => {
      return Array.from(document.querySelectorAll('.collab-avatar')).map((el) => ({
        title: el.getAttribute('title'),
        text: el.innerText.trim(),
      }))
    })

    console.log('   Tab 1 Collaborators:', tab1Avatars)
    assert.ok(tab1Avatars.length >= 1, 'Anonymous user must be visible in Tab 1')
    assert.ok(
      tab1Avatars.some((a) => a.title?.startsWith('Anonymous')),
      'Collaborator in Tab 1 must be Anonymous user',
    )
    console.log('   ✓ Anonymous user successfully displayed in Tab 1!')

    // Also verify Host is visible in Tab 2
    await page2.waitForSelector('.collab-avatar', { timeout: 10000 })
    const tab2Avatars = await page2.evaluate(() => {
      return Array.from(document.querySelectorAll('.collab-avatar')).map((el) => ({
        title: el.getAttribute('title'),
        text: el.innerText.trim(),
      }))
    })
    console.log('   Tab 2 Collaborators:', tab2Avatars)
    assert.ok(
      tab2Avatars.some((a) => a.title === 'Karan Shah'),
      'Host (Karan Shah) must be visible in Tab 2',
    )
    console.log('   ✓ Host successfully displayed in Tab 2!')

    // -------------------------------------------------------------
    // STEP 5: Verify edits made in Tab 2 are shown in Tab 1
    // -------------------------------------------------------------
    console.log('\n▶ Step 5: Guest in Tab 2 draws a shape; verifying it appears in Tab 1...')
    const guestShapeId = `guest_shape_${Date.now().toString(36)}`

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
            type: 'diamond',
            x: 580,
            y: 220,
            width: 160,
            height: 160,
            strokeColor: '#f43f5e',
            backgroundColor: '#881337',
            fillStyle: 'solid',
            strokeWidth: 2,
            roughness: 1,
            opacity: 100,
            isDeleted: false,
            version: 2,
            versionNonce: 501,
          },
        ],
        { regenerateIds: false },
      )
      const newElem = { ...converted, lastModifiedBy: uid }

      const updated = [...prev, newElem]
      api.updateScene({ elements: updated })
      window.__collab?.broadcastChanges?.(updated)
    }, guestShapeId)

    // Wait for real-time RTDB synchronization to Tab 1
    await sleep(2500)

    const tab1Elements = await page1.evaluate(() => {
      return window.__excalidrawAPI.getSceneElements().map((e) => ({
        id: e.id,
        type: e.type,
        x: e.x,
        y: e.y,
        strokeColor: e.strokeColor,
      }))
    })

    const syncedInTab1 = tab1Elements.find((e) => e.id === guestShapeId)
    assert.ok(syncedInTab1, 'Guest shape must arrive in Tab 1 via live RTDB')
    assert.equal(syncedInTab1.type, 'diamond')
    assert.equal(syncedInTab1.strokeColor, '#f43f5e')
    console.log(
      `   ✓ Shape created by Incognito Guest appeared in Tab 1 live! (type: ${syncedInTab1.type}, color: ${syncedInTab1.strokeColor})`,
    )

    // -------------------------------------------------------------
    // BONUS: Verify Tab 1 edits sync back to Tab 2
    // -------------------------------------------------------------
    console.log('\n▶ Bonus: Host in Tab 1 updates core shape color; verifying sync to Tab 2...')
    await page1.evaluate(() => {
      window.__setUserInteracted?.()
      const api = window.__excalidrawAPI
      const prev = api.getSceneElements()
      const updated = prev.map((e) =>
        e.id === 'owner_core_box' ? { ...e, strokeColor: '#10b981', version: e.version + 1, versionNonce: 888 } : e,
      )
      api.updateScene({ elements: updated })
      window.__collab?.broadcastChanges?.(updated)
    })

    await sleep(2000)

    const tab2Elements = await page2.evaluate(() => {
      return window.__excalidrawAPI.getSceneElements().find((e) => e.id === 'owner_core_box')
    })
    assert.equal(tab2Elements?.strokeColor, '#10b981', 'Host edit must arrive in Tab 2 live')
    console.log('   ✓ Host edit appeared in Tab 2 live!')

    // -------------------------------------------------------------
    // STEP 6: Close Incognito Tab; verify clean solo downgrade
    // -------------------------------------------------------------
    console.log('\n▶ Step 6: Closing Incognito tab; verifying clean solo downgrade in Tab 1...')
    await page2.goto('about:blank')
    await page2.close()
    await incognitoContext.close()

    let finalAvatars = 1
    for (let i = 0; i < 8; i++) {
      await sleep(1000)
      finalAvatars = await page1.evaluate(() => document.querySelectorAll('.collab-avatar').length)
      if (finalAvatars === 0) break
    }
    const debugState = await page1.evaluate(() => ({
      avatars: Array.from(document.querySelectorAll('.collab-avatar')).map((el) => el.getAttribute('title')),
    }))
    console.log('   Tab 1 state after close:', debugState)
    assert.equal(finalAvatars, 0, 'Tab 1 must return to 0 avatars on peer exit')
    console.log('   ✓ Tab 1 cleanly returned to solo dormant mode (0 avatars)!')

    console.log('\n======================================================================')
    console.log('🎉 USER STR VERIFIED 100%: ALL STEPS PASSED SUCCESSFULLY!')
    console.log('======================================================================\n')
  } finally {
    await browser.close()
  }
}

runUserSTRVerification().catch((err) => {
  console.error('\n❌ USER STR REPRODUCTION TEST FAILED:', err)
  process.exit(1)
})
