# Divergent offline collaboration E2E

The agreed boundaries are real editor actions, browser network traffic, Firebase state and historical previews. Routine regression runs use disposable demo emulators. An explicitly selected live run uses only `open-excalidraw-dev-2`, a local development frontend, a registered owner and isolated guest contexts. Production is rejected. Tests must not invoke the history worker, merge helper, or flush helpers during the scenario; only initial fixture setup may use public workspace/sharing APIs.

## Scenario and independent expectations

- Create/share a UTF-8-heavy board spanning at least five chunks. Open its owner and two independently authenticated public-link editors. Verify collaboration is actually active.
- Disconnect the owner from HTTP, Firestore and RTDB. Browser HTTP offline alone is insufficient because an established RTDB WebSocket can survive it.
- Owner performs separate real pointer moves, a keyboard deletion and a new drawing. Wait for each debounced durable capture. Verify cloud head and RTDB room stay unchanged; online peers must not see untransmitted changes.
- Both remaining editors continue in collaboration: competing move of the same shape, independent movement of another shape, independent deletion, and separate additions. Verify their canvases and committed cloud scene agree while the owner remains divergent.
- Restore connectivity without manually invoking upload or synchronization. All three editors and the canonical cloud scene must agree on the exact expected element set and tombstones. Same-shape resolution is independently checked against version/nonce values recorded before reconnect. Both sides' unrelated changes must survive.
- Every original owner capture must map through a stable server receipt to its exact immutable pre-merge snapshot. Previously published online versions must remain. No restore operation, generation advance or sharing-policy mutation is allowed.
- Read manifests/pages/chunks directly. Validate SHA256 payload bytes, bounds, unique IDs/records/orders, intact large UTF-8 payloads and unchanged chunk reuse. Compare actual canvas elements to those independently decoded records.
- Open actual history UI: uploaded capture IDs appear, previews read verified chunks and restore is enabled. Preview must issue no content writes or move the head.
- Fresh browser and owner reload must recover the same converged diagram and acknowledged history.

## Evidence and execution

Command: `node tests/run-regression-tests.mjs --test=board-history-divergence-ui.test.mjs`

The runner creates isolated Firebase services and Vite. Artifacts include phase-tagged per-peer requests/responses/failures, local outbox diagnostics, canonical head, stage expectations, and screenshots. A failed run is a regression finding, not permission to relax convergence or receipt assertions.

For deployed Firebase, first prepare a Puppeteer-owned Chrome with an authenticated dev owner and write its WebSocket endpoint to `.system_generated/live-history-browser.json`. Reusing the owner's existing dev app session is an authentication bootstrap only; no privileged fixture writes or synchronization calls substitute for application behavior. Then run:

```sh
GCLOUD_PROJECT=open-excalidraw-dev-2 E2E_FIREBASE_TARGET=development \
  E2E_ARTIFACT_DIR=.system_generated/history-divergence-live \
  node tests/board-history-divergence-ui.test.mjs
node tests/helpers/build-history-slideshow.mjs .system_generated/history-divergence-live
```

The live oracle reads deployed Firestore and RTDB through authenticated read-only REST using the developer's existing `gcloud` access. It caches immutable chunk/revision bytes only, never the mutable head. The test's application writes still use the normal owner/guest SDK credentials and deployed callables. Screenshot captions identify each peer and the actual assertions completed at that phase. The HTML slideshow embeds the captured PNGs and works without external assets. This is one finite deployed-cloud scenario, not a soak test or proof of all ADR flows.

Adjacent suites cover restore while offline, permission changes, notes/name CAS conflicts and lost receipts. This scenario specifically closes the missing ordinary offline divergence seam; those adjacent results must not be presented as proof of it.

## Slow reconnect and ambiguous acknowledgements

Run `E2E_DIVERGENCE_LOST_REPLY=true node tests/run-regression-tests.mjs --test=board-history-divergence-ui.test.mjs` for the same real three-editor scenario with 80ms HTTP latency and bounded throughput. CDP drops exactly one successful import response, only after an independent Firebase read confirms the original capture was durably accepted. Automatic recovery must issue a receipt query, publish the original receipt locally, drain the outbox and preserve the original version identity, acceptance time and thirty-day expiry. No explicit synchronization helper is called. Interception callback failures fail the test.

## Equality and byte integrity

Live diagram equality checks every persisted element field except transport-only `lastModifiedBy` (authenticated capture ownership is asserted through the server receipt). Excalidraw represents no bound elements as either `null` or `[]` when hydrating; those two empty representations are normalized. Geometry, styling, real bindings, element versions/nonces, deletion flags and custom data remain strict. Original offline historical captures are compared without either normalization. Identical current-base chunk payloads must retain their IDs; visually unchanged chunks can have different bytes after attribution changes.

The fixture uses 24 records with 20,000 Unicode globe characters each, spread across five scene chunks. This exposed a real RTDB WebSocket framing defect: independently UTF-8-encoded frames could split a surrogate pair and persist replacement characters. Canonical collaboration wire JSON now escapes non-ASCII code units; readers still use JSON.parse. The existing strict 256KiB RTDB element limit applies to the escaped wire representation. This test does not prove live transmission of elements exceeding that limit, which remains a separate oversized-element limitation.

The scenario has no images, speaker-note edits, rename conflicts, permission revocation or restore. Those have separate suites; success here is not a claim that every ADR case passes. Emulator results also do not constitute deployed-cloud soak testing.

## Verified results — 2026-10-12

| Check | Result | Evidence |
| --- | --- | --- |
| Ordinary offline owner/two online guests, full preview/cold/reload flow | PASS, runner84219 exit0 | `.system_generated/history-divergence-evidence/ordinary/` |
| Throttled reconnect and one lost server-accepted import response, full preview/cold/reload flow | PASS, final runner72193 exit0 | `.system_generated/history-divergence-evidence/lost-reply/` |
| Existing cloud history tuple/notes/name/restore/access regression | PASS as an individual suite in batch8310 | `.system_generated/regression/board-history-cloud-ui.test.mjs.log` |
| Existing exact five-chunk native edit/cold viewer/reuse regression | PASS; three immutable chunks reused | `.system_generated/regression/five-chunk-scene.test.mjs.log` |
| Collaboration framing edge cases | PASS, 17/17 cases | `.system_generated/regression/collab-unicode-wire-green.log` |
| Native history regression | PASS, 85 assertions | `.system_generated/regression/board-history-local-final.log` |
| Frontend typecheck, development build, syntax and whitespace | PASS | Build/scoped-check logs under `.system_generated/` |
| Scoped ESLint | Zero errors; one existing unused-parameter warning | `.system_generated/history-divergence-lint-final.log` |

The final fault run retained four original offline captures, ended with all four browser outboxes empty and no page/interception errors, and independently verified seven final scene chunks from the five-chunk baseline. The additional chunks reflect changed record packing/content, not a requirement that every version have exactly five chunks. The separate controlled chunk regression supplies an explicit unchanged-chunk reuse oracle.

Earlier failed runs remain diagnostic evidence: hollow-shape pointer selection, true Unicode corruption, transport-attribution equality, empty-binding hydration, interception timing, hidden staging metadata, CDP undefined-field serialization and premature outbox readiness. The final readiness predicate requires a committed local board and every original capture's published receipt; an empty outbox alone during reinitialization cannot signal completion. Runtime assertions and callback errors are never swallowed.

Development hosting was updated at `https://open-excalidraw-dev-2.web.app`. Hosted index and the editor bundle containing the Unicode serializer byte-match the verified build. This was hosting-only; production, functions and security rules were not redeployed. No user board was edited or restored, and no commit was made.

Convenience commands: `pnpm test:e2e:history:divergence` and `pnpm test:e2e:history:divergence:lost-reply`. Batch8310 as a whole exited1 because the earlier divergence assertion failed; its independently passing adjacent suites are reported separately, not as a passing batch.

### 2026-10-12 live run attempt

The deployed `open-excalidraw-dev-2` run reached the real offline editing phase and captured seven screenshots. The cloud history head stayed unchanged, the owner's four divergent edits were captured locally, and the two online guests remained on the baseline scene. The run stopped at an overstrict RTDB equality assertion: collaboration actor/timestamp metadata can change while guests remain connected. Independent post-failure REST inspection showed all 24 canonical RTDB scene payloads and version/nonces still at baseline (`seed-0` x=0/version 2, `seed-1` x=70/version 2), while the owner's offline canvas had seed-0 at x=90 and seed-1 tombstoned. The assertion now compares exact scene payload bytes, IDs, element versions/nonces, generation and restore fence while excluding only actor/timestamp envelope metadata. The adjusted guard was exercised in the final live rerun below; this attempt itself remains a failure, not a passing E2E. Actual screenshots, response/failure traces and report are under `.system_generated/history-divergence-live/attempt-1`; `slideshow.html` presents those captures with the incomplete/failed status.

### 2026-10-12 final live rerun

The metadata-aware RTDB leak guard passed, all four owner offline captures were recorded, and both public-link guests completed their edits. Final report-time outbox diagnostics showed 4 owner, 3 guest-A, and 1 guest-B entries still pending; later drain is unverified. The live runner's 360-second idle allowance let the scenario reach its strict 180-second canvas-to-canonical convergence assertion. Expected IDs and cloud IDs both contained 25 visible elements, and geometry/tombstones agreed; the two guest canvases differed from the independently decoded Firestore snapshot only on new rectangle `mt6UXuKRLjCjmfrsYcgHy`: canvas version 9, nonce `241402669`, updated `1791792216719`; canonical chunk version 9, nonce `486027608`, updated `1791792231586`. This nonce mismatch remains a real consistency failure and is not normalized away. The reconnect, owner receipt reconciliation, history preview/restore, cold reader and reload steps did not run. The final report records 233 callable requests, 230 readable responses (225 HTTP 200 and five HTTP 409), 67 failed browser requests (including expected Firestore channel aborts), and zero page errors. Ten actual browser screenshots, including post-timeout owner and guest views, are in `.system_generated/history-divergence-live/`; `slideshow.html` is explicitly marked failed. No pass is claimed.
