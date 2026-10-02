import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE_URL = 'http://localhost:5173'

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runTest() {
  console.log('======================================================================')
  console.log('🧪 VERIFYING SOLO DELETE ALL -> INCOGNITO OPEN -> UNDO PROPAGATION')
  console.log('======================================================================\n')
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const boardId = `solo-undo-${Date.now().toString(36)}`
    const boardUrl = `${BASE_URL}/boards/${boardId}`
    console.log(`📌 Board URL: ${boardUrl}`)

    // Seed board in Tab 1
    const seedPage = await browser.newPage()
    await seedPage.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await seedPage.evaluate(async (id) => {
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      const { signInAnonymously } = await import('/src/features/collaboration/anonymous-user.ts')
      const auth = getFirebaseAuth()
      if (auth && !auth.currentUser) await signInAnonymously(auth)

      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
      const { sharingService } = await import('/src/features/sharing/sharing-service.ts')

      const proj = await workspaceApi.createProject('Solo Undo WS')
      await workspaceApi.saveBoard({
        id,
        projectId: proj.id,
        name: 'Solo Undo Board',
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
              groupIds: [],
              boundElements: null,
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

      await sharingService.saveShareConfig({
        boardId: id,
        boardName: 'Solo Undo Board',
        ownerId: auth.currentUser.uid,
        ownerName: 'Test Owner',
        generalAccess: 'anyone_with_link',
        generalRole: 'editor',
        collaborators: {},
        invitedEmails: [],
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
              groupIds: [],
              boundElements: null,
              version: 1,
              versionNonce: 1001,
            },
          ],
          appState: { viewBackgroundColor: '#ffffff' },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }, boardId)
    await seedPage.close()

    // Step 1: Open drawing in normal tab
    console.log('\n▶ Step 1: Open drawing in normal tab (Solo mode)...')
    const page1 = await browser.newPage()
    await page1.setViewport({ width: 1440, height: 900 })

    await page1.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page1.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await sleep(1500)

    const p1CollabState = await page1.evaluate(() => {
      return {
        collab: window.__lazyCollab,
        active: window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
      }
    })
    console.log(`   P1 Step 1 collab state:`, JSON.stringify(p1CollabState))
    assert.equal(p1CollabState.active, 1, 'P1 should start with 1 element')
    assert.equal(p1CollabState.collab.isLazyCollabActive, false, 'P1 should be in solo mode')

    // Step 2: Delete all drawing elements - Cmd+A + Del
    console.log('\n▶ Step 2: Delete all drawing elements - Cmd+A + Del in Tab 1...')
    await page1.bringToFront()
    await page1.keyboard.down('Meta')
    await page1.keyboard.press('KeyA')
    await page1.keyboard.up('Meta')
    await sleep(200)
    await page1.keyboard.press('Backspace')
    await sleep(2000)

    const p1AfterDelete = await page1.evaluate(() => {
      const all = window.__excalidrawAPI.getSceneElementsIncludingDeleted()
      return {
        active: window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
        all: all.map((e) => ({ id: e.id, version: e.version, versionNonce: e.versionNonce, isDeleted: e.isDeleted })),
        status: document.querySelector('.sync-status-pill')?.textContent?.trim() || '',
        collab: window.__lazyCollab,
      }
    })
    console.log(`   P1 after delete -> active: ${p1AfterDelete.active}, status: "${p1AfterDelete.status}"`)
    assert.equal(p1AfterDelete.active, 0, 'P1 should have 0 active elements after delete')

    // Step 3: Open drawing in incognito tab
    console.log('\n▶ Step 3: Open drawing in incognito tab...')
    const incognitoCtx = await browser.createBrowserContext()
    const page2 = await incognitoCtx.newPage()
    await page2.setViewport({ width: 1440, height: 900 })

    await page2.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page2.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await sleep(3000)

    const p2Initial = await page2.evaluate(() => {
      const all = window.__excalidrawAPI.getSceneElementsIncludingDeleted()
      return {
        active: window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
        all: all.map((e) => ({ id: e.id, version: e.version, versionNonce: e.versionNonce, isDeleted: e.isDeleted })),
        status: document.querySelector('.sync-status-pill')?.textContent?.trim() || '',
      }
    })
    console.log(`   P2 initial -> active: ${p2Initial.active}, status: "${p2Initial.status}"`)
    assert.equal(p2Initial.active, 0, 'P2 should initially have 0 active elements')

    // Step 4: Go to normal tab and undo deleting all elements - Cmd+Z
    console.log('\n▶ Step 4: In normal tab (Tab 1), press Undo (Cmd+Z)...')
    await page1.bringToFront()
    await page1.keyboard.down('Meta')
    await page1.keyboard.press('KeyZ')
    await page1.keyboard.up('Meta')
    await sleep(3000)

    const p1AfterUndo = await page1.evaluate(() => {
      const all = window.__excalidrawAPI.getSceneElementsIncludingDeleted()
      return {
        active: window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
        all: all.map((e) => ({ id: e.id, version: e.version, versionNonce: e.versionNonce, isDeleted: e.isDeleted })),
        status: document.querySelector('.sync-status-pill')?.textContent?.trim() || '',
        statusClass: document.querySelector('.sync-status-pill')?.className || '',
      }
    })
    const p2AfterUndo = await page2.evaluate(() => {
      const all = window.__excalidrawAPI.getSceneElementsIncludingDeleted()
      return {
        active: window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length,
        all: all.map((e) => ({ id: e.id, version: e.version, versionNonce: e.versionNonce, isDeleted: e.isDeleted })),
        status: document.querySelector('.sync-status-pill')?.textContent?.trim() || '',
        statusClass: document.querySelector('.sync-status-pill')?.className || '',
      }
    })

    console.log(`\n   >>> RESULTS AFTER UNDO:`)
    console.log(`   P1 -> active: ${p1AfterUndo.active}, status: "${p1AfterUndo.status}"`)
    console.log(`   P2 -> active: ${p2AfterUndo.active}, status: "${p2AfterUndo.status}"`)

    assert.equal(p1AfterUndo.active, 1, 'P1 must have 1 active element after Undo')
    assert.equal(p2AfterUndo.active, 1, 'P2 (incognito) must have 1 active element after P1 Undo')
    assert.ok(!p1AfterUndo.status.toLowerCase().includes('conflict'), 'P1 status must not be conflict')
    assert.ok(!p2AfterUndo.status.toLowerCase().includes('conflict'), 'P2 status must not be conflict')

    console.log('\n======================================================================')
    console.log('🎉 ALL CHECKS PASSED: Element successfully resurrected in both tabs with no conflict!')
    console.log('======================================================================\n')
  } finally {
    await browser.close()
  }
}

runTest().catch((err) => {
  console.error('\n❌ Test error:', err)
  process.exit(1)
})
