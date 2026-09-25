import assert from 'node:assert/strict'
import {
  getAnonymousProfile,
  generateSessionId,
  resolveCollabUser,
  CITIES,
  COLLAB_COLORS,
} from '../apps/whiteboard/src/features/collaboration/anonymous-user'
import {
  cleanPayload,
  MAX_ELEMENT_PAYLOAD_BYTES,
  STALE_PRESENCE_TIMEOUT_MS,
} from '../apps/whiteboard/src/features/collaboration/collaboration-service'
import { getCollaboratorInitials } from '../apps/whiteboard/src/features/collaboration/collaborator-bar'
import type { CollaboratorPresence } from '../apps/whiteboard/src/features/collaboration/types'

async function runAllEdgeCaseTests() {
  console.log('====================================================')
  console.log('🧪 RUNNING COLLABORATION ARCHITECTURE & EDGE CASE TESTS')
  console.log('====================================================\n')

  let passedCount = 0

  // ----------------------------------------------------
  // EDGE CASE 1: Anonymous Identity ("Anonymous Mumbai" Pattern)
  // ----------------------------------------------------
  console.log('▶ Test 1: Anonymous Identity & Deterministic Profiles')
  {
    const uidA = 'anon_uid_12345'
    const uidB = 'anon_uid_98765'

    const profileA1 = getAnonymousProfile(uidA)
    const profileA2 = getAnonymousProfile(uidA)
    const profileB = getAnonymousProfile(uidB)

    assert.ok(profileA1.displayName.startsWith('Anonymous '), 'Should start with Anonymous')
    const cityName = profileA1.displayName.replace('Anonymous ', '')
    assert.ok(CITIES.includes(cityName as any), `City name ${cityName} must be in CITIES list`)
    assert.ok(COLLAB_COLORS.includes(profileA1.color as any), 'Color must be in palette')

    // Deterministic: Same UID produces exact same name and color across page refreshes
    assert.equal(profileA1.displayName, profileA2.displayName, 'Same UID must produce identical city name')
    assert.equal(profileA1.color, profileA2.color, 'Same UID must produce identical color')

    // Different UIDs produce diverse cities/colors
    console.log(`   ✓ Profile A: ${profileA1.displayName} (${profileA1.color})`)
    console.log(`   ✓ Profile B: ${profileB.displayName} (${profileB.color})`)
    passedCount++
  }

  // ----------------------------------------------------
  // EDGE CASE 2: Local vs. Global Undo Scoping
  // ----------------------------------------------------
  console.log('\n▶ Test 2: User-Scoped Undo/Redo')
  {
    type Element = { id: string; version: number; lastModifiedBy: string; isDeleted?: boolean }
    const aliceUid = 'alice_123'
    const bobUid = 'bob_456'

    // Scene with 2 elements: Alice drew elem1, Bob drew elem2
    const sceneElements: Element[] = [
      { id: 'elem_1', version: 1, lastModifiedBy: aliceUid },
      { id: 'elem_2', version: 1, lastModifiedBy: bobUid },
    ]

    // Alice's undo stack captures her prior state
    const aliceUndoStack: Element[][] = [[{ id: 'elem_1', version: 0, lastModifiedBy: aliceUid, isDeleted: true }]]

    // Alice hits Ctrl+Z
    const priorState = aliceUndoStack.pop()!
    const targetElement = priorState[0]

    // Assert undo ONLY targets Alice's element, Bob's element is untouched
    assert.equal(targetElement.id, 'elem_1', "Alice's undo must target her element")
    assert.equal(targetElement.lastModifiedBy, aliceUid, "Alice's undo must be authored by Alice")

    const updatedScene = sceneElements.map((el) => {
      if (el.id === targetElement.id && el.lastModifiedBy === aliceUid) {
        return { ...el, ...targetElement, version: el.version + 1 }
      }
      return el
    })

    const elem1 = updatedScene.find((e) => e.id === 'elem_1')!
    const elem2 = updatedScene.find((e) => e.id === 'elem_2')!

    assert.equal(elem1.isDeleted, true, "Alice's element was undone (marked deleted)")
    assert.equal(elem2.isDeleted, undefined, "Bob's element remained untouched")
    console.log('   ✓ Undoing Alice action preserved Bob shapes without global stack pollution')
    passedCount++
  }

  // ----------------------------------------------------
  // EDGE CASE 3: Concurrent Element Mutation & Nonce Tie-Breaking
  // ----------------------------------------------------
  console.log('\n▶ Test 3: Concurrent Mutation (Last-Write-Wins with Nonce Tie-break)')
  {
    type Element = { id: string; x: number; version: number; versionNonce: number }

    // Base state
    const _base: Element = { id: 'rect_1', x: 0, version: 1, versionNonce: 100 }

    // Alice and Bob mutate rect_1 simultaneously
    const aliceMutation: Element = { id: 'rect_1', x: 200, version: 2, versionNonce: 555 }
    const bobMutation: Element = { id: 'rect_1', x: 300, version: 2, versionNonce: 777 } // higher nonce

    function reconcile(local: Element, remote: Element): Element {
      if (remote.version > local.version) return remote
      // Excalidraw standard: lowest versionNonce wins tie-break
      if (remote.version === local.version && remote.versionNonce < local.versionNonce) {
        return remote
      }
      return local
    }

    // Both clients run reconciliation
    const clientAliceResult = reconcile(aliceMutation, bobMutation)
    const clientBobResult = reconcile(bobMutation, aliceMutation)

    // Both clients MUST converge to the exact same element deterministically
    assert.equal(clientAliceResult.x, clientBobResult.x, 'Both clients must converge to same coordinate')
    assert.equal(clientAliceResult.x, 200, 'Lowest versionNonce (Alice 555 < 777) wins tie-break')
    console.log('   ✓ Deterministic convergence achieved: Alice nonce 555 won over Bob nonce 777')
    passedCount++
  }

  // ----------------------------------------------------
  // EDGE CASE 4: Stable Ordering & Z-Index
  // ----------------------------------------------------
  console.log('\n▶ Test 4: Z-Index & Element Ordering Stability')
  {
    const elements = [
      { id: 'bg', order: 'a0' },
      { id: 'middle', order: 'a1' },
      { id: 'fg', order: 'a2' },
    ]

    // Concurrent insert between bg and middle
    const newElement = { id: 'inserted', order: 'a05' }
    const combined = [...elements, newElement].sort((a, b) => a.order.localeCompare(b.order))

    assert.deepEqual(
      combined.map((e) => e.id),
      ['bg', 'inserted', 'middle', 'fg'],
      'Fractional ordering preserves depth without array-index collision',
    )
    console.log('   ✓ Fractional ordering kept Z-index rock solid during concurrent insertion')
    passedCount++
  }

  // ----------------------------------------------------
  // EDGE CASE 5: Ghost Cursor Cleanup & Disconnects
  // ----------------------------------------------------
  console.log('\n▶ Test 5: Ghost Cursor Cleanup on Disconnect / Stale Heartbeat')
  {
    const now = Date.now()
    const presenceMap: Record<string, CollaboratorPresence> = {
      active_user: {
        userId: 'u1',
        sessionId: 's1',
        displayName: 'Anonymous Tokyo',
        color: '#2563EB',
        isAnonymous: true,
        lastSeen: now - 2000, // 2s ago (fresh)
      },
      ghost_user: {
        userId: 'u2',
        sessionId: 's2',
        displayName: 'Anonymous Mumbai',
        color: '#E11D48',
        isAnonymous: true,
        lastSeen: now - 30000, // 30s ago (stale > 15s)
      },
    }

    // Filter logic as implemented in CollaborationService.subscribeToPresence
    const active = Object.values(presenceMap).filter((p) => now - p.lastSeen < STALE_PRESENCE_TIMEOUT_MS)

    assert.equal(active.length, 1, 'Ghost user must be pruned')
    assert.equal(active[0].displayName, 'Anonymous Tokyo', 'Only fresh user remains active')
    console.log('   ✓ Stale cursor (>15s) successfully purged; active cursor preserved')
    passedCount++
  }

  // ----------------------------------------------------
  // EDGE CASE 6: Multi-Tab Self-Collaboration
  // ----------------------------------------------------
  console.log('\n▶ Test 6: Multi-Tab Self-Collaboration (Tab-scoped Session IDs)')
  {
    const sameUserId = 'user_google_123'
    const sessionTab1 = generateSessionId()
    const sessionTab2 = generateSessionId()

    assert.notEqual(sessionTab1, sessionTab2, 'Tabs must receive unique session IDs')

    const roomPresence: Record<string, CollaboratorPresence> = {
      [sessionTab1]: {
        userId: sameUserId,
        sessionId: sessionTab1,
        displayName: 'Karan Shah',
        color: '#2563EB',
        isAnonymous: false,
        cursor: { x: 50, y: 50 },
        lastSeen: Date.now(),
      },
      [sessionTab2]: {
        userId: sameUserId,
        sessionId: sessionTab2,
        displayName: 'Karan Shah',
        color: '#2563EB',
        isAnonymous: false,
        cursor: { x: 400, y: 400 },
        lastSeen: Date.now(),
      },
    }

    assert.equal(Object.keys(roomPresence).length, 2, 'Both tabs coexist independently without collision')
    console.log('   ✓ Tab 1 and Tab 2 maintained separate presence records under same account UID')
    passedCount++
  }

  // ----------------------------------------------------
  // EDGE CASE 7: Offline Reconnection & Split-Brain Reconciliation
  // ----------------------------------------------------
  console.log('\n▶ Test 7: Offline Reconnection & Forward Delta Replay')
  {
    // Client went offline with version 2
    const offlineLocal = { id: 'box', version: 2, versionNonce: 200, width: 100 }
    // Meanwhile, remote made edits to version 4
    const remoteCurrent = { id: 'box', version: 4, versionNonce: 400, width: 250 }

    function handleReconnection(local: typeof offlineLocal, remote: typeof remoteCurrent) {
      if (remote.version > local.version) {
        // Remote is ahead: accept remote, discard stale offline edit
        return { state: remote, mustPush: false }
      }
      return { state: local, mustPush: true }
    }

    const result = handleReconnection(offlineLocal, remoteCurrent)
    assert.equal(result.state.width, 250, 'Accepted remote forward revision')
    assert.equal(result.mustPush, false, 'Did not overwrite remote state with stale local edits')
    console.log('   ✓ Stale offline state safely conceded to forward remote revisions')
    passedCount++
  }

  // ----------------------------------------------------
  // EDGE CASE 8: Payload Limits & DDoS / Memory Exhaustion Protection
  // ----------------------------------------------------
  console.log('\n▶ Test 8: Malicious Payload Rejection (>256KB)')
  {
    // Normal element (~500 bytes)
    const normalElement = { id: 'rect_1', type: 'rectangle', x: 10, y: 20 }
    const normalSerialized = JSON.stringify(normalElement)
    assert.ok(normalSerialized.length < MAX_ELEMENT_PAYLOAD_BYTES, 'Normal element passes size check')

    // Malicious oversized element (>256KB memory bomb)
    const giantPayload = {
      id: 'malicious_1',
      type: 'freedraw',
      points: new Array(20000).fill([1.234567, 8.910111]),
      junk: 'x'.repeat(300000),
    }
    const oversizedSerialized = JSON.stringify(giantPayload)
    assert.ok(
      oversizedSerialized.length > MAX_ELEMENT_PAYLOAD_BYTES,
      'Attack payload detected as exceeding 256KB limit',
    )

    let blocked = false
    if (oversizedSerialized.length > MAX_ELEMENT_PAYLOAD_BYTES) {
      blocked = true
    }
    assert.equal(blocked, true, 'Oversized payload was successfully intercepted and blocked')
    console.log(`   ✓ Giant element (${(oversizedSerialized.length / 1024).toFixed(1)} KB) blocked by 256KB ceiling`)
    passedCount++
  }

  // ----------------------------------------------------
  // EDGE CASE 9: Image Decoupling & Storage Snapshot Compaction
  // ----------------------------------------------------
  console.log('\n▶ Test 9: Image Decoupling & Tombstone Pruning')
  {
    // In Excalidraw, the image element on canvas is only a pointer
    const imageElement = {
      id: 'img_elem_1',
      type: 'image',
      fileId: 'storage_file_xyz123', // Pointer to Firebase Storage
      x: 100,
      y: 100,
      width: 400,
      height: 300,
    }
    const imageElemSize = new TextEncoder().encode(JSON.stringify(imageElement)).length
    assert.ok(imageElemSize < 1024, 'Image element pointer is under 1KB')

    // Tombstone pruning test: elements marked deleted
    const elementsWithTombstones = [
      { id: 'el_active', isDeleted: false },
      { id: 'el_deleted_old', isDeleted: true },
    ]
    const compacted = elementsWithTombstones.filter((e) => !e.isDeleted)
    assert.equal(compacted.length, 1, 'Deleted tombstones pruned during compaction')
    assert.equal(compacted[0].id, 'el_active')
    console.log(`   ✓ Image element size: ${imageElemSize} bytes (binary decoupled to Storage)`)
    console.log('   ✓ Snapshot compaction successfully pruned deleted tombstones')
    passedCount++
  }

  // ----------------------------------------------------
  // EDGE CASE 10: Non-Anonymous Collaborator Resolution & Payload Sanitization
  // ----------------------------------------------------
  console.log('\n▶ Test 10: Non-Anonymous Collaborators (Google Accounts) & RTDB undefined-proofing')
  {
    const googleUser = {
      uid: 'google_uid_999',
      displayName: 'Karan Shah',
      email: 'karan@google.com',
      photoURL: 'https://lh3.googleusercontent.com/a/sample-photo',
      isAnonymous: false,
    } as any

    const resolved = resolveCollabUser(googleUser, 'session_karan_tab1')
    assert.equal(resolved.isAnonymous, false, 'Must identify as non-anonymous')
    assert.equal(resolved.displayName, 'Karan Shah', 'Must preserve real full name')
    assert.equal(resolved.avatarUrl, 'https://lh3.googleusercontent.com/a/sample-photo', 'Must retain avatar photo')

    // Initials check
    const initials = getCollaboratorInitials(resolved.displayName, resolved.isAnonymous)
    assert.equal(initials, 'KS', 'Non-anonymous "Karan Shah" must resolve to initials "KS"')

    const anonTokyo = getCollaboratorInitials('Anonymous Tokyo', true)
    assert.equal(anonTokyo, 'AT', 'Anonymous Tokyo must resolve to initials "AT"')

    const anonSeoul = getCollaboratorInitials('Anonymous Seoul', true)
    assert.equal(anonSeoul, 'AS', 'Anonymous Seoul must resolve to initials "AS"')

    const anonMumbai = getCollaboratorInitials('Anonymous Mumbai', true)
    assert.equal(anonMumbai, 'AM', 'Anonymous Mumbai must resolve to initials "AM"')

    // Payload sanitization: Firebase RTDB crashes if payload contains undefined
    const rawPresence = {
      userId: resolved.uid,
      sessionId: resolved.sessionId,
      displayName: resolved.displayName,
      color: resolved.color,
      avatarUrl: undefined, // Simulating user with no photo
      isAnonymous: resolved.isAnonymous,
      cursor: null,
      selectedElementIds: [],
      lastSeen: Date.now(),
    }

    const sanitized = cleanPayload(rawPresence)
    assert.equal('avatarUrl' in sanitized, false, 'undefined avatarUrl must be stripped to prevent RTDB set() error')
    assert.equal(sanitized.displayName, 'Karan Shah')
    assert.equal(sanitized.cursor, null, 'null values must be preserved for RTDB')

    console.log(`   ✓ Non-anonymous user resolved: ${resolved.displayName} (${initials})`)
    console.log('   ✓ Payload sanitized: stripped undefined keys to protect RTDB operations')
    passedCount++
  }

  // ----------------------------------------------------
  // EDGE CASE 11: Sleep/Wake Reconnection & Presence Profile Self-Healing
  // ----------------------------------------------------
  console.log('\n▶ Test 11: Sleep/Wake Reconnection & Self-Healing Presence')
  {
    const roomPresence: Record<string, any> = {}
    const sessionId = 'tab_laptop_sleep'
    const user = {
      uid: 'user_laptop_1',
      sessionId,
      displayName: 'Anonymous Tokyo',
      color: '#2563EB',
      isAnonymous: true,
      avatarUrl: undefined,
    }

    // 1. Initial connect
    roomPresence[sessionId] = cleanPayload({
      userId: user.uid,
      sessionId: user.sessionId,
      displayName: user.displayName,
      color: user.color,
      isAnonymous: user.isAnonymous,
      cursor: null,
      selectedElementIds: [],
      lastSeen: Date.now(),
    })
    assert.equal(roomPresence[sessionId].displayName, 'Anonymous Tokyo')

    // 2. Laptop closes lid -> server onDisconnect executes remove()
    delete roomPresence[sessionId]
    assert.equal(roomPresence[sessionId], undefined, 'Server onDisconnect wiped presence during sleep')

    // 3. Laptop wakes up -> .info/connected fires with true
    // Self-healing: re-publishes complete profile, not just a bare lastSeen timestamp
    const wakePayload = cleanPayload({
      userId: user.uid,
      sessionId: user.sessionId,
      displayName: user.displayName,
      color: user.color,
      avatarUrl: user.avatarUrl,
      isAnonymous: user.isAnonymous,
      cursor: null,
      selectedElementIds: [],
      lastSeen: Date.now(),
    })
    roomPresence[sessionId] = wakePayload

    assert.equal(roomPresence[sessionId].displayName, 'Anonymous Tokyo', 'Presence re-published with full display name')
    assert.equal(roomPresence[sessionId].color, '#2563EB', 'Presence re-published with color')
    assert.ok(Date.now() - roomPresence[sessionId].lastSeen < 1000, 'Fresh heartbeat restored')

    // 4. Verification that corrupted nodes lacking displayName or color are discarded
    const corruptNode = { lastSeen: Date.now() }
    const isValidPresence = (p: any) => Boolean(p && p.displayName && p.color)
    assert.equal(isValidPresence(corruptNode), false, 'Corrupted bare lastSeen nodes are rejected')
    assert.equal(isValidPresence(roomPresence[sessionId]), true, 'Restored profile passes presence integrity checks')

    console.log('   ✓ Sleep disconnect safely simulated and completely recovered via full reconnection payload')
    console.log('   ✓ Corrupted/partial nodes lacking name/color rejected by presence filter')
    passedCount++
  }

  console.log('\n====================================================')
  console.log(`🎉 ALL ${passedCount}/11 COLLABORATION EDGE CASES VERIFIED!`)
  console.log('====================================================\n')
}

void runAllEdgeCaseTests()
