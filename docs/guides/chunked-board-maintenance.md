# Chunked board maintenance

## Why deleting a shape does not immediately shrink a board

Boards are persisted as immutable scene revisions that reference bounded Firestore chunks. Ordinary saves preserve chunk membership when possible and reuse unchanged chunks. A deleted shape remains as a full tombstone (`isDeleted: true`) so undo, stale-client reconciliation, and collaboration can still distinguish deletion from absence. Therefore deleting shapes does not necessarily reduce the current chunk count or stored bytes.

There are two separate maintenance operations:

| Operation            | Changes logical scene?                                                     | What it reduces                                                                                 |
| -------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Layout repack        | No                                                                         | Fragmented chunk count and serialized chunk bytes, when repacking crosses the savings threshold |
| Tombstone compaction | Removes full deleted-element payloads, retaining compact deletion metadata | Current revision payload bytes; chunk count may fall when the smaller scene is packed           |

Repacking cannot reclaim the bytes inside tombstones; tombstone compaction is a separate, collaboration-fenced operation. Both publish a new immutable revision, so earlier revisions and named board versions remain readable.

## Layout repacking

The owner-authorized `repackBoardScene` callable loads a pinned revision, deterministically packs the unchanged scene, and publishes only if the head and generation still match the pinned base. It requires savings of at least two chunks and at least 25% fewer chunks, enforces a per-board cooldown, reuses byte-identical immutable chunks, and records before/after chunk and byte counts. If the head changes while the repack is in progress, it aborts rather than replacing newer edits.

Repacking is a maintenance action, not an operation run after each delete or edit. The callable exists, but there is currently no user-facing repack button or automatic scheduler. Calling it on a well-packed board is a no-op. The five-chunk browser test creates a deliberately fragmented fixture, invokes the callable through the browser, and checks reduced chunk count and bytes, unchanged logical scene records, historical-version integrity, and a fresh cold load.

## Tombstone compaction and collaboration

When the abandoned collaboration room cleanup runs, it waits through a grace period, then closes RTDB admission under a token-owned fence and checks both presence and active-session registries. It checkpoints the acknowledged room deltas; only after the fence verifies no active session can join does it convert eligible full tombstones to compact ledger records. The fence reopens only if the worker still owns it. Stale session epochs cannot publish after reconnect.

The function flag `SCENE_TOMBSTONE_COMPACTION_ENABLED` defaults to `false`. Keep it disabled unless the deployment has passed its maintenance rollout gates. The tombstone Puppeteer E2E enables it only inside isolated emulators, draws and deletes through the UI, verifies undo while the editor session remains open, closes the collaborators, observes the real RTDB cleanup trigger, then verifies compacted state, preserved history, and rejection of stale collaboration replay.

Undo is scoped to the open board tab. Leaving or reloading ends that undo session. Compaction does not delete historical revisions or named versions.

## Verification

Run the focused suites from the repository root:

```sh
pnpm test:e2e:scenes:five-chunks
pnpm test:e2e:tombstone-compaction
pnpm test:scenes:backend
pnpm test:scene-maintenance:gc
```

The first suite verifies physical layout repacking and a five-chunk cold load. The second verifies the real browser/collaboration tombstone lifecycle under the enabled emulator-only flag. Backend tests exercise publication races, stale heads, access control, thresholds, cooldown, no-op behavior, ledger validation, and RTDB fencing. GC suites test quarantine and collection invariants separately; they do not imply that committed history is eligible for deletion in production.

See [ADR 007: Scene maintenance and safe garbage collection](../decisions/007-scene-maintenance-and-safe-garbage-collection.md) for the full state model, rollout gates, and failure/race test matrix.
