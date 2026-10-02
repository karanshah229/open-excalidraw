import puppeteer from 'puppeteer-core'
import assert from 'node:assert'

const BASE_URL = 'http://localhost:5173'
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function runTest() {
  console.log('======================================================================')
  console.log('🧪 REPRODUCING COLLAB UNDO BUG: DELETE ELEMENT THEN UNDO')
  console.log('======================================================================\n')

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const boardId = `collab-undo-${Date.now().toString(36)}`
    const boardUrl = `${BASE_URL}/boards/${boardId}`
    console.log(`📌 Test Board URL: ${boardUrl}\n`)

    // Step 1: Open board in Window 1 (Host)
    console.log('▶ Step 1: Opening board as Host (Window 1)...')
    const page1 = await browser.newPage()
    await page1.setViewport({ width: 1440, height: 900 })
    page1.setDefaultTimeout(15_000)
    page1.setDefaultNavigationTimeout(20_000)
    await page1.goto(BASE_URL, { waitUntil: 'domcontentloaded' })

    await page1.evaluate(async (id) => {
      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      const { signInAnonymously, updateProfile } = await import('/src/features/collaboration/anonymous-user.ts')

      const auth = getFirebaseAuth()
      let u = auth?.currentUser
      if (!u && auth) {
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
          elements: [
            {
              id: 'test_rect_1',
              type: 'rectangle',
              x: 200,
              y: 200,
              width: 200,
              height: 100,
              strokeColor: '#000000',
              backgroundColor: '#3b82f6',
              fillStyle: 'solid',
              strokeWidth: 2,
              roughness: 1,
              opacity: 100,
              isDeleted: false,
              version: 1,
              versionNonce: 1001,
            },
          ],
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
    await page1.evaluate(async (id) => {
      const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
      const config = await sharingService.getShareConfig(id)
      await sharingService.saveShareConfig({
        ...config,
        generalAccess: 'anyone_with_link',
        generalRole: 'editor',
      })
    }, boardId)
    console.log('   ✓ Board shared as anyone_with_link + editor')

    // Step 2: Open in Incognito context (Window 2)
    console.log('\n▶ Step 2: Opening board in Incognito context (Window 2)...')
    const incognitoContext = await browser.createBrowserContext()
    const page2 = await incognitoContext.newPage()
    await page2.setViewport({ width: 1440, height: 900 })
    page2.setDefaultTimeout(15_000)
    page2.setDefaultNavigationTimeout(20_000)

    await page2.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page2.waitForFunction(() => Boolean(window.__excalidrawAPI))
    console.log('   ✓ Window 2 loaded in Incognito')

    // Wait for live collab to establish
    await page1.waitForSelector('.collab-avatar', { timeout: 10000 })
    await page2.waitForSelector('.collab-avatar', { timeout: 10000 })
    await sleep(2000)
    console.log('   ✓ Live collaboration established between Window 1 and Window 2')

    // Check initial element on both windows
    const p1CountInitial = await page1.evaluate(() => {
      return window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length
    })
    const p2CountInitial = await page2.evaluate(() => {
      return window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length
    })
    console.log(`   Initial elements -> Window 1: ${p1CountInitial}, Window 2: ${p2CountInitial}`)
    assert.equal(p1CountInitial, 1, 'Window 1 should have 1 active element initially')
    assert.equal(p2CountInitial, 1, 'Window 2 should have 1 active element initially')

    // Step 3: Delete element in Window 1
    console.log('\n▶ Step 3: Deleting element in Window 1...')
    await page1.bringToFront()
    await page1.keyboard.down('Meta')
    await page1.keyboard.press('KeyA')
    await page1.keyboard.up('Meta')
    await sleep(200)
    await page1.keyboard.press('Backspace')
    await sleep(1500)

    page1.on('console', (msg) => {
      console.log(`[P1 Log] ${msg.text()}`)
    })
    page2.on('console', (msg) => {
      console.log(`[P2 Log] ${msg.text()}`)
    })

    const p1CountAfterDelete = await page1.evaluate(() => {
      const all = window.__excalidrawAPI.getSceneElementsIncludingDeleted()
      return {
        active: window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
        all: all.map((e) => ({ id: e.id, version: e.version, versionNonce: e.versionNonce, isDeleted: e.isDeleted })),
      }
    })
    const p2CountAfterDelete = await page2.evaluate(() => {
      const all = window.__excalidrawAPI.getSceneElementsIncludingDeleted()
      return {
        active: window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
        all: all.map((e) => ({ id: e.id, version: e.version, versionNonce: e.versionNonce, isDeleted: e.isDeleted })),
      }
    })
    console.log(`   After delete -> Window 1: ${p1CountAfterDelete.active}, Window 2: ${p2CountAfterDelete.active}`)
    console.log(`   Window 1 after delete all:`, JSON.stringify(p1CountAfterDelete.all))
    console.log(`   Window 2 after delete all:`, JSON.stringify(p2CountAfterDelete.all))
    assert.equal(p1CountAfterDelete.active, 0, 'Window 1 should have 0 active elements after delete')
    assert.equal(p2CountAfterDelete.active, 0, 'Window 2 should have 0 active elements after delete')

    // Step 4: Undo in Window 1
    console.log('\n▶ Step 4: Pressing Undo (Cmd+Z) in Window 1...')
    await page1.bringToFront()
    await page1.keyboard.down('Meta')
    await page1.keyboard.press('KeyZ')
    await page1.keyboard.up('Meta')
    await sleep(2500)

    const p1InfoAfterUndo = await page1.evaluate(() => {
      const active = window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted)
      const all = window.__excalidrawAPI.getSceneElementsIncludingDeleted()
      return {
        activeCount: active.length,
        all: all.map((e) => ({ id: e.id, version: e.version, versionNonce: e.versionNonce, isDeleted: e.isDeleted })),
      }
    })
    const p2InfoAfterUndo = await page2.evaluate(() => {
      const active = window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted)
      const all = window.__excalidrawAPI.getSceneElementsIncludingDeleted()
      return {
        activeCount: active.length,
        all: all.map((e) => ({ id: e.id, version: e.version, versionNonce: e.versionNonce, isDeleted: e.isDeleted })),
      }
    })

    console.log(`   After Cmd+Z:`)
    console.log(`   Window 1 active: ${p1InfoAfterUndo.activeCount}, elements:`, JSON.stringify(p1InfoAfterUndo.all))
    console.log(`   Window 2 active: ${p2InfoAfterUndo.activeCount}, elements:`, JSON.stringify(p2InfoAfterUndo.all))

    assert.equal(p1InfoAfterUndo.activeCount, 1, 'Window 1 should restore element via Undo')
    assert.equal(p2InfoAfterUndo.activeCount, 1, 'Window 2 MUST ALSO restore element via Undo!')
    console.log('   ✓ Element successfully resurrected across all peer tabs on Undo!')

    // Step 5: Redo (Cmd+Shift+Z) in Window 1
    console.log('\n▶ Step 5: Pressing Redo (Cmd+Shift+Z) in Window 1...')
    await page1.bringToFront()
    await page1.keyboard.down('Meta')
    await page1.keyboard.down('Shift')
    await page1.keyboard.press('KeyZ')
    await page1.keyboard.up('Shift')
    await page1.keyboard.up('Meta')
    await sleep(2500)

    const p1CountAfterRedo = await page1.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    const p2CountAfterRedo = await page2.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    console.log(`   After Redo -> Window 1: ${p1CountAfterRedo}, Window 2: ${p2CountAfterRedo}`)
    assert.equal(p1CountAfterRedo, 0, 'Window 1 should re-delete element via Redo')
    assert.equal(p2CountAfterRedo, 0, 'Window 2 MUST ALSO re-delete element via Redo!')
    console.log('   ✓ Redo deletion successfully propagated across all peer tabs!')

    // Step 6: Undo again (Cmd+Z) in Window 1
    console.log('\n▶ Step 6: Pressing Undo again (Cmd+Z) in Window 1...')
    await page1.bringToFront()
    await page1.keyboard.down('Meta')
    await page1.keyboard.press('KeyZ')
    await page1.keyboard.up('Meta')
    await sleep(2500)

    const p1CountFinal = await page1.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    const p2CountFinal = await page2.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    console.log(`   After second Undo -> Window 1: ${p1CountFinal}, Window 2: ${p2CountFinal}`)
    assert.equal(p1CountFinal, 1, 'Window 1 should restore element via second Undo')
    assert.equal(p2CountFinal, 1, 'Window 2 MUST ALSO restore element via second Undo!')
    console.log('   ✓ Second Undo successfully resurrected element across all peer tabs!')

    console.log('\n======================================================================')
    console.log('🎉 COLLAB UNDO/REDO PROPAGATION TEST PASSED 100%!')
    console.log('======================================================================\n')
  } finally {
    await browser.close()
  }
}

runTest().catch((err) => {
  console.error('\n❌ TEST FAILED:', err.message)
  process.exit(1)
})
