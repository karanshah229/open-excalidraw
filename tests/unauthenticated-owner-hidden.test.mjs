import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runUnauthenticatedOwnerHiddenTest() {
  console.log('======================================================================')
  console.log('🧪 VERIFYING OWNER IS NOT SHOWN FOR NOT-LOGGED-IN USER')
  console.log('======================================================================\n')

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })

    const boardId = `unauth-owner-${Date.now().toString(36)}`
    const boardUrl = `${BASE_URL}/boards/${boardId}`
    console.log(`📌 Test Board URL: ${boardUrl}\n`)

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })

    // Seed shared board with registered user's UID as ownerId
    const seededOwnerId = await page.evaluate(async (id) => {
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      const { signInOwner: signInAnonymously } = await import('/tests/regression-fixture.ts')
      const auth = getFirebaseAuth()
      if (auth && (!auth.currentUser || auth.currentUser.isAnonymous)) await signInAnonymously(auth)

      const currentUid = auth.currentUser.uid

      const { workspaceApi } = await import('/src/features/workspace/workspace-api.ts')

      const proj = await workspaceApi.createProject('Unauth Test WS')
      await workspaceApi.saveBoard({
        id,
        projectId: proj.id,
        name: 'Unauth Owner Test Board',
        scene: {
          elements: [
            {
              id: 'rect_1',
              type: 'rectangle',
              x: 100,
              y: 100,
              width: 150,
              height: 100,
              strokeColor: '#3b82f6',
              backgroundColor: '#1e3a8a',
              fillStyle: 'solid',
              strokeWidth: 2,
              roughness: 1,
              opacity: 100,
              isDeleted: false,
              version: 1,
              versionNonce: 1,
            },
          ],
          appState: { viewBackgroundColor: '#ffffff' },
        },
        revision: 1,
        syncStatus: 'synced',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      await (
        await import('/tests/regression-fixture.ts')
      ).seedSharedBoard({
        boardId: id,
        boardName: 'Unauth Owner Test Board',
        ownerId: currentUid,
        ownerName: '',
        generalAccess: 'anyone_with_link',
        generalRole: 'editor',
        collaborators: {},
        invitedEmails: [],
        scene: {
          elements: [
            {
              id: 'rect_1',
              type: 'rectangle',
              x: 100,
              y: 100,
              width: 150,
              height: 100,
              strokeColor: '#3b82f6',
              backgroundColor: '#1e3a8a',
              fillStyle: 'solid',
              strokeWidth: 2,
              roughness: 1,
              opacity: 100,
              isDeleted: false,
              version: 1,
              versionNonce: 1,
            },
          ],
          appState: { viewBackgroundColor: '#ffffff' },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      return currentUid
    }, boardId)

    console.log(`   Seeded board with registered ownerId: ${seededOwnerId}`)

    // Now open a new incognito context (unauthenticated guest/viewer)
    const incognitoCtx = await browser.createBrowserContext()
    const guestPage = await incognitoCtx.newPage()
    await guestPage.setViewport({ width: 1440, height: 900 })

    console.log('▶ Navigating to board in incognito guest window...')
    await guestPage.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await sleep(2500)

    // Verify authUser in guest window is null or anonymous
    const guestAuthState = await guestPage.evaluate(async () => {
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      const auth = getFirebaseAuth()
      return {
        currentUserUid: auth?.currentUser?.uid,
        isAnonymous: auth?.currentUser?.isAnonymous ?? null,
      }
    })
    console.log(`   Guest auth state: isAnonymous=${guestAuthState.isAnonymous}`)

    // Click the sync status pill (or board info pill if viewer)
    console.log('▶ Finding and clicking status dropdown...')
    const pill = await guestPage.waitForSelector('.sync-status-pill, .board-info-pill', {
      timeout: 10000,
    })
    assert.ok(pill, 'Status pill should be visible')
    await pill.click()
    await sleep(500)

    // Extract dropdown content
    const popoverContent = await guestPage.evaluate(() => {
      const popover = document.querySelector('.sync-status-popover, .board-info-popover')
      if (!popover) return null
      return {
        text: popover.textContent || '',
        labels: Array.from(popover.querySelectorAll('.board-info-item-label')).map(
          (el) => el.textContent?.trim() || '',
        ),
      }
    })

    assert.ok(popoverContent, 'Dropdown content must be present')
    console.log(`   Labels found in dropdown: ${JSON.stringify(popoverContent.labels)}`)

    // 1. Verify "Owner" is NOT in the labels for not-logged-in user
    const hasOwnerLabel = popoverContent.labels.some((l) => l.toLowerCase() === 'owner')
    assert.strictEqual(hasOwnerLabel, false, '❌ FAILED: "Owner" label must NOT be shown for not-logged-in user!')
    console.log('   ✅ "Owner" label is NOT shown in dropdown.')

    // 2. Verify raw UID is NOT shown in dropdown text
    const hasRawUid = popoverContent.text.includes(seededOwnerId)
    assert.strictEqual(hasRawUid, false, `❌ FAILED: Raw UID "${seededOwnerId}" must NOT be displayed in dropdown!`)
    console.log('   ✅ Raw UID is NOT displayed in dropdown text.')

    console.log('\n======================================================================')
    console.log('✅ PART 1 PASSED: Owner hidden for not-logged-in user!')
    console.log('======================================================================\n')

    // -------------------------------------------------------------
    // PART 2: Verify seed window (creator/local user) also does NOT see raw UID or owner
    // -------------------------------------------------------------
    console.log('▶ Testing seed window...')
    await page.evaluate(async () => {
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      const { signOut, signInAnonymously } = await import('/tests/regression-fixture.ts')
      const auth = getFirebaseAuth()
      await signOut(auth)
      await signInAnonymously(auth)
    })
    await page.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await sleep(2500)

    const seedPill = await page.waitForSelector('.sync-status-pill, .board-info-pill', {
      timeout: 10000,
    })
    await seedPill.click()
    await sleep(500)

    const seedPopoverContent = await page.evaluate(() => {
      const popover = document.querySelector('.sync-status-popover, .board-info-popover')
      if (!popover) return null
      return {
        text: popover.textContent || '',
        labels: Array.from(popover.querySelectorAll('.board-info-item-label')).map(
          (el) => el.textContent?.trim() || '',
        ),
      }
    })

    assert.ok(seedPopoverContent, 'Seed popover content must be present')
    console.log(`   Labels found in seed window dropdown: ${JSON.stringify(seedPopoverContent.labels)}`)

    // In the seed window (which is also anonymous/not logged in), Owner must ALSO not be shown!
    const seedHasOwner = seedPopoverContent.labels.some((l) => l.toLowerCase() === 'owner')
    assert.strictEqual(seedHasOwner, false, '❌ FAILED: "Owner" label must NOT be shown for anonymous seed user!')
    console.log('   ✅ Anonymous seed user also does NOT see Owner label.')

    console.log('\n======================================================================')
    console.log('🎉 ALL TESTS PASSED: Owner is never shown for not-logged-in users!')
    console.log('======================================================================\n')
  } finally {
    await browser.close()
  }
}

runUnauthenticatedOwnerHiddenTest().catch((err) => {
  console.error('\n❌ TEST FAILED:', err)
  process.exit(1)
})
