# Implementation Plan: Resilient Collaboration Lifecycle, Compaction & User-Scoped Undo

## 1. Executive Summary & First Principles

To guarantee that collaborative diagramming is rock-solid and conflict-free under real-world usage (offline usage, multiple concurrent tabs, abrupt closes, rapid undo/redo, text/arrow modifications), the collaboration system adheres strictly to 7 core pillars:

1. **Deterministic Fresh Load:** On board load, compare local document version (`IndexedDB`) with cloud document version (`Firestore`).
   - If Cloud is $\ge$ Local: load Firestore scene into canvas, background-update IndexedDB cache.
   - If Local is newer (user made edits offline):
     - Online: Merge via LWW + Nonce (`reconcileElementsLWW`), push merged scene to Firestore, update IndexedDB, show `Synced`.
     - Offline: Load local scene directly into canvas, show `Local save only`. Background sync resumes when connection returns.
   - Any document edit on the board—however small—increments the document version number.
2. **Room Active Detection:** Dynamic room presence tracking.
   - Active sessions $\ge 2$: Lazy collaboration activates (RTDB delta gossip).
   - Solo mode ($\le 1$ session): RTDB delta gossip remains dormant.
3. **Collaboration Mode Activation:** Clean state handoff when switching between solo and collaborative modes.
4. **RTDB Delta Gossip & Pure Synchronous Reconcile:**
   - Elements are gossiped as minimal delta patches over RTDB with author attribution (`lastModifiedBy: uid`).
   - Deterministic LWW + 30-bit `versionNonce` tie-breaking.
   - Canvas updates are applied **synchronously** (no asynchronous microtask races).
   - While collaboration is active (`isLazyCollabActive`), Firestore snapshots **never** overwrite the live canvas.
5. **Direct Delta Broadcast:** Local modifications are broadcast to peers over RTDB immediately.
6. **User-Scoped Undo/Redo Intercepting All CTAs:**
   - During collaboration mode, undo/redo **strictly** reverts only the acting user's own deltas (`lastModifiedBy === currentUser.uid`).
   - All undo/redo triggers are intercepted at the capture phase:
     - Keyboard: `Cmd+Z`, `Ctrl+Z`, `Cmd+Shift+Z`, `Ctrl+Shift+Z`, `Ctrl+Y`.
     - UI Buttons: `button[data-testid="undo-button"]`, `button[data-testid="redo-button"]`, `aria-label="Undo"`, `aria-label="Redo"`.
   - Reverting elements applies a forward version bump: `Math.max(local.version, prev.version) + 1` with a new nonce, immediately gossiping the undo to peers.
7. **Minimal IndexedDB Footprint:**
   - IndexedDB (RxDB) is purely an offline storage cache.
   - Never throw fatal `BOARD_REVISION_CONFLICT` errors to the user.
8. **Consolidation / Compaction Action:**
   - When active sessions drop to $\le 1$, or on self-healing board open if orphaned RTDB deltas exist, a 3-way delta-onto-base merge consolidates RTDB patches into Firestore and purges transient RTDB nodes.

---

## 2. Architectural Overview & State Ownership

```
                       ┌──────────────────────────────────────────────┐
                       │           Local Excalidraw Canvas            │
                       │   (DOM Canvas, 60fps render, User input)     │
                       └──────────────┬───────────────────────────────┘
                                      │
               Solo / Offline Mode    │    Active Collab Mode (>= 2 Users)
               ───────────────────    │    ───────────────────────────────
                                      ▼
     ┌────────────────────────────────┴────────────────────────────────┐
     │                                                                 │
     ▼                                                                 ▼
┌───────────────────────────────┐             ┌────────────────────────────────┐
│   IndexedDB & Firestore Doc   │             │   Firebase Realtime Database   │
│   • Version-checked on load   │             │   • 16ms delta gossip          │
│   • LWW + Nonce merge         │             │   • LWW + Nonce tie-breaking   │
│   • Offline-first fallback    │             │   • Pure synchronous reconcile │
│   • No revision conflict error│             │   • User-scoped Undo/Redo      │
└───────────────────────────────┘             └───────────────┬────────────────┘
                                                              │
                                       Room drops to <= 1     │ Or zero-member
                                       or sole user leaves    │ abrupt exit
                                                              ▼
                                              ┌────────────────────────────────┐
                                              │      Consolidation Engine      │
                                              │ • 3-way delta-to-base merge    │
                                              │ • Writes snapshot to Firestore │
                                              │ • Purges transient RTDB deltas │
                                              └────────────────────────────────┘
```

### Strict Ownership Boundaries

- **Active Collaboration (`isLazyCollabActive === true`):**
  - **RTDB is the single source of truth** for real-time mutations.
  - Incoming Firestore document snapshots are **prohibited** from overwriting live canvas elements.
  - Edits are published as lightweight delta patches tagged with `lastModifiedBy: currentUser.uid`.
- **Solo & Offline Mode (`isLazyCollabActive === false`):**
  - Firestore is the primary cloud persistent store.
  - IndexedDB acts as the local offline cache.
  - Autosaves debounce cleanly without throwing revision conflict modal errors.
- **Room Compaction:**
  - When sessions decrease from $\ge 2$ to $1$ ("Last Person Standing"), the remaining client merges the final in-memory scene to Firestore and clears `/boards/{boardId}/elements` in RTDB.
  - A fallback Cloud Function cleans up if all clients disconnect simultaneously.
  - Self-healing on open catches any uncompacted deltas left over by past ungraceful exits.

---

## 3. Work Streams & Implementation Breakdown

### Phase 1: Reconcile Engine & 3-Way Compactor (`apps/whiteboard/src/features/collaboration/reconcile.ts`)

1. **Comprehensive Property Comparator (`haveElementPropertiesChanged`):**
   - Check all 19 Excalidraw attributes to ensure no edit goes undetected:
     - Geometry: `x`, `y`, `width`, `height`, `angle`, `points`, `roundness`
     - Styling: `strokeColor`, `backgroundColor`, `fillStyle`, `strokeWidth`, `strokeStyle`, `roughness`, `opacity`
     - Typography: `text`, `fontSize`, `fontFamily`
     - Structure: `isDeleted`, `boundElements`, `groupIds`, `frameId`
   - Guarantees version bumping for text edits, arrow binding benders, opacity changes, and group structure modifications.
2. **Bidirectional Key Diff in `createDeltaPatch`:**
   - Detect attributes present in `previousElement` that were deleted in `currentElement`, explicitly emitting `patch[key] = null`.
3. **3-Way Delta Compactor (`mergeDeltasOntoBase`):**
   - Combines a Firestore base scene with transient RTDB delta patches:
     ```typescript
     export function mergeDeltasOntoBase(
       baseElements: readonly ExcalidrawElement[],
       deltas: Record<string, Partial<ExcalidrawElement>>,
     ): ExcalidrawElement[]
     ```
   - Resolves conflicts using LWW and `versionNonce`. Preserves complete shapes, text, styling, and bindings even when RTDB deltas are sparse patches.

---

### Phase 2: Board Load Version Resolution & Offline First (`apps/whiteboard/src/routes/board-editor.tsx`)

1. **Deterministic Document Version Resolution on Mount:**
   - Query both `localDoc` (`IndexedDB`) and `cloudDoc` (`Firestore boardShares/{boardId}`).
   - Extract `localMaxVersion = Math.max(...localElements.map(e => e.version))` and `cloudMaxVersion`.
   - **Case A: `cloudMaxVersion >= localMaxVersion`:**
     - Load cloud scene into Excalidraw.
     - Save cloud scene to local IndexedDB to bring cache up to date.
   - **Case B: `localMaxVersion > cloudMaxVersion` (Offline edits took place locally):**
     - If `navigator.onLine`:
       - Execute `reconcileElementsLWW(localElements, cloudElements)`.
       - Push reconciled scene to Firestore (`updateSharedBoard`).
       - Update IndexedDB cache.
       - Display status: `Synced`.
     - If `!navigator.onLine`:
       - Load local scene directly into Excalidraw.
       - Display status: `Local save only`.
       - Enqueue background push when `online` event fires.
2. **Self-Healing Compaction on Load:**
   - Before binding real-time listeners, check if `/boards/{boardId}/elements` in RTDB contains lingering deltas.
   - If deltas exist (e.g. from an abrupt browser crash in a previous session):
     - Execute `mergeDeltasOntoBase(cloudDoc.scene.elements, rtdbDeltas)`.
     - Save merged scene to Firestore.
     - Remove RTDB `/boards/{boardId}/elements`.
     - Proceed with clean consolidated state.

---

### Phase 3: All-CTA User-Scoped Undo & Redo (`apps/whiteboard/src/features/collaboration/use-collaboration.ts`)

1. **Local Action Attribution (`recordUserAction`):**
   - On canvas pointer-up / change, track elements modified by `currentUser.uid`.
   - Push previous states onto `userUndoStackRef`.
2. **User-Scoped Rollback (`performScopedUndo` / `performScopedRedo`):**
   - Revert **only** elements where `element.lastModifiedBy === currentUser.uid` or elements in the top action record.
   - Peer elements remain untouched.
   - Ensure forward versioning:
     ```typescript
     const nextVersion = Math.max(current.version, previousState.version) + 1
     const nextNonce = Math.floor(Math.random() * 2e9)
     ```
   - Update Excalidraw canvas and broadcast delta immediately to peers over RTDB.
3. **Capture-Phase Interception of All CTAs:**
   - Attach capture-phase event listeners to `window` and the Excalidraw container:
     - **Keyboard shortcuts:**
       - Undo: `(e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey`
       - Redo: `(e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))`
     - **Canvas UI buttons:**
       - Intercept `click` and `pointerdown` on `button[data-testid="undo-button"]`, `button[data-testid="redo-button"]`, `button[aria-label="Undo"]`, `button[aria-label="Redo"]`.
   - When `isLazyCollabActive === true`:
     - Call `e.preventDefault()`, `e.stopImmediatePropagation()`.
     - Trigger `performScopedUndo()` or `performScopedRedo()`.
   - When `isLazyCollabActive === false`:
     - Do not intercept; allow Excalidraw native canvas history to handle solo undo/redo.

---

### Phase 4: Room Teardown & Compaction Lifecycle

1. **"Last Person Standing" Client Flush:**
   - Observe active session count via RTDB presence.
   - When `activeSessions` transitions from $\ge 2$ down to $1$:
     - The sole remaining user merges the current canvas elements with any pending RTDB deltas.
     - Writes full scene to Firestore (`boardShares/{boardId}.scene`).
     - Purges transient RTDB deltas `/boards/{boardId}/elements`.
     - Collab mode transitions to solo mode (`isLazyCollabActive = false`).
2. **Backend Cloud Function Compactor (`functions/src/index.ts`):**
   - RTDB trigger on `/presence/{boardId}/{sessionId}` deletion.
   - If room count reaches 0, trigger a 30-second delayed task / grace timer.
   - If room remains at 0 users:
     - Run `mergeDeltasOntoBase` against Firestore base.
     - Write consolidated scene to Firestore.
     - Delete RTDB deltas `/boards/{boardId}/elements` and orphaned presence keys.

---

## 4. End-to-End Automated Test Matrix

An automated test suite (`tests/collab-resilience-matrix.test.mjs`) validates these requirements:

| Test ID    | Scenario                            | Verification Criteria                                                                                                                            |
| :--------- | :---------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| **TEST-1** | **Text & Arrow Undo**               | Edit text label in Tab 1, bend arrow in Tab 1, undo both. Tab 2 receives reverted text and restored arrow points without version stagnation.     |
| **TEST-2** | **UI Button CTA Undo**              | Click `button[data-testid="undo-button"]` in Tab 1. Only Tab 1 elements revert; Tab 2 elements remain untouched.                                 |
| **TEST-3** | **Offline Edit & Reconnect Merge**  | Disconnect network simulation in Tab 1, draw shape offline. Reconnect network: verify LWW + Nonce merge saves to Firestore with `Synced` status. |
| **TEST-4** | **Rapid Reload Resilience**         | Tab 2 reloads 3 times in rapid succession (`Cmd+R`). Zero elements lost; RTDB is not wiped during reload grace period.                           |
| **TEST-5** | **Last Person Standing Compaction** | Tab 2 closes. Tab 1 immediately flushes composite scene to Firestore and purges RTDB. Subsequent fresh load reads consolidated Firestore scene.  |
| **TEST-6** | **Simultaneous Exit Self-Healing**  | Both tabs close abruptly. Next load executes client-side 3-way merge of lingering RTDB deltas, updates Firestore, and purges RTDB.               |

---

## 5. Implementation Roadmap & Checklist

- [ ] **Phase 1: Reconcile Engine & Compactor**
  - [ ] Implement all 19 element properties comparison in `haveElementPropertiesChanged`.
  - [ ] Implement bidirectional key deletion diff in `createDeltaPatch`.
  - [ ] Implement `mergeDeltasOntoBase` in `reconcile.ts`.
  - [ ] Add unit tests for `mergeDeltasOntoBase` and comparator edge cases.
- [ ] **Phase 2: Board Load Version Resolution & Offline-First**
  - [ ] Update `board-editor.tsx` mount logic to compare `localMaxVersion` and `cloudMaxVersion`.
  - [ ] Implement self-healing compaction on open if RTDB contains uncompacted deltas.
  - [ ] Support offline loading with `Local save only` indicator and automatic reconnect sync.
  - [ ] Ensure Firestore `subscribeToSharedBoard` never overwrites live canvas when `isLazyCollabActiveRef.current === true`.
- [ ] **Phase 3: All-CTA User-Scoped Undo & Redo**
  - [ ] Wire capture-phase event listeners for keyboard shortcuts (`Cmd+Z`, `Cmd+Shift+Z`, `Ctrl+Y`).
  - [ ] Wire capture-phase event listeners for Excalidraw UI buttons (`data-testid="undo-button"`, `redo-button`).
  - [ ] Implement `performScopedUndo` and `performScopedRedo` targeting user-attributed deltas.
- [ ] **Phase 4: Room Teardown & Compaction Lifecycle**
  - [ ] Implement "Last Person Standing" compaction flush on transition from $\ge 2$ to $1$ user.
  - [ ] Implement Cloud Function safety net for zero-occupant rooms with 30s grace period.
- [ ] **Phase 5: Automated E2E Verification**
  - [ ] Implement `tests/collab-resilience-matrix.test.mjs`.
  - [ ] Run full test suite (`pnpm test:collab:ops`, `pnpm test:collab:undo`, `pnpm test:collab:matrix`).
