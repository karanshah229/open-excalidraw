import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'

const BASE_URL = 'http://localhost:5173'
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function runCreateBoardModalDropdownScrollTest() {
  console.log('========================================================================')
  console.log('🧪 VERIFYING CREATE BOARD MODAL - PROJECT DROPDOWN SCROLLABILITY (E2E)')
  console.log('========================================================================\n')

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 800 })

    console.log('▶ Step 1: Navigating to base URL and setting up authenticated test user & projects...')
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })

    await page.evaluate(async () => {
      localStorage.setItem(
        'agentic-whiteboard:e2e-user',
        JSON.stringify({
          uid: 'e2e-tester-uid',
          email: 'tester@example.com',
          displayName: 'E2E Tester',
          isAnonymous: false,
        }),
      )

      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')
      for (let i = 1; i <= 20; i++) {
        await workspaceApi.createProject(`E2E Project ${i.toString().padStart(2, '0')}`)
      }
    })

    console.log('▶ Step 2: Reloading page to enter workspace view...')
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await sleep(1000)

    console.log('▶ Step 3: Finding and clicking "New board" button...')
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const newBoardBtn = buttons.find((b) => b.textContent?.includes('New board'))
      if (newBoardBtn) {
        newBoardBtn.click()
        return true
      }
      return false
    })
    assert.ok(clicked, 'Expected "New board" button to exist and be clicked')

    console.log('▶ Step 4: Waiting for "Create new board" dialog...')
    await page.waitForSelector('.dialog-content', { timeout: 5000 })
    const titleText = await page.evaluate(() => document.querySelector('.create-board-title')?.textContent)
    assert.equal(titleText, 'Create new board')
    console.log('   ✓ Dialog is open with title "Create new board"')

    console.log('▶ Step 5: Clicking project dropdown trigger...')
    const trigger = await page.waitForSelector('#project-select', { timeout: 5000 })
    assert.ok(trigger, 'Project select trigger button exists')
    await trigger.click()

    console.log('▶ Step 6: Waiting for project dropdown list to appear...')
    await page.waitForSelector('.project-dropdown-list', { timeout: 5000 })
    const listElement = await page.$('.project-dropdown-list')
    assert.ok(listElement, 'Project dropdown list element must exist in DOM')

    const { clientHeight, scrollHeight, initialScrollTop } = await page.evaluate((el) => {
      return {
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        initialScrollTop: el.scrollTop,
      }
    }, listElement)

    console.log(`   Initial dimensions: clientHeight=${clientHeight}px, scrollHeight=${scrollHeight}px, scrollTop=${initialScrollTop}px`)
    assert.ok(scrollHeight > clientHeight, `Expected scrollHeight (${scrollHeight}) to be greater than clientHeight (${clientHeight}) to require scrolling`)
    assert.equal(initialScrollTop, 0, 'Initial scrollTop should be 0')

    console.log('▶ Step 7: Performing mouse wheel scroll over the dropdown list...')
    const box = await listElement.boundingBox()
    assert.ok(box, 'Bounding box for dropdown list must be present')

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel({ deltaY: 250 })
    await sleep(400)

    const afterScrollTop = await page.evaluate((el) => el.scrollTop, listElement)
    console.log(`   ScrollTop after mouse wheel: ${afterScrollTop}px`)

    assert.ok(
      afterScrollTop > 0,
      `Project dropdown list must be scrollable! Expected scrollTop > 0, but got ${afterScrollTop}px`,
    )
    console.log('   ✓ Project dropdown list successfully scrolled with mouse wheel!')

    console.log('▶ Step 8: Selecting a project from the scrolled list...')
    const selectedName = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.project-dropdown-item-name'))
      const target = items.find((item) => item.textContent?.includes('E2E Project 10'))
      if (target) {
        target.closest('button')?.click()
        return target.textContent
      }
      return null
    })

    assert.ok(selectedName, 'Expected to click on E2E Project 10')
    await sleep(200)

    const labelText = await page.evaluate(() => document.querySelector('.project-dropdown-trigger-label')?.textContent)
    console.log(`   Selected project trigger label: "${labelText}"`)
    assert.ok(labelText?.includes('E2E Project 10'), `Expected trigger label to show selected project, got "${labelText}"`)

    console.log('\n========================================================================')
    console.log('🎉 ALL TESTS PASSED: Project dropdown is fully scrollable and functional!')
    console.log('========================================================================\n')
  } finally {
    await browser.close()
  }
}

runCreateBoardModalDropdownScrollTest().catch((err) => {
  console.error('\n❌ TEST FAILED:', err)
  process.exit(1)
})
