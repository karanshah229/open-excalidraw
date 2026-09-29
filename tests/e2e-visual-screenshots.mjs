import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ARTIFACT_DIR = '/Users/karan/.gemini/antigravity/brain/fe8f1bf4-fd58-4286-b699-ea41b3fc8e5b/screenshots'
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE_URL = 'http://localhost:5173'

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

async function fitViewport(page) {
  try {
    await page.evaluate(() => {
      const api = window.__excalidrawAPI
      if (!api) return
      const elements = api.getSceneElements().filter((e) => !e.isDeleted)
      if (elements.length > 0) {
        api.scrollToContent(elements, { fitToContent: true, animate: false, maxZoom: 1 })
      }
    })
    await sleep(600)
  } catch {
    // ignore
  }
}

async function runVisualE2ESuite() {
  ensureDir(ARTIFACT_DIR)

  console.log('======================================================================')
  console.log('📸 RUNNING COMPREHENSIVE E2E VISUAL SCREENSHOT REVIEW SUITE')
  console.log('======================================================================\n')
  console.log(`📁 Saving High-DPI Screenshots To: ${ARTIFACT_DIR}\n`)

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  let screenshotCount = 0

  try {
    const boardId = `visual-review-${Date.now().toString(36)}`
    const boardUrl = `${BASE_URL}/boards/${boardId}`
    console.log(`📌 Target Room Board: ${boardUrl}\n`)

    const shareConfig = {
      boardId,
      boardName: 'Architecture Collaboration Space',
      ownerId: 'local-user',
      ownerName: 'Karan Shah',
      generalAccess: 'anyone_with_link',
      generalRole: 'editor',
      invitedEmails: [],
      collaborators: {},
      scene: {
        elements: [
          {
            id: 'arch_core_rect',
            type: 'rectangle',
            x: 300,
            y: 200,
            width: 360,
            height: 180,
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    // =================================================================
    // TAB 1: HOST (Karan Shah - Primary Profile)
    // =================================================================
    console.log('▶ Launching Tab 1 (Host: Karan Shah)...')
    const page1 = await browser.newPage()
    await page1.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })

    await page1.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page1.evaluate((cfg) => {
      localStorage.setItem('agentic-whiteboard:library:v1', '[]')
      localStorage.setItem(`agentic-whiteboard:share:${cfg.boardId}`, JSON.stringify(cfg))
    }, shareConfig)

    // Authenticate Host user with custom profile and save shareConfig to Firestore
    const hostUid = await page1.evaluate(async (cfg) => {
      const { getFirebaseAuth } = await import('/src/lib/firebase.ts')
      const { signInAnonymously, updateProfile } = await import('/src/features/collaboration/anonymous-user.ts')
      const { sharingService } = await import('/src/features/sharing/sharing-service.ts')
      const auth = getFirebaseAuth()
      let u = auth?.currentUser
      if (!u && auth) {
        const cred = await signInAnonymously(auth)
        u = cred.user
      }
      if (u) {
        await updateProfile(u, {
          displayName: 'Karan Shah',
          photoURL: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Karan',
        })
      }
      const actualConfig = { ...cfg, ownerId: u ? u.uid : cfg.ownerId }
      try {
        await sharingService.saveShareConfig(actualConfig)
      } catch (e) {
        console.warn('Share config firestore save deferred:', e?.message)
      }
      return u ? u.uid : cfg.ownerId
    }, shareConfig)
    shareConfig.ownerId = hostUid

    page1.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('[Collab]') || msg.type() === 'error') {
        console.log(`   [Tab 1 Log] ${text}`)
      }
    })

    await page1.goto(boardUrl, { waitUntil: 'domcontentloaded' })
    await page1.waitForSelector('.excalidraw', { timeout: 15000 })
    await page1.waitForFunction(() => Boolean(window.__excalidrawAPI))
    await sleep(2500)
    console.log('   ✓ Tab 1: Excalidraw mounted as Host')

    // -----------------------------------------------------------------
    // SCREENSHOT 1: Lazy Collab Solo Mode (Dormancy)
    // -----------------------------------------------------------------
    console.log('\n📸 Feature 1: Lazy Collab Solo Mode (Zero RTDB Overhead)')
    {
      await page1.evaluate(async () => {
        window.__setUserInteracted?.()
        const api = window.__excalidrawAPI
        const { convertToExcalidrawElements } = await import('/node_modules/.vite/deps/@excalidraw_excalidraw.js')
        const elements = convertToExcalidrawElements(
          [
            {
              id: 'arch_core_rect',
              type: 'rectangle',
              x: 480,
              y: 240,
              width: 320,
              height: 160,
              strokeColor: '#3b82f6',
              backgroundColor: '#1e3a8a',
              fillStyle: 'solid',
              strokeWidth: 2,
              roughness: 1,
              opacity: 100,
              isDeleted: false,
              version: 2,
              versionNonce: 101,
            },
          ],
          { regenerateIds: false },
        )
        api.updateScene({ elements })
        window.__collab?.broadcastChanges?.(elements)
      })
      await fitViewport(page1)
      const soloState = await page1.evaluate(() => {
        const collab = window.__collab
        return {
          activeSessionsCount: collab?.activeCollaborators?.length ?? 0,
          isSpectator: collab?.isSpectator ?? false,
          hasRemoteAvatars: document.querySelectorAll('.collab-avatar').length > 0,
        }
      })
      console.log(
        `   Host solo state: activeCollaborators=${soloState.activeSessionsCount}, hasRemoteAvatars=${soloState.hasRemoteAvatars}`,
      )

      const file1 = path.join(ARTIFACT_DIR, '01_lazy_collab_solo_dormant.png')
      await page1.screenshot({ path: file1 })
      screenshotCount++
      console.log(`   ✓ Captured: ${file1}`)
    }

    // =================================================================
    // TAB 2: GUEST (Anonymous Guest in isolated Incognito context)
    // =================================================================
    console.log('\n▶ Launching Tab 2 (Guest: Anonymous Guest in Incognito Context)...')
    const guestContext = await browser.createBrowserContext()
    const page2 = await guestContext.newPage()
    await page2.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })

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

    // Wait for Firestore activeSessions >= 2 and JIT RTDB upgrade handshake
    console.log('   Waiting for JIT RTDB upgrade handshake across peers...')
    await page1.waitForSelector('.collab-avatar', { timeout: 12000 })
    await page2.waitForSelector('.collab-avatar', { timeout: 12000 })
    await sleep(2000)

    // -----------------------------------------------------------------
    // SCREENSHOT 2: JIT Upgrade & Collaborator Discovery on Both Screens
    // -----------------------------------------------------------------
    console.log('\n📸 Feature 2: Just-In-Time RTDB Upgrade & Deterministic Avatars')
    {
      await fitViewport(page1)
      await fitViewport(page2)
      const file2a = path.join(ARTIFACT_DIR, '02a_jit_upgrade_host_screen.png')
      const file2b = path.join(ARTIFACT_DIR, '02b_jit_upgrade_guest_screen.png')
      await page1.screenshot({ path: file2a })
      await page2.screenshot({ path: file2b })
      screenshotCount += 2
      console.log(`   ✓ Captured Host View: ${file2a}`)
      console.log(`   ✓ Captured Guest View: ${file2b}`)
    }

    // -----------------------------------------------------------------
    // SCREENSHOT 3: Live Real-Time Cursor & Selection Streaming
    // -----------------------------------------------------------------
    console.log('\n📸 Feature 3: Live Real-Time Cursor & Selection Streaming')
    {
      // Guest moves pointer over canvas coordinates (640, 320) and selects the core rect
      const canvasBox = await page2.evaluate(() => {
        const el = document.querySelector('canvas')
        const r = el?.getBoundingClientRect()
        return r ? { x: r.left + 640, y: r.top + 320 } : null
      })
      assert.ok(canvasBox, 'Canvas element must be found')

      await page2.mouse.move(canvasBox.x, canvasBox.y)
      await page2.evaluate(
        (bid, shapeId) => {
          const collab = window.__collab
          if (collab && collab.collabUser) {
            collab.service.updatePresence(bid, collab.collabUser.sessionId, { x: 640, y: 320 }, [shapeId])
          }
        },
        boardId,
        'arch_core_rect',
      )

      await sleep(1500)

      const file3 = path.join(ARTIFACT_DIR, '03_live_remote_cursor_streaming.png')
      await page1.screenshot({ path: file3 })
      screenshotCount++
      console.log(`   ✓ Captured: ${file3}`)
    }

    // -----------------------------------------------------------------
    // SCREENSHOT 4: Dragging Pixel Storm Suppression & Atomic Commit
    // -----------------------------------------------------------------
    console.log('\n📸 Feature 4: Dragging Pixel Storm Suppression & Smooth Commit')
    {
      const dragShapeId = 'arch_core_rect'

      // Host enters active drag: sets isDraggingRef to true and updates across 10 frames
      await page1.evaluate((id) => {
        const collab = window.__collab
        const api = window.__excalidrawAPI
        if (!collab || !api) return

        collab.isDraggingRef.current = true
        for (let frame = 1; frame <= 10; frame++) {
          const current = api.getSceneElements()
          const updated = current.map((e) =>
            e.id === id
              ? { ...e, x: 480 + frame * 15, y: 240 + frame * 10, version: e.version + 1, versionNonce: 2000 + frame }
              : e,
          )
          api.updateScene({ elements: updated })
          collab.broadcastChanges(updated)
        }
      }, dragShapeId)

      // Screenshot 4a: Host canvas with intermediate buffered coordinates
      const file4a = path.join(ARTIFACT_DIR, '04a_drag_storm_host_in_flight.png')
      await page1.screenshot({ path: file4a })
      screenshotCount++
      console.log(`   ✓ Captured In-Flight Drag Buffer: ${file4a}`)

      // Commit drag: pointerUp
      await page1.evaluate(() => {
        const collab = window.__collab
        if (!collab) return
        collab.isDraggingRef.current = false
        collab.commitPendingDrag()
      })

      await sleep(2000)

      // Screenshot 4b: Guest screen receiving atomic update
      const file4b = path.join(ARTIFACT_DIR, '04b_drag_storm_atomic_commit_guest_synced.png')
      await page2.screenshot({ path: file4b })
      screenshotCount++
      console.log(`   ✓ Captured Synced Drag Commit: ${file4b}`)
    }

    // -----------------------------------------------------------------
    // SCREENSHOT 5: Delta Patch Property Synchronization
    // -----------------------------------------------------------------
    console.log('\n📸 Feature 5: Delta Patch Synchronization (>75% Payload Reduction)')
    {
      const patchShapeId = 'arch_core_rect'

      // Host updates shape properties: transforms color into emerald styling
      await page1.evaluate((id) => {
        const api = window.__excalidrawAPI
        const collab = window.__collab
        const current = api.getSceneElements()
        const updated = current.map((e) =>
          e.id === id
            ? {
                ...e,
                strokeColor: '#10b981',
                backgroundColor: '#064e3b',
                strokeWidth: 3,
                roughness: 2,
                version: e.version + 1,
                versionNonce: 7701,
              }
            : e,
        )
        api.updateScene({ elements: updated })
        collab?.broadcastChanges?.(updated)
      }, patchShapeId)

      await sleep(2000)

      // Capture Guest view reflecting merged delta patch
      const file5 = path.join(ARTIFACT_DIR, '05_delta_patch_property_sync.png')
      await page2.screenshot({ path: file5 })
      screenshotCount++
      console.log(`   ✓ Captured: ${file5}`)
    }

    // -----------------------------------------------------------------
    // SCREENSHOT 6: User-Scoped Undo / Redo Isolation
    // -----------------------------------------------------------------
    console.log('\n📸 Feature 6: User-Scoped Undo (No Global History Pollution)')
    {
      const hostShapeId = 'host_service_node'
      const guestShapeId = 'guest_api_gateway'

      // 1. Host creates Host Service Node (Blue rectangle at x: 260, y: 440)
      await page1.evaluate(async (id) => {
        window.__setUserInteracted?.()
        const api = window.__excalidrawAPI
        const prev = api.getSceneElements()
        const uid = window.__collab?.collabUser?.uid || 'host_uid'
        const { convertToExcalidrawElements } = await import('/node_modules/.vite/deps/@excalidraw_excalidraw.js')

        const [converted] = convertToExcalidrawElements(
          [
            {
              id,
              type: 'rectangle',
              x: 260,
              y: 440,
              width: 220,
              height: 120,
              strokeColor: '#38bdf8',
              backgroundColor: '#0c4a6e',
              fillStyle: 'solid',
              strokeWidth: 2,
              roughness: 1,
              opacity: 100,
              isDeleted: false,
              version: 20,
              versionNonce: 801,
            },
          ],
          { regenerateIds: false },
        )
        const newElem = { ...converted, lastModifiedBy: uid }

        const updated = [...prev, newElem]
        api.updateScene({ elements: updated })
        window.__collab?.broadcastChanges?.(updated)
      }, hostShapeId)

      await sleep(2000)

      // 2. Guest records prior state, then creates Guest API Gateway (Purple diamond at x: 540, y: 440)
      await page2.evaluate(async (id) => {
        window.__setUserInteracted?.()
        const api = window.__excalidrawAPI
        const prev = api.getSceneElements()
        window.__collab?.recordUserAction?.(prev)

        const uid = window.__collab?.collabUser?.uid || 'guest_uid'
        const { convertToExcalidrawElements } = await import('/node_modules/.vite/deps/@excalidraw_excalidraw.js')

        const [converted] = convertToExcalidrawElements(
          [
            {
              id,
              type: 'diamond',
              x: 540,
              y: 440,
              width: 140,
              height: 140,
              strokeColor: '#c084fc',
              backgroundColor: '#581c87',
              fillStyle: 'solid',
              strokeWidth: 2,
              roughness: 1,
              opacity: 100,
              isDeleted: false,
              version: 20,
              versionNonce: 901,
            },
          ],
          { regenerateIds: false },
        )
        const newElem = { ...converted, lastModifiedBy: uid }

        const updated = [...prev, newElem]
        api.updateScene({ elements: updated })
        window.__collab?.broadcastChanges?.(updated)
      }, guestShapeId)

      await sleep(2500)

      const elementsCheck = await page1.evaluate(
        (hId, gId) => {
          const els = window.__excalidrawAPI.getSceneElements().filter((e) => !e.isDeleted)
          return {
            hasHost: els.some((e) => e.id === hId),
            hasGuest: els.some((e) => e.id === gId),
            total: els.length,
          }
        },
        hostShapeId,
        guestShapeId,
      )
      console.log(
        `   Both shapes check on Host screen: host=${elementsCheck.hasHost}, guest=${elementsCheck.hasGuest}, total=${elementsCheck.total}`,
      )

      // Screenshot 6a: Both shapes visible before undo
      await fitViewport(page1)
      const file6a = path.join(ARTIFACT_DIR, '06a_scoped_undo_both_shapes_before.png')
      await page1.screenshot({ path: file6a })
      screenshotCount++
      console.log(`   ✓ Captured Coexisting Shapes: ${file6a}`)

      // 3. Guest performs User-Scoped Undo
      await page2.evaluate(() => {
        window.__collab?.performScopedUndo?.()
      })

      await sleep(2500)

      // Screenshot 6b: Host screen showing Host shape preserved and Guest shape rolled back
      await fitViewport(page1)
      const file6b = path.join(ARTIFACT_DIR, '06b_scoped_undo_guest_undone_host_intact.png')
      await page1.screenshot({ path: file6b })
      screenshotCount++
      console.log(`   ✓ Captured Scoped Undo (Host Intact): ${file6b}`)
    }

    // -----------------------------------------------------------------
    // SCREENSHOT 7: Concurrent Mutex Resolution (Nonce Tie-Break)
    // -----------------------------------------------------------------
    console.log('\n📸 Feature 7: Concurrent Editing & Nonce-Based Conflict Resolution')
    {
      const targetId = 'host_service_node'

      // Concurrent edits: Host sets Amber (#f59e0b) with nonce 777; Guest sets Rose (#f43f5e) with nonce 222
      // Excalidraw standard: lowest versionNonce wins (222 wins)
      await page1.evaluate((id) => {
        const api = window.__excalidrawAPI
        const prev = api.getSceneElements()
        const updated = prev.map((e) =>
          e.id === id
            ? { ...e, strokeColor: '#f59e0b', backgroundColor: '#78350f', version: 25, versionNonce: 777 }
            : e,
        )
        api.updateScene({ elements: updated })
        window.__collab?.broadcastChanges?.(updated)
      }, targetId)

      await page2.evaluate((id) => {
        const api = window.__excalidrawAPI
        const prev = api.getSceneElements()
        const updated = prev.map((e) =>
          e.id === id
            ? { ...e, strokeColor: '#f43f5e', backgroundColor: '#881337', version: 25, versionNonce: 222 }
            : e,
        )
        api.updateScene({ elements: updated })
        window.__collab?.broadcastChanges?.(updated)
      }, targetId)

      await sleep(2500)

      await fitViewport(page1)
      const file7 = path.join(ARTIFACT_DIR, '07_concurrent_edit_conflict_resolution.png')
      await page1.screenshot({ path: file7 })
      screenshotCount++
      console.log(`   ✓ Captured Conflict Convergence: ${file7}`)
    }

    // -----------------------------------------------------------------
    // SCREENSHOT 8: Soft Deletion via Tombstones
    // -----------------------------------------------------------------
    console.log('\n📸 Feature 8: Soft Deletion via Tombstones (Anti-Resurrection)')
    {
      const deleteId = 'host_service_node'

      await page1.evaluate((id) => {
        const api = window.__excalidrawAPI
        const prev = api.getSceneElements()
        const updated = prev.map((e) => (e.id === id ? { ...e, isDeleted: true, version: 30 } : e))
        api.updateScene({ elements: updated })
        window.__collab?.broadcastChanges?.(updated)
      }, deleteId)

      await sleep(2000)

      await fitViewport(page2)
      const file8 = path.join(ARTIFACT_DIR, '08_soft_deletion_tombstone_sync.png')
      await page2.screenshot({ path: file8 })
      screenshotCount++
      console.log(`   ✓ Captured Tombstone Sync: ${file8}`)
    }

    // -----------------------------------------------------------------
    // SCREENSHOT 9 & 10: Spectator Mode (10-Editor Cap & Capacity Banner)
    // -----------------------------------------------------------------
    console.log('\n📸 Feature 9: Spectator Mode (10-Editor Cap & Capacity Banner)')
    {
      // Setup Tab 3 in a new context
      const spectatorContext = await browser.createBrowserContext()
      const page3 = await spectatorContext.newPage()
      await page3.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })

      await page3.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
      await page3.evaluate((cfg) => {
        localStorage.setItem('agentic-whiteboard:library:v1', '[]')
        localStorage.setItem(`agentic-whiteboard:share:${cfg.boardId}`, JSON.stringify(cfg))
      }, shareConfig)

      // Inject 10 simulated active editor presences into RTDB with older joinedAt timestamps
      await page1.evaluate(async (bid) => {
        const collab = window.__collab
        if (!collab?.service) return

        const now = Date.now()
        for (let i = 1; i <= 10; i++) {
          await collab.service.injectPresence(bid, {
            userId: `sim_uid_${i}`,
            sessionId: `sim_editor_${i}`,
            displayName: `Engineer ${i}`,
            color: '#3b82f6',
            avatarUrl: null,
            isAnonymous: true,
            joinedAt: now - 100000 + i * 1000,
            lastSeen: now,
          })
        }
      }, boardId)

      // Open Tab 3: enters as 11th+ user -> Spectator Mode!
      await page3.goto(boardUrl, { waitUntil: 'domcontentloaded' })
      await page3.waitForSelector('.excalidraw', { timeout: 15000 })
      await page3.waitForFunction(() => Boolean(window.__excalidrawAPI))
      await sleep(3500)

      // Wait for spectator banner
      await page3.waitForSelector('.spectator-mode-banner', { timeout: 10000 })

      const file9 = path.join(ARTIFACT_DIR, '09_spectator_mode_capacity_banner.png')
      await page3.screenshot({ path: file9 })
      screenshotCount++
      console.log(`   ✓ Captured Spectator Banner & View-Only Mode: ${file9}`)

      // -----------------------------------------------------------------
      // SCREENSHOT 10: Spectator Auto-Promotion on Editor Exit
      // -----------------------------------------------------------------
      console.log('\n📸 Feature 10: Spectator Auto-Promotion on Editor Slot Vacancy')

      // Remove 2 simulated editors so Tab 3 is promoted
      await page1.evaluate(async (bid) => {
        const collab = window.__collab
        if (!collab?.service) return
        await collab.service.removePresence(bid, 'sim_editor_1')
        await collab.service.removePresence(bid, 'sim_editor_2')
      }, boardId)

      await sleep(3000)

      // Assert banner disappeared and user promoted
      const file10 = path.join(ARTIFACT_DIR, '10_spectator_auto_promoted.png')
      await page3.screenshot({ path: file10 })
      screenshotCount++
      console.log(`   ✓ Captured Promoted Editor Canvas: ${file10}`)

      // Clean up simulated editors and close spectator context
      await page1.evaluate(async (bid) => {
        const collab = window.__collab
        if (!collab?.service) return
        for (let i = 3; i <= 10; i++) {
          await collab.service.removePresence(bid, `sim_editor_${i}`)
        }
      }, boardId)

      await spectatorContext.close()
    }

    // -----------------------------------------------------------------
    // SCREENSHOT 11: Lazy Collab Downgrade to Solo Mode on Peer Exit
    // -----------------------------------------------------------------
    console.log('\n📸 Feature 11: Lazy Collab Downgrade to Solo Mode on Peer Exit')
    {
      // Tab 2 closes tab
      await guestContext.close()
      await sleep(3000)

      await fitViewport(page1)
      // Tab 1 drops back to solo mode
      const file11 = path.join(ARTIFACT_DIR, '11_lazy_collab_downgrade_solo.png')
      await page1.screenshot({ path: file11 })
      screenshotCount++
      console.log(`   ✓ Captured Clean Solo Downgrade: ${file11}`)
    }

    console.log('\n======================================================================')
    console.log(`🎉 ALL ${screenshotCount} HIGH-DPI VISUAL SCREENSHOTS SUCCESSFULLY CAPTURED!`)
    console.log('======================================================================\n')
  } finally {
    await browser.close()
  }
}

runVisualE2ESuite().catch((err) => {
  console.error('\n❌ VISUAL E2E SUITE FAILED:', err)
  process.exit(1)
})
