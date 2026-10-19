# Board history E2E actions and evidence — 2026-10-12

## Outcome and scope

Actual Puppeteer browser actions against the implemented frontend and disposable Firebase emulators verified all eligible versions in the timeline fixture, isolated historical preview, restore branching, offline uploads and collaboration failure recovery. This is a finite fixture result, not proof that all 64 ADR scenarios are complete. The [case-by-case audit](board-history-e2e-coverage-2026-10-12.md) records remaining gaps.

The real development `boardHistory` endpoint returned HTTP 404 during this run. History is not deployed there; these results do not establish working cloud history in the live development app. No real user board was restored or modified, and no deployment was performed.

## Actions and assertions

| Flow | Observed evidence |
| --- | --- |
| Every-save timeline | Six representative saves use real canvas pointer/tool controls, rename and speaker-notes forms. Another 55 names are changed through real authenticated accepted callables to exercise pagination; they are not represented as UI actions. Together with baseline/import fixtures, all 65 eligible records match the gateway and every rendered row ID exactly, in order, without duplicates, across two pages. Group collapse/expand retains the rows. |
| Historical previews | Four selections verify the selected name, protected notes, fixed manifest/chunk identities and reconstructed scene. Preview creates no content/history mutations and preserves the live head and canvas. Current Restore is disabled. |
| Restore/new universe | Restoring the earlier target preserves its complete tuple, hides all 61 later/side-lineage entries and leaves five eligible ancestors/restore entries. A real pointer edit publishes on the new branch. Reload retains the exact six eligible IDs and does not resurrect the abandoned future. |
| Offline receipts | Three immutable local saves map exactly to accepted cloud receipt/version identities and rendered rows. Canonical alias acknowledgement creates no duplicate local-mutation version. Rename conflict resolution, lost reply/reload deduplication and failed-restore fence retry pass. Successful restore deletes pending old-generation captures; abandoned imported versions are absent and their historical manifests denied. |
| Collaborative restore | Owner and public guest editor observe blocking restore progress and the restored name/scene/notes; sharing stays current. Viewer remains readonly, has no history control, and requests no protected historical notes/history. Old-generation authenticated RTDB writes are denied. |
| Chaos | Held stale writes, slow replacement hydration, an offline editor missing restore, a lost successful restore reply, and pre-publication corruption are exercised. Success discards pending old-world content/history. Failure preserves drafts/history, releases both barriers with a new fence, and allows editing/retry. Lost successful reply recovers the original operation without a second restore. |
| Images/rules/chunks/layout | Historical image preview and cold restored decode pass. Actual unprivileged rules deny protected raw paths, unauthorized contexts and asset bypasses. The existing exact five-chunk regression passes. Info remains in the header and History above Help/FAQ in the sidebar. |

## Execution and test repairs

The initial nine-suite batch passed six suites; two new assertions could not run because their fixtures were malformed (missing Excalidraw frame `children`, and Vite ReactDOM default-export interop). Chaos completed its assertions but timed out during test teardown with an open Firestore connection. These are recorded failures, not silently counted as passes. Test-only corrections fixed both fixtures and explicitly terminate Firestore; no production source change was needed. The targeted three-suite rerun exited 0 with no timeouts: timeline 45.3 s, outbox 7.7 s, chaos 44.8 s.

**Final frozen nine-suite batch, session 53978: exit 0; nine suite exits 0; zero timeouts.** Timeline 47.0 s, local UI 1.5 s, cloud UI 12.5 s, outbox 7.9 s, chaos 47.0 s, unprivileged rules 2.9 s, images 5.0 s, rail controls 3.4 s and exact five-chunk regression 7.4 s. Saved result: `.system_generated/history-e2e-2026-10-12-final-results.json`. Targeted ESLint and `git diff --check` also passed. Default emulator ports were released after successful shutdown.

Fresh supporting runs passed: isolated backend suite (complete gateway reconstruction of all three eligible fixture versions, corruption/membership/bounds checks, restores/fences/retention/resource cleanup), native IndexedDB history (64 assertions), history grouping/pagination, and scene/import codec suites.

Artifacts are ignored generated files under `.system_generated/`: initial/rerun/final runner logs and saved results; per-suite network traces and screenshots under `regression/<suite>.artifacts/`. The timeline JSON distinguishes real UI captures from accepted callable pagination fixtures, and contains exact version-ID sets, preview manifest/tuple digests and transport identities. Tokens are omitted from its network summary.

## Remaining validation

See the audit for every ADR case and its precise scope. Important outstanding work includes exact debounce-boundary races; all archive/copy/move/account-switch/template/MCP histories through the actual UI; prolonged network throttling and every collaborator dropout permutation; full keyboard/accessibility flows; and a historical five-chunk before/after fixture that proves exact one-chunk reuse. The current five-chunk regression and codec reuse tests do not substitute for that last historical fixture.

Production-only work includes coordinated migration/deployment, deployed strict rules/indexes, actual scheduled cleanup, cleanup throughput/alerts and prolonged real-service soak. A native injected quota error tests atomic failure handling, not physical disk exhaustion. No claim that all ADR features or release requirements are fully E2E proven is made.
