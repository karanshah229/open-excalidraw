import puppeteer from 'puppeteer-core'
import assert from 'node:assert'

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const within = (promise, label, timeoutMs = 15_000) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)),
  ])

async function runTest() {
  console.log('======================================================================')
  console.log('🧪 VERIFYING INCOGNITO CMD+Z UNDO DOES NOT TRIGGER BEFOREUNLOAD DIALOG')
  console.log('======================================================================\n')

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const boardId = `undo-${Date.now().toString(36)}`
    const boardUrl = `${BASE_URL}/boards/${boardId}`
    console.log(`📌 Test Board URL: ${boardUrl}\n`)

    // -------------------------------------------------------------
    // Step 1: Open board in Window 1 and share with link as editor
    // -------------------------------------------------------------
    console.log('▶ Step 1: Opening board as Host (Window 1)...')
    const page1 = await browser.newPage()
    await page1.setViewport({ width: 1440, height: 900 })
    page1.setDefaultTimeout(15_000)
    page1.setDefaultNavigationTimeout(20_000)
    await page1.goto(BASE_URL, { waitUntil: 'domcontentloaded' })

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
        await updateProfile(u, { displayName: 'Host User' })
      }

      const proj = await workspaceApi.createProject('Undo Test Project')
      await workspaceApi.saveBoard({
        id,
        projectId: proj.id,
        name: 'Undo Test Board',
        scene: {
          elements: [],
          appState: { viewBackgroundColor: '#ffffff' },
        },
        revision: 1,
        syncStatus: 'synced',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }, boardId)

    await page1.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page1.waitForFunction(() => Boolean(window.__excalidrawAPI))
    console.log('   ✓ Window 1 loaded board successfully')

    // Share board as anyone_with_link + editor
    await within(
      page1.evaluate(async (id) => {
        const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
        const config = await sharingService.getShareConfig(id)
        await (
          await import('/tests/regression-fixture.ts')
        ).seedSharedBoard({
          ...config,
          generalAccess: 'anyone_with_link',
          generalRole: 'editor',
        })
      }, boardId),
      'Share configuration write',
    )
    console.log('   ✓ Board shared as anyone_with_link + editor')

    // API fixture publication precedes the editor's shared-board bootstrap.
    await page1.reload({ waitUntil: 'domcontentloaded' })
    await page1.waitForFunction(() => Boolean(window.__excalidrawAPI))

    // -------------------------------------------------------------
    // Step 2: Open same board in Incognito context (Window 2)
    // -------------------------------------------------------------
    console.log('\n▶ Step 2: Opening board in Incognito context (Window 2)...')
    const incognitoContext = await browser.createBrowserContext()
    const page2 = await incognitoContext.newPage()
    await page2.setViewport({ width: 1440, height: 900 })
    page2.setDefaultTimeout(15_000)
    page2.setDefaultNavigationTimeout(20_000)

    let dialogAppeared = false
    page2.on('dialog', async (dialog) => {
      dialogAppeared = true
      console.error('   ❌ UNEXPECTED DIALOG:', dialog.type(), dialog.message())
      await dialog.dismiss()
    })

    await page2.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page2.waitForFunction(() => Boolean(window.__excalidrawAPI))
    console.log('   ✓ Window 2 loaded in Incognito')

    // Wait for auto-upgrade to live collab
    await page1.waitForSelector('.collab-avatar', { timeout: 10000 })
    await page2.waitForSelector('.collab-avatar', { timeout: 10000 })
    console.log('   ✓ Live collaboration established between Window 1 and Window 2')

    // -------------------------------------------------------------
    // Step 3: Make changes in Incognito Window
    // -------------------------------------------------------------
    console.log('\n▶ Step 3: Making changes in Incognito Window (drawing rectangle)...')
    await page2.keyboard.press('KeyR')
    await sleep(200)
    await page2.mouse.move(300, 300)
    await page2.mouse.down()
    await page2.mouse.move(500, 500)
    await page2.mouse.up()
    await sleep(600)

    const elementCountAfterDraw = await page2.evaluate(() => {
      return window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length
    })
    console.log(`   Element count after draw: ${elementCountAfterDraw}`)
    assert.equal(elementCountAfterDraw, 1, 'Incognito window should have 1 active element')

    // Verify it synced to Window 1
    await sleep(1500)
    const p1Count = await page1.evaluate(() => {
      return window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length
    })
    console.log(`   Window 1 element count: ${p1Count}`)
    assert.equal(p1Count, 1, 'Window 1 must receive the drawn shape live')

    // -------------------------------------------------------------
    // Step 4: Revert all changes in Incognito Window using Cmd+Z
    // -------------------------------------------------------------
    console.log('\n▶ Step 4: Reverting all changes in Incognito Window using Cmd+Z...')
    await page2.keyboard.down('Meta')
    await page2.keyboard.press('KeyZ')
    await page2.keyboard.up('Meta')
    await sleep(600)

    const elementCountAfterUndo = await page2.evaluate(() => {
      return window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length
    })
    console.log(`   Element count after Cmd+Z: ${elementCountAfterUndo}`)
    assert.equal(elementCountAfterUndo, 0, 'Incognito window should have 0 active elements after Cmd+Z')

    const hasUnsavedAfterUndo = await page2.evaluate(() => {
      return window.__hasUnsavedChanges ? window.__hasUnsavedChanges() : false
    })
    console.log(`   hasUnsavedChanges after Cmd+Z: ${hasUnsavedAfterUndo}`)
    assert.equal(hasUnsavedAfterUndo, false, 'Incognito page must NOT be marked dirty after Cmd+Z undo!')

    // -------------------------------------------------------------
    // Step 5: Close Incognito Tab with beforeunload enabled
    // -------------------------------------------------------------
    console.log('\n▶ Step 5: Closing Incognito tab (verifying NO beforeunload dialog)...')
    await page2.close({ runBeforeUnload: true })
    console.log('   ✓ Tab closed successfully')

    assert.equal(dialogAppeared, false, 'No confirmation dialog should appear before leaving site!')
    console.log('   ✅ Step 5 Passed: Zero confirmation dialogs triggered upon closing tab!')

    console.log('\n======================================================================')
    console.log('🎉 ALL TESTS PASSED: INCOGNITO UNDO LEAVES SITE WITH ZERO DIALOGS!')
    console.log('======================================================================\n')
  } finally {
    await browser.close()
  }
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err)
  process.exit(1)
})
