# Handoff Document: Resilient Collaboration Lifecycle, Compaction & Zero Data-Loss Sync

## 1. Context & Objective

This handoff document provides the complete specification and implementation guide for the incoming AI agent or engineer tasked with building the **Resilient Collaboration Lifecycle, Server-Side Room Compaction, and Monotonic Version Guarding** in Open Excalidraw.

### The Problem Being Solved

The current collaboration implementation (Phase 2) successfully handles live delta syncing over Firebase RTDB and spectator limits. However, the teardown and persistence mechanisms rely on single-client React state transitions (`!isLazyCollabActive && prevLazyActiveRef.current`) and browser `beforeunload` / `visibilitychange` events:

1. **Simultaneous Exit Data Loss:** If all collaborators close their tabs, shut laptop lids, or lose power simultaneously, `beforeunload` network writes fail or abort mid-flight. The edits made during collaboration remain trapped in RTDB, and Firestore stays stale.
2. **Orphaned RTDB Deltas:** The client-side `clearBoardElements(boardId)` fails to execute when all tabs close abruptly, leaving orphaned delta nodes in RTDB.
3. **Stale Firestore Overwrite Race:** If a single user remains or re-opens a board while Firestore is stale, an incoming Firestore snapshot could overwrite newer in-memory canvas elements if version guards are not strictly enforced.
4. **Delta Patch Incompleteness Trap:** RTDB stores lightweight delta patches (`{ id, x, y, version, versionNonce }`), NOT full Excalidraw element objects. A naive compaction script that dumps RTDB into Firestore directly will corrupt elements by stripping styling, shapes, and bindings.

### The Solution Architecture

1. **Server-Side RTDB Event Trigger (Zero-Member Compaction):** A Cloud Function triggered on RTDB presence deletion (`/presence/{boardId}/{sessionId}`) detects when a room is completely empty, waits a 30-second grace period for reloads, merges RTDB patches onto the Firestore base scene, updates Firestore, and purges RTDB deltas.
2. **"Last Person Standing" Single Flush:** When active members drop from $\ge 2$ to $1$, the sole remaining client immediately flushes their in-memory scene to Firestore. Because there is only one writer, this write is 100% collision-free.
3. **Client-Side Monotonic Version Guard:** Prevent any incoming Firestore snapshot from clobbering newer local canvas elements using Excalidraw's `reconcileElements` and monotonic version comparison.
4. **Local-First Durability:** Ensure local IndexedDB (RxDB) remains the primary fallback for offline and transient disconnect states.

---

## 2. Core Architectural Principles

```
                  ┌─────────────────────────────────────────┐
                  │        2+ Members (Active Room)         │
                  │        RTDB live delta streaming        │
                  └────────────────────┬────────────────────┘
                                       │
                       Member leaves   │   All members leave
                                       │   simultaneously
                     ┌─────────────────┴─────────────────┐
                     ▼                                   ▼
      ┌─────────────────────────────┐     ┌─────────────────────────────┐
      │    1 Member Left (Solo)     │     │       0 Members Left        │
      ├─────────────────────────────┤     ├─────────────────────────────┤
      │ • Sole author pushes once   │     │ • RTDB presence empty       │
      │   to Firestore (no race)    │     │ • Cloud Function trigger    │
      │ • RTDB deltas purged        │     │   waits 30s grace period    │
      │ • Version Guard protects    │     │ • 3-way merge RTDB patches  │
      │   canvas from stale reads   │     │   onto Firestore base       │
      └─────────────────────────────┘     │ • Purges RTDB deltas        │
                                          └─────────────────────────────┘
```

### Principle A: Never Rely on the Browser to Save on Exit

Browser teardown events (`beforeunload`, `unload`, `pagehide`) are notoriously unreliable for asynchronous network calls (`setDoc` / `updateDoc`). Operating systems will kill browser network threads when a tab is closed or a laptop lid is shut. The authoritative safety net **must reside on the backend**.

### Principle B: 3-Way Merge on Compaction (Patches $\neq$ Elements)

When consolidating RTDB to Firestore:

- **Input 1:** Authoritative Base Scene from Firestore (`boardShares/{boardId}.scene.elements`).
- **Input 2:** Changed Delta Patches from RTDB (`boards/{boardId}/elements/{elementId}`).
- **Merged Output:** Each element in RTDB overlays its patch properties onto the existing base element. Completely new elements in RTDB are appended. Deleted tombstones (`isDeleted: true`) are preserved or pruned according to compaction rules.

### Principle C: Monotonic Version Guard

A client must **never** do a wholesale replacement of canvas elements from a Firestore snapshot without verifying that the cloud revision is newer. If `localMaxVersion > cloudMaxVersion`, the local scene must take precedence, and the local state should be re-asserted to Firestore.

---

## 3. Implementation Specifications

### Task 1: Client-Side Monotonic Version Guard & Clean Reconciliation

**File:** [`apps/whiteboard/src/routes/board-editor.tsx`](file:///Users/karan/projects/Personal_projects/agentic-whiteboard/apps/whiteboard/src/routes/board-editor.tsx)

#### 1. Replace Blind Firestore Canvas Replacement

Locate the `subscribeToSharedBoard` listener (around lines 619–630):

```typescript
// CURRENT (FRAGILE):
if (updatedConfig.scene && !pendingSceneRef.current) {
  const newSignature = getSceneSignature(updatedConfig.scene)
  if (newSignature !== savedSignature.current) {
    savedSignature.current = newSignature
    committedSignatureRef.current = newSignature
    elementsRef.current = updatedConfig.scene.elements
    appStateRef.current = updatedConfig.scene.appState
    apiRef.current?.updateScene({
      elements: updatedConfig.scene.elements as any,
    })
  }
}
```

#### 2. Replace with Monotonic Reconciliation:

```typescript
import { reconcileElements } from '@excalidraw/excalidraw'

// NEW (RESILIENT):
if (updatedConfig.scene) {
  const cloudElements = updatedConfig.scene.elements || []
  const localElements = elementsRef.current || []

  // Compute maximum element versions
  const localMaxVersion = localElements.reduce((max, el) => Math.max(max, Number(el?.version || 0)), 0)
  const cloudMaxVersion = cloudElements.reduce((max, el) => Math.max(max, Number(el?.version || 0)), 0)

  // Guard: If local state is strictly newer than cloud snapshot, reject the overwrite
  if (localMaxVersion > cloudMaxVersion) {
    console.warn(
      `[Collab Guard] Cloud snapshot is stale (v${cloudMaxVersion} < local v${localMaxVersion}). Rejecting canvas overwrite.`,
    )
    // Optionally trigger a write-back if in solo mode to repair cloud state
    if (!isLazyCollabActive && !isReadOnly) {
      void flushSave()
    }
    return
  }

  // Use Excalidraw's engine to merge non-conflicting elements safely
  const reconciled = reconcileElements(localElements, cloudElements, appStateRef.current as any)
  const newSignature = getSceneSignature({ elements: reconciled, appState: updatedConfig.scene.appState })

  if (newSignature !== savedSignature.current) {
    savedSignature.current = newSignature
    committedSignatureRef.current = newSignature
    elementsRef.current = reconciled
    apiRef.current?.updateScene({
      elements: reconciled as any,
    })
  }
}
```

---

### Task 2: "Last Person Standing" Solo Transition Flush

**File:** [`apps/whiteboard/src/routes/board-editor.tsx`](file:///Users/karan/projects/Personal_projects/agentic-whiteboard/apps/whiteboard/src/routes/board-editor.tsx)

#### 1. Transition when `activeSessions.length === 1`

When the room transitions from $\ge 2$ active sessions to $1$:

1. The remaining user is the sole author.
2. Immediately take the composite scene (`elementsRef.current`) and persist it to Firestore via `enqueueSceneSave(scene)`.
3. Wipe the RTDB deltas with `clearBoardElements(boardId)`.
4. Transition safely to solo mode where subsequent edits use standard debounced autosaves.

```typescript
// Inside the transition effect:
useEffect(() => {
  if (isLazyCollabActive && !prevLazyActiveRef.current) {
    // Upgrading to Collab (>= 2 users)
    if (hasEstablishedSoloRef.current) {
      setIsTransitioningCollab(true)
    }
    if (pendingSceneRef.current) {
      void flushSave()
    }
    const timer = window.setTimeout(() => setIsTransitioningCollab(false), 700)
    prevLazyActiveRef.current = isLazyCollabActive
    return () => window.clearTimeout(timer)
  } else if (!isLazyCollabActive && prevLazyActiveRef.current) {
    // Downgrading to Solo (< 2 users): "Last Person Standing"
    if (elementsRef.current && elementsRef.current.length > 0 && !isReadOnly) {
      const scene: BoardScene = {
        elements: elementsRef.current,
        appState: {
          theme: appStateRef.current.theme,
          viewBackgroundColor: appStateRef.current.viewBackgroundColor,
          gridModeEnabled: appStateRef.current.gridModeEnabled,
          objectsSnapModeEnabled: appStateRef.current.objectsSnapModeEnabled,
        },
      }
      // Single conflict-free push to Firestore
      void enqueueSceneSave(scene)
    }
    // Clean RTDB delta tree
    void clearBoardElements(boardId)
    prevLazyActiveRef.current = isLazyCollabActive
  }
}, [isLazyCollabActive, flushSave, enqueueSceneSave, boardId, clearBoardElements, isReadOnly])
```

---

### Task 3: Backend RTDB Event Trigger (Cloud Function)

**Directory:** `functions/` (or Firebase Functions package in workspace)

Implement an RTDB trigger listening to `/presence/{boardId}/{sessionId}`. When a session disconnects and no other sessions remain in the room, it runs the server-side compaction.

#### Cloud Function Implementation:

```typescript
import { onValueDeleted } from 'firebase-functions/v2/database'
import { initializeApp } from 'firebase-admin/app'
import { getDatabase } from 'firebase-admin/database'
import { getFirestore } from 'firebase-admin/firestore'

initializeApp()

export const onCollabSessionDisconnected = onValueDeleted(
  {
    ref: '/presence/{boardId}/{sessionId}',
    region: 'us-central1', // Match project deployment region
  },
  async (event) => {
    const { boardId } = event.params
    const rtdb = getDatabase()
    const db = getFirestore()

    // 1. Check if any active sessions remain in the room
    const presenceSnap = await rtdb.ref(`presence/${boardId}`).get()
    const currentSessions = presenceSnap.val()
    if (currentSessions && Object.keys(currentSessions).length > 0) {
      // Room still has active collaborators; nothing to compact
      return
    }

    console.log(`[Collab Compactor] Room ${boardId} presence dropped to 0. Starting 30s grace timer...`)

    // 2. 30-Second Grace Period for Page Reloads / Wi-Fi blips
    await new Promise((resolve) => setTimeout(resolve, 30_000))

    // 3. Verify presence after grace period
    const recheckSnap = await rtdb.ref(`presence/${boardId}`).get()
    const recheckSessions = recheckSnap.val()
    if (recheckSessions && Object.keys(recheckSessions).length > 0) {
      console.log(`[Collab Compactor] User reconnected to room ${boardId}. Aborting compaction.`)
      return
    }

    console.log(`[Collab Compactor] Room ${boardId} confirmed empty. Beginning 3-way consolidation...`)

    // 4. Fetch base scene from Firestore and delta patches from RTDB
    const [boardDocSnap, rtdbElementsSnap] = await Promise.all([
      db.doc(`boardShares/${boardId}`).get(),
      rtdb.ref(`boards/${boardId}/elements`).get(),
    ])

    if (!rtdbElementsSnap.exists()) {
      console.log(`[Collab Compactor] Room ${boardId} has no RTDB elements to compact.`)
      return
    }

    const rtdbElementsMap = rtdbElementsSnap.val() || {}
    const baseElements = boardDocSnap.exists() ? boardDocSnap.data()?.scene?.elements || [] : []

    // 5. 3-Way Merge: Apply delta patches onto base elements
    const elementMap = new Map<string, any>()
    for (const el of baseElements) {
      if (el?.id) elementMap.set(el.id, { ...el })
    }

    for (const record of Object.values(rtdbElementsMap) as any[]) {
      if (!record || !record.id || !record.data) continue
      try {
        const patch = JSON.parse(record.data)
        const existing = elementMap.get(record.id)

        if (existing) {
          // If remote patch has newer version, merge properties
          if (
            patch.version > existing.version ||
            (patch.version === existing.version && patch.versionNonce <= existing.versionNonce)
          ) {
            elementMap.set(record.id, { ...existing, ...patch })
          }
        } else {
          // Newly created element in RTDB
          elementMap.set(record.id, patch)
        }
      } catch (err) {
        console.error(`[Collab Compactor] Failed to parse delta patch for element ${record.id}:`, err)
      }
    }

    const mergedElements = Array.from(elementMap.values())

    // 6. Write consolidated authoritative scene to Firestore
    await db.doc(`boardShares/${boardId}`).set(
      {
        scene: {
          elements: mergedElements,
        },
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    )

    console.log(
      `[Collab Compactor] Successfully updated Firestore for room ${boardId} (${mergedElements.length} elements).`,
    )

    // 7. Purge RTDB elements and clean presence
    await Promise.all([rtdb.ref(`boards/${boardId}/elements`).remove(), rtdb.ref(`presence/${boardId}`).remove()])

    console.log(`[Collab Compactor] Purged RTDB room ${boardId}. Cleanup complete.`)
  },
)
```

---

## 4. Edge Case Handling Matrix

| Scenario                                   | Risk                                                             | Mitigation                                                                                                                                            |
| :----------------------------------------- | :--------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **All users close laptops simultaneously** | Browser `beforeunload` aborted by OS; Firestore is stale.        | RTDB TCP drop fires `onCollabSessionDisconnected` on backend $\rightarrow$ 30s grace $\rightarrow$ 3-way merge to Firestore $\rightarrow$ purge RTDB. |
| **User hits `Cmd + R` (Page Reload)**      | Presence hits 0 for 2 seconds; room could be prematurely wiped.  | 30-second server grace period re-checks presence. Reloaded client reconnects within 3s $\rightarrow$ trigger aborts cleanup.                          |
| **User B leaves; User A stays**            | Competing writes or stale read overwriting User A.               | User A is sole writer (no competition). Monotonic Version Guard rejects stale Firestore reads. User A pushes composite in-memory state.               |
| **User A closes tab 200ms after User B**   | User A's client push fails mid-flight.                           | Backend RTDB trigger detects presence = 0, performs the 3-way merge from RTDB to Firestore.                                                           |
| **Delta patch missing properties**         | Naive compaction corrupts shapes by stripping stroke/color/seed. | Compaction merges RTDB patch objects onto Firestore base elements before writing back to Firestore.                                                   |
| **Complete offline loss (Network cut)**    | User draws without internet.                                     | Edits persist to local RxDB / IndexedDB first. Sync queue retries with `reconcileElementsLWW` on reconnect.                                           |

---

## 5. File Quick-Reference

| File                                                                                                                                                                                   | Changes Required                                                                                                                            |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------ |
| [`apps/whiteboard/src/routes/board-editor.tsx`](file:///Users/karan/projects/Personal_projects/agentic-whiteboard/apps/whiteboard/src/routes/board-editor.tsx)                         | Add Monotonic Version Guard in `subscribeToSharedBoard`; enforce "Last Person Standing" flush on `isLazyCollabActive` downgrade.            |
| [`apps/whiteboard/src/features/collaboration/reconcile.ts`](file:///Users/karan/projects/Personal_projects/agentic-whiteboard/apps/whiteboard/src/features/collaboration/reconcile.ts) | Export helper for 3-way delta patch merging (`applyDeltaPatch`, `mergeDeltasOntoBase`).                                                     |
| [`functions/src/index.ts`](file:///Users/karan/projects/Personal_projects/agentic-whiteboard/functions)                                                                                | Deploy `onCollabSessionDisconnected` RTDB trigger with 30s grace period and 3-way consolidation.                                            |
| [`database.rules.json`](file:///Users/karan/projects/Personal_projects/agentic-whiteboard/database.rules.json)                                                                         | Ensure Admin SDK bypass rules or service account permissions allow Cloud Functions to read/purge `boards/$boardId` and `presence/$boardId`. |

---

## 6. Verification & Test Plan

1. **Unit Test (3-Way Merge):**
   - Provide a base element `{ id: "1", type: "rectangle", x: 10, y: 10, strokeColor: "#000", version: 1 }`.
   - Provide an RTDB patch `{ id: "1", x: 50, version: 2 }`.
   - Verify output retains `strokeColor: "#000"`, `type: "rectangle"`, with updated `x: 50` and `version: 2`.
2. **Version Guard Test:**
   - Simulate a local canvas with element `version: 5`.
   - Trigger a mock Firestore update with element `version: 2`.
   - Verify local canvas does not roll back to version 2.
3. **Simultaneous Exit Puppeteer E2E Test:**
   - Open 2 browser contexts in Puppeteer.
   - User A and User B create multiple shapes.
   - Simultaneously call `browserA.close()` and `browserB.close()` without waiting for UI flushes.
   - Wait 35 seconds (for server grace period to expire).
   - Fetch the board document directly from Firestore via Firebase Admin SDK.
   - Assert all shapes drawn by User A and User B exist in the Firestore document.
   - Fetch RTDB `boards/{boardId}/elements`; assert it has been purged (`null`).
4. **Quick Reload Test:**
   - User A is solo in collab mode.
   - Reload tab (`page.reload()`).
   - Assert room is NOT purged and drawing remains intact.
