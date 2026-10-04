import puppeteer from 'puppeteer-core'
import assert from 'node:assert'

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function run() {
  console.log('======================================================================')
  console.log('🧪 VERIFYING NO AUTOMATIC UNDO ON FURTHER OPERATIONS AFTER COLLAB UNDO')
  console.log('======================================================================\n')

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const boardId = `collab-ops-${Date.now().toString(36)}`
    const boardUrl = `${BASE_URL}/boards/${boardId}`
    console.log(`📌 Board URL: ${boardUrl}\n`)

    const page1 = await browser.newPage()
    await page1.setViewport({ width: 1440, height: 900 })
    page1.setDefaultTimeout(15_000)
    page1.setDefaultNavigationTimeout(20_000)

    // Seed board in page1
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

      const proj = await workspaceApi.createProject('Ops Test Project')
      await workspaceApi.saveBoard({
        id,
        projectId: proj.id,
        name: 'Ops Test Board',
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

    // Open board in Page 1
    await page1.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page1.waitForFunction(() => Boolean(window.__excalidrawAPI))

    // Share board
    await page1.evaluate(async (id) => {
      const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
      const config = await sharingService.getShareConfig(id)
      await (
        await import('/tests/regression-fixture.ts')
      ).seedSharedBoard({
        ...config,
        generalAccess: 'anyone_with_link',
        generalRole: 'editor',
      })
    }, boardId)

    // API fixture publication precedes the editor's shared-board bootstrap.
    await page1.reload({ waitUntil: 'domcontentloaded' })
    await page1.waitForFunction(() => Boolean(window.__excalidrawAPI))

    // Open Page 2 in incognito context
    const incognito = await browser.createBrowserContext()
    const page2 = await incognito.newPage()
    await page2.setViewport({ width: 1440, height: 900 })
    page2.setDefaultTimeout(15_000)
    page2.setDefaultNavigationTimeout(20_000)

    await page2.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page2.waitForFunction(() => Boolean(window.__excalidrawAPI))

    await page1.waitForSelector('.collab-avatar', { timeout: 10000 })
    await page2.waitForSelector('.collab-avatar', { timeout: 10000 })
    await sleep(2000)
    console.log('   ✓ Both tabs open and connected in live collaboration.')

    // Step 2: Delete element in normal tab
    console.log('\n▶ Step 2: Delete element in normal tab (Tab 1)...')
    await page1.bringToFront()
    await page1.keyboard.down('Meta')
    await page1.keyboard.press('KeyA')
    await page1.keyboard.up('Meta')
    await sleep(200)
    await page1.keyboard.press('Backspace')
    await sleep(1500)

    let p1Elements = await page1.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    let p2Elements = await page2.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    console.log(`   After delete -> Tab 1: ${p1Elements}, Tab 2: ${p2Elements}`)
    assert.equal(p1Elements, 0)
    assert.equal(p2Elements, 0)

    // Step 3: Undo in normal tab
    console.log('\n▶ Step 3: Undo in normal tab (Tab 1)...')
    await page1.bringToFront()
    await page1.keyboard.down('Meta')
    await page1.keyboard.press('KeyZ')
    await page1.keyboard.up('Meta')
    await sleep(1500)

    p1Elements = await page1.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    p2Elements = await page2.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    console.log(`   After undo -> Tab 1: ${p1Elements}, Tab 2: ${p2Elements}`)
    assert.equal(p1Elements, 1)
    assert.equal(p2Elements, 1)

    // Step 4: Draw a new rectangle on Page 1 (Normal tab)
    console.log('\n▶ Step 4: Draw a new rectangle on Tab 1...')
    await page1.bringToFront()
    await page1.keyboard.press('KeyR')
    await sleep(300)
    await page1.mouse.move(500, 300)
    await page1.mouse.down()
    await page1.mouse.move(650, 450, { steps: 10 })
    await page1.mouse.up()
    await sleep(2000)

    let p1AfterDraw = await page1.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    let p2AfterDraw = await page2.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    console.log(`   After draw on Tab 1 -> Tab 1: ${p1AfterDraw}, Tab 2: ${p2AfterDraw}`)
    assert.equal(p1AfterDraw, 2)
    assert.equal(p2AfterDraw, 2)

    // Step 5: Draw a new rectangle on Page 2 (Incognito tab)
    console.log('\n▶ Step 5: Draw a new rectangle on Tab 2 (Incognito)...')
    await page2.bringToFront()
    await page2.keyboard.press('KeyR')
    await sleep(300)
    await page2.mouse.move(700, 300)
    await page2.mouse.down()
    await page2.mouse.move(850, 450, { steps: 10 })
    await page2.mouse.up()
    await sleep(2000)

    let p1AfterDraw2 = await page1.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    let p2AfterDraw2 = await page2.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    console.log(`   After draw on Tab 2 -> Tab 1: ${p1AfterDraw2}, Tab 2: ${p2AfterDraw2}`)
    assert.equal(p1AfterDraw2, 3)
    assert.equal(p2AfterDraw2, 3)

    // Step 6: Move elements using keyboard in Page 1
    console.log('\n▶ Step 6: Move elements in Tab 1 with Arrow keys...')
    await page1.bringToFront()
    await page1.keyboard.down('Meta')
    await page1.keyboard.press('KeyA')
    await page1.keyboard.up('Meta')
    await sleep(300)
    await page1.keyboard.press('ArrowRight')
    await page1.keyboard.press('ArrowRight')
    await page1.keyboard.press('ArrowRight')
    await sleep(2000)

    let p1AfterMove = await page1.evaluate(() =>
      window.__excalidrawAPI
        .getSceneElements()
        .filter((e) => !e.isDeleted)
        .map((e) => ({ id: e.id, x: e.x })),
    )
    let p2AfterMove = await page2.evaluate(() =>
      window.__excalidrawAPI
        .getSceneElements()
        .filter((e) => !e.isDeleted)
        .map((e) => ({ id: e.id, x: e.x })),
    )
    console.log(`   P1 x positions: ${JSON.stringify(p1AfterMove)}`)
    console.log(`   P2 x positions: ${JSON.stringify(p2AfterMove)}`)
    assert.deepEqual(p1AfterMove, p2AfterMove)

    // Step 7: Delete all elements in Page 2
    console.log('\n▶ Step 7: Delete all elements in Tab 2...')
    await page2.bringToFront()
    await page2.keyboard.down('Meta')
    await page2.keyboard.press('KeyA')
    await page2.keyboard.up('Meta')
    await sleep(300)
    await page2.keyboard.press('Backspace')
    await sleep(2000)

    let p1AfterDel = await page1.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    let p2AfterDel = await page2.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    console.log(`   After delete in Tab 2 -> Tab 1: ${p1AfterDel}, Tab 2: ${p2AfterDel}`)
    assert.equal(p1AfterDel, 0)
    assert.equal(p2AfterDel, 0)

    // Step 8: Undo delete in Page 2
    console.log('\n▶ Step 8: Undo delete in Tab 2...')
    await page2.keyboard.down('Meta')
    await page2.keyboard.press('KeyZ')
    await page2.keyboard.up('Meta')
    await sleep(2000)

    let p1AfterUndo2 = await page1.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    let p2AfterUndo2 = await page2.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    console.log(`   After undo in Tab 2 -> Tab 1: ${p1AfterUndo2}, Tab 2: ${p2AfterUndo2}`)
    assert.equal(p1AfterUndo2, 3)
    assert.equal(p2AfterUndo2, 3)

    // Step 9: Further operation (draw another rectangle) after undo in Page 2
    console.log('\n▶ Step 9: Further operation (draw rectangle) after undo in Tab 2...')
    await page2.keyboard.press('KeyR')
    await sleep(300)
    await page2.mouse.move(900, 300)
    await page2.mouse.down()
    await page2.mouse.move(950, 350, { steps: 5 })
    await page2.mouse.up()
    await sleep(2000)

    let p1Final = await page1.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    let p2Final = await page2.evaluate(
      () => window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
    )
    console.log(`   Final active elements -> Tab 1: ${p1Final}, Tab 2: ${p2Final}`)
    assert.equal(p1Final, 4)
    assert.equal(p2Final, 4)

    console.log('\n======================================================================')
    console.log('🎉 ALL OPERATIONS PASSED: No automatic undo or state revert occurs!')
    console.log('======================================================================\n')
  } finally {
    await browser.close()
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
