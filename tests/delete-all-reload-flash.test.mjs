import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runTest() {
  console.log('======================================================================')
  console.log('🧪 VERIFYING DELETE ALL ELEMENTS -> RELOAD -> ZERO FLASH')
  console.log('======================================================================\n')

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const boardId = `no-flash-${Date.now().toString(36)}`
    const boardUrl = `${BASE_URL}/boards/${boardId}`
    console.log(`📌 Target Board URL: ${boardUrl}\n`)

    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })

    let beforeunloadTriggered = false
    page.on('dialog', async (dialog) => {
      beforeunloadTriggered = true
      console.log('   ⚠️ Dialog appeared:', dialog.message())
      await dialog.accept()
    })

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })

    // Seed board directly into local workspaceStore with 3 elements
    await page.evaluate(async (id) => {
      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
      const proj = await workspaceApi.createProject('Test Project')
      await workspaceApi.saveBoard({
        id,
        projectId: proj.id,
        name: 'Flash Test Board',
        scene: {
          elements: [
            {
              id: 'box_1',
              type: 'rectangle',
              x: 150,
              y: 150,
              width: 120,
              height: 80,
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
            {
              id: 'box_2',
              type: 'rectangle',
              x: 350,
              y: 150,
              width: 120,
              height: 80,
              strokeColor: '#ef4444',
              backgroundColor: '#7f1d1d',
              fillStyle: 'solid',
              strokeWidth: 2,
              roughness: 1,
              opacity: 100,
              isDeleted: false,
              version: 1,
              versionNonce: 102,
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

    // Open the board
    await page.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.excalidraw canvas')
    await page.waitForFunction(() => Boolean(window.__excalidrawAPI))

    const initialVisible = await page.evaluate(() => {
      return window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length
    })
    console.log(`▶ Initial visible elements: ${initialVisible}`)
    assert.equal(initialVisible, 2, 'Board must have 2 visible elements initially')

    // Click canvas to focus and perform Cmd+A + Delete
    console.log('▶ Deleting all elements via Cmd+A + Backspace...')
    const canvas = await page.$('.excalidraw canvas')
    const box = await canvas.boundingBox()
    await page.mouse.click(box.x + 20, box.y + 20)

    await page.keyboard.down('Meta')
    await page.keyboard.press('KeyA')
    await page.keyboard.up('Meta')
    await page.keyboard.press('Backspace')

    // Wait for save debounce
    await sleep(1000)

    const afterDeleteVisible = await page.evaluate(() => {
      return window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length
    })
    console.log(`▶ Visible elements after delete: ${afterDeleteVisible}`)
    assert.equal(afterDeleteVisible, 0, 'Canvas must be empty after delete')

    // Verify UI status badge does NOT say 'Local save failed'
    const statusText = await page.evaluate(() => {
      const pill = document.querySelector('.sync-status-pill')
      return pill ? pill.textContent.trim() : null
    })
    console.log(`▶ Status pill text: "${statusText}"`)
    assert.ok(
      statusText && !statusText.includes('failed') && !statusText.includes('Conflict'),
      `Status pill must NOT indicate save failure, got: "${statusText}"`,
    )

    // Verify saved state in IndexedDB has tombstones (isDeleted: true) and no conflict
    const fullDoc = await page.evaluate(async (id) => {
      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
      return workspaceApi.loadBoard(id)
    }, boardId)
    const stored = fullDoc?.scene?.elements?.map((e) => ({ id: e.id, isDeleted: e.isDeleted })) ?? []
    console.log('▶ Stored in IndexedDB:', stored)
    assert.ok(
      stored.length > 0 && stored.every((e) => e.isDeleted === true),
      'All elements in storage must be marked isDeleted: true',
    )
    assert.notEqual(fullDoc?.syncStatus, 'conflict', 'Document must not be in conflict status')
    assert.equal(fullDoc?.lastSyncError, null, 'lastSyncError must be null')

    // Reload the page
    console.log('\n▶ Reloading page...')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(window.__excalidrawAPI))

    // Check IMMEDIATELY upon reload: must be 0 visible elements (NO FLASH)
    const immediateReloadVisible = await page.evaluate(() => {
      const els = window.__excalidrawAPI.getSceneElements()
      return els.filter((e) => !e.isDeleted).length
    })
    console.log(`▶ Elements immediately on reload (t=0ms): ${immediateReloadVisible}`)
    assert.equal(immediateReloadVisible, 0, 'No elements must appear on reload — zero flash!')

    // Check across subsequent time intervals to ensure stability
    for (const delay of [200, 400, 600]) {
      await sleep(200)
      const count = await page.evaluate(() => {
        return window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted).length
      })
      assert.equal(count, 0, `Elements must remain 0 at t=${delay}ms`)
    }

    assert.equal(beforeunloadTriggered, false, 'No beforeunload confirmation dialog should appear')
    console.log('\n✅ TEST PASSED: All elements deleted, 0 elements rendered on reload with ZERO flash!')
  } finally {
    await browser.close()
  }
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err)
  process.exit(1)
})
