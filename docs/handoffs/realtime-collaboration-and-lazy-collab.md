# Handoff Document: Real-Time Collaboration, Lazy Upgrades & Sync Optimizations

## 1. Context & Purpose

This handoff document is prepared for the incoming AI agent or engineer taking over the collaboration and real-time synchronization subsystem in **Open Excalidraw**.

It summarizes:

1. What has been built and verified in production so far.
2. Architectural decisions and agreements made with the user.
3. The next phase of development: **Lazy Collab**, **Dragging Pixel Storm Mitigation**, **Payload Field Stripping**, and **Spectator Mode (10-Editor Cap)**.

---

## 2. Current System Status (What is Built and Live)

The core real-time collaboration engine is currently deployed to production at `https://open-excalidraw-b2ab4.web.app` and committed on `main`.

### Verified Capabilities:

- **Silent Anonymous Firebase Auth:** Visitors without a session silently invoke `signInAnonymously(auth)`. An `isAuthReady` gate blocks database subscriptions until `auth.currentUser` is present, eliminating permission rejections.
- **Deterministic Identity & Styling:** Hashes visitor UIDs to generate `Anonymous [City]` names (e.g. `Anonymous Mumbai`, `Anonymous Seoul`) with standardized initials (`AM`, `AS`) and matching color palettes. Local user is excluded from collaborator bar; Excalidraw built-in duplicate footer is suppressed.
- **Two-Tier Storage Architecture:**
  - **Cold Storage (Firestore & IndexedDB):** Debounced 450ms autosave (`scheduleSave`) writes the **full compiled board snapshot** (`{ elements: [...], appState }`) to local RxDB and Firestore (`boardShares/{boardId}`).
  - **Hot Storage (Firebase RTDB):** Streams live cursor positions (30Hz) and **element-level deltas** over WebSockets.
- **Client-Side Element Delta Broadcasting:** `useCollaboration` tracks `knownElementVersionsRef` and only dispatches modified shapes (`changedElements`) to `boards/:boardId/elements/:elementId`. It does **not** broadcast the whole board over RTDB.
- **User-Scoped Undo (`performScopedUndo`):** `Ctrl+Z` filters history to roll back only mutations authored by the current user (`lastModifiedBy === authorUid`). Co-worker shapes remain intact.
- **Deterministic Conflict Tie-Breaking:** Resolves concurrent edits using Excalidraw's lowest `versionNonce` rule. If a peer holds the winning nonce, it re-asserts the winning shape back to RTDB so peers and server converge.
- **Network Lifecycle & Auto-Recovery:** RTDB `onDisconnect().remove()` clears ghost cursors. The client listens to `.info/connected`, `window.online`, and `document.visibilitychange` to automatically re-arm presence and restore connections after sleep without requiring a page reload.
- **Multi-Tab / Multi-Monitor Coexistence:** Uses tab-scoped `sessionId` (`${uid}_${random}`) so the same user can open boards on multiple screens without clobbering their presence.

### Automated Test Suites (Must Always Remain Green):

- **Live Multi-Browser Puppeteer E2E Suite:** `pnpm test:e2e:collab` (9/9 passed).
- **Algorithmic Edge-Case Suite:** `pnpm test:collab` (11/11 passed).
- **Typecheck & Production Build:** `pnpm run check && pnpm run build`.

---

## 3. Key Architectural Decisions Agreed With User

1. **No Artificial Limits on Content:**
   - **No element caps:** A board with 2,000 shapes should not be artificially capped if our delta syncing is efficient.
   - **No cloud board count limits:** A board record in Firestore is only 1–5 KB. 1 GB of free Firestore storage holds ~200,000 boards; capping boards was an unnecessary restriction.
   - **No artificial owner-vs-public resource reservation splits:** Keep a unified global pool.
2. **Focus on Architectural Efficiency Over Throttling:**
   - Optimize the network protocol rather than punishing users with UX blockers.
3. **Firestore Remains a Snapshot Store:**
   - Continue pushing the entire board snapshot on debounced autosave (every 450ms+ after drawing pauses). No complex backend delta compiler is required.

---

## 4. Next Phase: Detailed Implementation Specifications

The incoming agent should implement the following optimizations in order:

### Task 1: Lazy Collab (Just-In-Time RTDB Connection)

#### The Problem:

Currently, `useCollaboration` connects to RTDB whenever `isFirebaseConfigured && boardId` is truthy.
If 95% of sessions are solo drawing, opening a persistent RTDB WebSocket for every single solo user wastes the 100-connection limit of the Firebase free tier and broadcasts empty cursor streams.

#### The Solution:

Connect to RTDB **only when more than 1 editable user is active on a board**.

#### Implementation Spec:

1. **Private / Workspace Boards (`isSharedBoard === false`):**
   - RTDB is **100% OFF** (`enabled: false`).
   - All drawing saves directly to local IndexedDB and Firestore.
   - Consumes 0 RTDB connections, 0 RTDB bandwidth.
2. **Shared Boards (`isSharedBoard === true`):**
   - The client already listens to `sharingService.subscribeToSharedBoard(boardId)` via a single Firestore document listener.
   - When a user opens a shared board, register their active presence timestamp in a lightweight map on the shared board metadata:
     `activeEditors: { [userUid]: lastSeenTimestamp }`
   - A client runs a lightweight heartbeat or presence update to Firestore when opening/closing the board.
   - When `Object.keys(activeEditors).length >= 2`:
     - **Upgrade to Live RTDB:** Both users dynamically toggle `useCollaboration` `enabled: true`.
     - RTDB WebSocket opens, element delta listeners activate, cursor streaming starts.
   - When peer count drops back to 1 (peer closes tab or idle for >2 minutes):
     - **Downgrade to Solo:** Disconnect from RTDB (`enabled: false`), remove presence, return to dormant solo mode.

---

### Task 2: Optimizing the Dragging Pixel Storm

#### The Problem:

When a user drags a shape across the canvas for 2 seconds, Excalidraw's engine updates `x` and `y` on every single mouse frame (60–120 times per second).
Currently, `broadcastChanges` fires on each frame, dispatching dozens of element updates to RTDB.

#### The Solution:

1. **Broadcast Drag State via Ephemeral Cursor/Selection Channel:**
   - While the mouse button is down (`isDragging === true`), do not write element deltas to `/boards/:boardId/elements/:elementId`.
   - Instead, broadcast the in-flight coordinate deltas through the throttled pointer/presence channel (`presence/:boardId/:sessionId`), which already runs at a throttled 30Hz and uses lightweight ephemeral payloads.
2. **Commit Final Delta on Pointer Up:**
   - Only when the user finishes dragging and releases the mouse button (`pointerUp` / `button === 'up'`) commit the final element delta with its incremented `version` and new `versionNonce` to RTDB.
   - **Expected Impact:** Cuts RTDB element write volume and egress by **90%** during drawing/moving operations.

---

### Task 3: Payload Field Stripping (Delta Patches)

#### The Problem:

An Excalidraw element object contains ~30 properties (`seed`, `roughness`, `roundness`, `boundElements`, `strokeStyle`, `fillStyle`, `strokeWidth`, `opacity`, `groupIds`, `link`, etc.).
When moving a shape, only `{ x, y, version, versionNonce, lastModifiedBy }` actually change. Broadcasting the full 1KB+ serialized JSON object on every change is redundant.

#### The Solution:

1. Maintain a shallow element property comparison against the previously broadcast snapshot in `useCollaboration`.
2. For mutations where styling hasn't changed, send a lightweight delta patch:
   ```ts
   // Instead of full 30-property object:
   { id: "rect_1", x: 300, y: 150, version: 5, versionNonce: 98124, lastModifiedBy: "uid_1" }
   ```
3. Remote peers merge incoming patches into their local element objects before calling `reconcileElements()`.
4. Full elements are only sent on initial element creation.

---

### Task 4: Spectator Mode (Cap at 10 Active Editors)

#### The Problem:

Rooms with large numbers of simultaneous users trigger $O(N^2)$ cursor broadcasting fanout, saturating RTDB bandwidth.

#### The Solution:

1. The first **10 users** to join a board are granted **Active Editor** status:
   - Full 2-way WebSockets.
   - Live pointer broadcasting.
   - Direct element write access.
2. The **11th+ user** is connected in **Spectator Mode (Read-Only)**:
   - Does **not** broadcast cursor or presence packets.
   - Listens passively to RTDB element updates (or fetches periodic snapshots via RTDB REST `GET /boards/:id/elements.json`).
   - The UI displays: _"Viewing mode (Room at editor capacity: 10/10)"_.
   - If an active editor leaves, a spectator can be automatically promoted to editor.

---

## 5. File & Directory Quick-Reference

| File                                                                                                                                                                                                           | Primary Responsibility                                                                                      |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------- |
| [`apps/whiteboard/src/routes/board-editor.tsx`](file:///Users/karan/projects/Personal_projects/agentic-whiteboard/apps/whiteboard/src/routes/board-editor.tsx)                                                 | Editor view, Excalidraw API binding, autosave queue (`scheduleSave`), and `useCollaboration` orchestration. |
| [`apps/whiteboard/src/features/collaboration/use-collaboration.ts`](file:///Users/karan/projects/Personal_projects/agentic-whiteboard/apps/whiteboard/src/features/collaboration/use-collaboration.ts)         | Primary hook managing local history, element diffing, pointer throttling, and scoped undo.                  |
| [`apps/whiteboard/src/features/collaboration/collaboration-service.ts`](file:///Users/karan/projects/Personal_projects/agentic-whiteboard/apps/whiteboard/src/features/collaboration/collaboration-service.ts) | RTDB communication layer (`updatePresence`, `broadcastElementDeltas`, `.info/connected`).                   |
| [`apps/whiteboard/src/features/sharing/sharing-service.ts`](file:///Users/karan/projects/Personal_projects/agentic-whiteboard/apps/whiteboard/src/features/sharing/sharing-service.ts)                         | Firestore share configs, permissions, and board scene sync.                                                 |
| [`database.rules.json`](file:///Users/karan/projects/Personal_projects/agentic-whiteboard/database.rules.json)                                                                                                 | RTDB security rules enforcing authentication on boards and presence.                                        |
| [`tests/e2e-collab-suite.mjs`](file:///Users/karan/projects/Personal_projects/agentic-whiteboard/tests/e2e-collab-suite.mjs)                                                                                   | Live Multi-Browser Puppeteer E2E test suite (9 scenarios).                                                  |
| [`tests/collab-edge-cases.test.ts`](file:///Users/karan/projects/Personal_projects/agentic-whiteboard/tests/collab-edge-cases.test.ts)                                                                         | 11 unit/algorithmic edge case simulations.                                                                  |

---

## 6. Verification Checklist for Next Agent

Before marking tasks complete:

1. `pnpm run check && pnpm run build` must complete with 0 errors.
2. `pnpm run lint` must report 0 errors and 0 warnings.
3. `pnpm test:collab` must pass all 11 architectural checks.
4. `pnpm test:e2e:collab` must pass all 9 live multi-browser Puppeteer scenarios.
