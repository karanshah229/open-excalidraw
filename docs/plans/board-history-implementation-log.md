# Board history implementation log

## Objective and controlling decisions

Implement ADR 007, including automatic complete-content history, offline outbox, 30-day retention, editor-only reads, and coordinated destructive restore into a new universe. The ADR and audit resolutions control behavior. Runtime feature is not complete until integrated integrity/authorization tests pass. No deployment is authorized by this implementation request.

Workspace: `/Users/karan/.codex/worktrees/190a/agentic-whiteboard`.
Desired `.worktrees/` relocation: app tooling has no relocation operation for the attached checkout; keep current path to preserve the running task. Repository already ignores `/.worktrees/`.

## Agent registry

Active handles (2026-10-11):

- Backend: `/root/history_backend`
- Local persistence: `/root/history_local`
- Frontend: `/root/history_ui`

All agents share the existing checkout; file ownership is explicit to avoid concurrent mutation. Do not terminate agents due solely to account usage exhaustion. On reset, inspect live handles and resume these agents when available; if the platform invalidates a handle, recover from its checkpoint and record a replacement explicitly. Platform lifetime cannot be guaranteed by this file.

## Ownership and integration sequence

1. Orchestrator establishes shared interfaces and owns integration, transport/rule fencing, regression verification and this log.
2. Backend agent: server content/history publication, imports, restore operations, protected notes and cleanup; no frontend/local edits.
3. Local agent: atomic IndexedDB content/history/outbox, local-only restore/pruning and storage integration; no server/editor edits.
4. UI agent: history client/panel/preview and editor/notes integration; no backend/storage edits.
5. Shared files and cross-layer contracts require orchestrator coordination. Agents must report limitations honestly and not weaken the ADR for speed.

## Checkpoints

### 2026-10-11 — implementation start

- Reviewed repository layout, current chunk persistence, package boundaries and test infrastructure.
- Existing documentation edits preserved; no runtime implementation had been made at start.
- Shared contract design and bounded parallel assignments next.
- Current account allowance at last user-requested check: 83% five-hour / 97% weekly remaining (account-wide, not a promise for this run).

### 2026-10-11 — first contracts agreed

- Backend callable names: `boardHistory`, `updateBoardContent`, `restoreBoardVersion`, history-only import alongside staged scene candidates. Backend owns the shared plain contract types.
- Local authoritative layout: native IndexedDB current/history/chunks/outbox in one transaction; existing RxDB becomes repairable projection. UI and sync must consume authoritative content.
- New live paths: `boards/{boardId}/generations/{generation}/elements`, `presence/{boardId}/generations/{generation}/{sessionId}`. Server restore barrier stays at board root. Existing board-scoped active-session lobby remains peer discovery, not history.
- Frontend owns shared editor gate, complete-generation hydration, isolated preview, accessible UI. Orchestrator owns scene gateway/client sync, collab transport/rules and integration.
- Feature capability flag gates protocol cutover; existing-client rollout behavior must remain explicit.

### 2026-10-11 — first implementation checkpoint

- Local agent ran real Chrome/native IndexedDB integrity tests successfully (`tests/board-history-local.test.mjs`), including injected transaction quota failure, concurrent saves, local branch restore, identity isolation and separate history/head ACKs.
- Backend complete-content publication, protected-note snapshots, gateway, name CAS, imports and fenced restore implemented; integration review is ongoing. Protocol migration and safe resource cleanup added; asset sweeping and full emulator verification still in progress.
- Frontend isolated preview/dialog and editor lock/hydration implemented; local notes and guest captures, outbox pairing, failure retries and Puppeteer coverage still being completed.
- Orchestrator added generation rooms, local mutation gates, staging/raw-history rules, asset-context checks, function exports and generation-room compaction.
- Dependencies installed with frozen lockfile; backend and frontend type checks passed at this checkpoint. Functions runtime requests Node22; host is Node24 (verification must distinguish this environment from deployed runtime).
- Started existing exact-five-chunk regression suite to detect persistence regressions.
- Usage snapshot: 49% five-hour / 92% weekly remaining. Agents remain registered; no reset redeemed.
- Next integration ownership: local agent also owns workspace-api/outbox cloud delivery; frontend agent owns genuine browser flows; backend agent owns isolated backend emulator tests and remaining safe cleanup.

### 2026-10-11 — chunk regression and security review

- Existing exact-five-chunk real emulator/Puppeteer suite PASSED with the new gateway/protocol; durable chunk digests and cold rendering remain correct.
- Backend and frontend type checks passed; no deployment performed.
- Security review required removal of readable legacy embedded scenes; backend now archives server-only and removes them during migration.
- Identified additional migration unlock crash window and cleanup lease expiry/delete race; backend agent is resolving these rather than treating happy-path success as completion.
- Local agent continues real outbox delivery and canonical/local receipt pairing. Frontend agent is running history browser flows on default disposable regression ports; backend uses isolated test ports.

### 2026-10-11 — outbox and asset integration

- Main wired durable image upload reservations and object-generation completion to the asset gateway. Backend owns resource validation/reverse references/cleanup. Reviewed a missing-object-generation deletion hazard; backend is fixing it conservatively.
- Scene publication now returns its canonical version ID to clients; generation-aware presence test injection carries the required fencing fields.
- Added package scripts `test:history:local`, `test:history:model`, `test:history:backend`, and `test:e2e:history`.
- Scene codec/import tests, history grouping/pagination tests and all 17 existing collaboration model tests PASSED. These model tests do not prove real generation-room authorization; cloud Puppeteer coverage is still running.
- Latest frontend/backend type checks PASSED. Targeted main-owned-file lint has no errors (one existing unused argument warning).
- Backend emulator assertions passed previously; additional import receipt mapping, asset GC and recovery cases still need final rerun. UI local flow passed its substantive restore assertions but required a Puppeteer undo shortcut correction; full rerun and cloud peer flow remain pending.
- Five-hour usage was 69% consumed at this checkpoint; weekly 11%. All three agent handles remain active; no reset redeemed. Implementation is still in progress, with outbox receipt deduplication and genuine cloud browser verification the immediate priorities.

### 2026-10-11 — near-limit continuation checkpoint (07:45 UTC approximate)

- Usage now 91% five-hour / 14% weekly consumed. User will reset usage when exhausted; no reset credit redeemed. Preserve `/root/history_backend`, `/root/history_local`, `/root/history_ui`; all were running at last inspection. Do not interrupt/terminate for budget.
- Local Puppeteer UI suite PASSED: full scene/name/notes preview, zero preview mutation calls, restore, hidden descendants, disabled current restore, cold reload and undo. Cloud owner/guest browser suite is rerunning after deduplicated-note test oracle correction; actual RTDB presence/delta assertions are requested.
- Backend reports compile PASS after expanded fixes: stable capture receipt lookup/canonical mapping, stable note mutation receipts, durable `failed-unlock-pending`, lease-owned and conditional transport unlock, recovery ordered by expired lease, compact branch ceiling metadata and bounded deletion repair journals. Expanded backend emulator rerun pending.
- Asset cleanup deliberately quarantines interrupted uploads with no recorded object generation rather than risk an unconditional object deletion. This is a conservative storage leak to resolve with safe reconciliation, not a reason to weaken deletion fencing.
- Local agent is completing outbox receipt mapping and same-generation failed-restore fence reauthorization. Original name/note CAS bases must remain preserved; successful generation changes discard old pending edits/history. Real cloud outbox/offline/race verification is still pending.
- Main added recovery composite index (`restoreOperations.state`, `leaseUntil`) and disabled `noteChunks.text` indexing. Frontend, functions, storage type checks PASSED at prior checkpoint; repeat after all final agent edits. Main-owned files are being formatted.
- Remaining before feature can be considered complete: receive agent results; inspect latest cross-layer contracts; real cloud outbox/partition/dirty-peer tests; production build and targeted lint; verify migration/cleanup/restore crash tests and image retention; update ADR implementation details and any limitations. No deployment or commit performed.
- Resume instructions: inspect live agents and send follow-up to these same handles, poll any running test sessions via the agent, review this log and `git status`, then continue integration. Never infer PASS from generated network artifacts alone. Worktree relocation remains deferred because attached app-managed checkout has no relocation API.

### 2026-10-11 — 95% usage checkpoint

- Full `pnpm build` PASSED; output saved in `.system_generated/board-history-build.log`. Bundle reported ineffective lazy import for history dialog because progress component shares its module; UI agent is splitting that component.
- Targeted new-module lint found one backend `no-useless-assignment` error and two unused-variable warnings; backend agent notified. Functions/storage/frontend type checks and `git diff --check` had passed before the last recovery changes.
- Expanded backend test exposed RTDB transaction callbacks initially seeing a null cache; backend now warms/holds a value subscription during conditional control updates. Rerun running in backend session `93876` at this checkpoint; migration stale-worker control mutation is also being fenced.
- Cloud browser test has passed real notes and canonical rename checkpoints. Its second-note selector required reopening the notes panel after rename; final cloud rerun pending. It now includes real generation presence/delta checks.
- Local cloud outbox code is integrated but no real cloud outbox browser PASS yet. Agent is fixing two discovered gaps: expired/unavailable intermediate imports must not prevent current-head delivery; retry pending historical captures independently of board sync status. Same-generation failed-restore fence refresh resolves receipts and restages with stable capture identity, retaining original CAS bases.
- Added collection-group expiry indexes for cleanup metadata and disabled protected note chunk payload indexing. Safe interrupted-image-upload quarantine remains a documented retention limitation.

### 2026-10-11 — usage reset and same-agent resumption

- User confirmed a usage reset. All three retained handles were present in errored rate-limit state and resumed with `followup_task`; no replacement agents created.
- Latest main frontend/functions/storage checks and `git diff --check` PASSED (session39634).
- Backend reports expanded emulator suite PASSED with exit0 (session16241): canonical capture aliases, receipt lookup, old note ACK retry, aged chunk GC, imported ancestry, empty notes restore, competing restores, migration/published-worker recovery, viewer permissions and stale fences. Migration monotonic room controls and lint fixes are now complete; deeper failure injection and interrupted-image reconciliation next.
- Cloud Puppeteer suite PASSED actual owner/public-guest fenced presence, pointer drawing/delta convergence, both restoration modals, complete restored name/notes, unchanged sharing, exactly one operation, and denied old-generation write. Local UI suite also PASSED. Backend/UI test artifacts live under `.system_generated/regression`; fixture logs are not production activity.
- Local agent fixed expired intermediate import blocking and history-only retries independent of board status; native browser assertions and type checks passed. Real cloud outbox verification and note-conflict intent retirement remain next.
- Ownership remains unchanged. Backend now owns ADR implementation appendix; main avoids concurrent ADR edits. UI and local agents coordinate default emulator ports; backend uses isolated ports.

### 2026-10-11 — resumed verification

- Full workspace `pnpm check` PASSED. Full lint found one generated-code unnecessary catch; backend notified to fix source and rebuild. No generated file is manually patched.
- Existing board-loading and slide model/preview tests PASSED. Main added `tests/board-history-rules.test.mjs` for authenticated raw Firestore/Storage denial, staging ownership, restore/failed fences, actor-bound contexts and viewer current-only access. UI agent will run it with chaos coverage after the local outbox run releases default ports.
- `test:e2e:history` now selects all five browser suites via runner `--history`: local UI, cloud UI, outbox, chaos and rules. Model/native-store checks remain separate.
- UI agent fixed late note capture across restore, added held-dirty-peer, offline missed-restore and lost-response scenarios; execution pending. Local agent is finishing conflict intent retirement and full cloud outbox testing. Backend is adding storage lifecycle and deeper recovery failures, plus closed RTDB generation cleanup.
- Review also identified local restore copying old operational metadata and list pagination scanning abandoned descendants; respective agents are addressing those cases. Keep current owner/project metadata when replacing only name/scene/notes.

### 2026-10-11 — failure and storage coverage

- Expanded backend failure/Storage suite PASSED (session87950): image upload reservation/completion, current/context-pinned protection, expired abandoned image GC, safe interrupted-upload object-generation reconciliation, pre-publication failure rollback, failed-unlock crash recovery and post-publication access revocation completion. Backend test script now includes the isolated Storage emulator.
- Backend now prunes closed RTDB generation rooms at successful unlock and via bounded cleanup; active-session lobby remains intact. Migration/recovery fencing and source/generated-code lint fixes are complete. Requested read-context compound indexes added.
- Chaos browser held-dirty-peer, stale delayed writes, blocked keyboard mutations and slow hydration assertions PASSED. Offline scene/notes editing across missed restore and slow reconnect PASSED. Lost successful reply scenario is rerunning after correcting its POST/preflight interception fixture.
- Real-auth rules suite passed raw payload denials, staging ownership/locks/fence and viewer/current gateway assertions. Foreign context correctly returned non-disclosing FAILED_PRECONDITION; test incorrectly expected PERMISSION_DENIED and is corrected. Storage assertions still require final full rerun.
- Backend is improving eligible history pagination so thousands of abandoned saves do not require empty Load More pages; retain global server-acceptance order. Core version/restore behavior remains unchanged.

### 2026-10-11 — all browser flows passed individually

- Cloud outbox Puppeteer suite PASSED real offline three-save imports/current publication, dropped successful import reply plus reload deduplication/original expiry, failed-restore fence refresh with retained drafts, expired intermediate capture not blocking current publication, and successful-restore old-generation pending discard.
- Chaos and real-auth rules suites PASSED completely, including exactly one restore operation after lost successful response and Storage bypass denial.
- Historical image browser suite PASSED (session3116): actual upload and locator-only scene, proper tombstone deletion, fixed actor context serving old bytes after ordinary head change, readonly preview without mutation calls, restoration/cold reload and browser image decoding. Initial empty-array removal fixture was corrected to the app's normal LWW tombstone contract; no implementation workaround was added.
- All six history browser suites have passing evidence across separate runs. Run the consolidated `pnpm test:e2e:history` after final pagination/conflict changes to establish one coherent final result.
- Local native suite now PASSED 55 assertions, including immutable Use Remote capture, preserved metadata on restore and conflict intent handling. Old captures remain historically recoverable; only pending head intent is retired.
- Remaining final work: efficient eligible-prefix pagination and its indexes/tests; explicit rename conflict retry review; final source formatting/build/typecheck/lint, one consolidated browser batch, and ADR appendix. No deployment or commit performed.

### 2026-10-11 — resumed final integration checkpoint

- All three original agent handles retained. Backend/local work complete; UI agent is adding a real browser pre-publication restore failure case before releasing default emulator ports.
- Final full workspace type check, production build and lint PASSED; lint reports seven warnings and zero errors. Final isolated backend suite PASSED after content-receipt cleanup and viewer note-manifest restrictions. Native IndexedDB suite PASSED 55 assertions.
- Added the missing legacyArchive expiry collection-group index alongside contentReceipts so scheduled metadata cleanup has production query indexes.
- Next: consolidated six-suite history browser run, five-chunk regression, final documentation checkpoint. No deployment or commit. Current quota snapshot: 60% five-hour used, 25% weekly used; no reset redeemed by agent.

### 2026-10-11 — coherent browser run identified recovery and fixture fixes

- First consolidated run55574: local/cloud/outbox/rules PASS; chaos failed a CDP interception teardown race; image test waited for modal close without acknowledging a legitimate dirty confirmation (zero restore calls, no page errors). Neither failure is marked PASS.
- UI review found an actual same-generation failed-restore bug: SceneGenerationError could permanently set readonly after a newer fence. Recovery now verifies the authoritative server head; only verified unlocked same-generation state clears conflict/readonly and refreshes queues, retaining drafts. Offline/read failures preserve the blocking gate.
- UI agent is fixing explicit fixture teardown/drain and image confirmation. Final coherent rerun required. Added concrete migration maintenance/rollback guidance to ADR; backend audited query indexes and rollout risks.

### 2026-10-11 — seven-suite integrated result and outstanding failure

- Integrated batch6463: local history, cloud restore, offline outbox, unprivileged rules, historical images and existing five-chunk regression PASSED. Chaos first three scenarios PASSED; new actual pre-publication failure scenario still fails the initiating pointer-edit oracle despite verified unlocked server state and viewMode=false. This is unresolved; no final completion claimed.
- UI agent added gate/pointer/active-tool diagnostics and screenshot; isolated failure case next. Local agent reviewing native/worker gating without edits.
- Permission review fixed viewer restore hydration: preserve viewer readonly role and omit protected historical notes. Added real viewer-across-restore browser coverage; execution pending. Production build PASS after permission change; final typecheck/lint rerun pending.
- Agent handles unchanged; quota73% five-hour used/27% weekly used. No agent terminated, reset redeemed, deployment or commit.

### 2026-10-11 — failed-restore diagnosis resolved

- Isolated failure-only browser run26167 PASSED: same generation/new fence, both server locks cleared, all unsynced historical captures and scene/notes retained, actual foreground toolbar + pointer creates an element, held old-fence replies followed by preserved-note publication. Earlier drawing failure was keyboard shortcut focus across tabs/modal teardown; diagnostic gates and canvas hit targets were already correct.
- Production recovery fixes remain: authoritative same-generation conflict reset; viewers remain readonly and hydration omits protected notes; policy revocation/downgrade updates role before restoration content guard.
- Final full build/typecheck/lint and diffcheck PASSED after those production changes (lint seven warnings, zero errors). One final seven-suite coherent batch pending, including real viewer-across-restore assertions and all four chaos cases.

### 2026-10-11 — final integrated verification PASS

- Final coherent disposable-emulator/Puppeteer batch83758 exited0. All seven suites passed without timeouts: local history, cloud owner/public editor plus viewer-across-restore, offline outbox, all four chaos scenarios, real unprivileged rules, historical images, and existing exact five-chunk regression.
- Final full workspace build, typecheck and lint PASS; seven lint warnings, zero errors. Isolated backend PASS; native IndexedDB PASS55; history grouping/pagination model PASS; existing collaboration model and scene codec/import checks PASS. `git diff --check` PASS.
- Implemented automatic immutable complete-tuple history, chunk reuse, local authoritative capture/outbox, fixed previews, fenced branching restore/recovery, editor/public-guest permissions, generation-aware collaboration, protected notes/images, bounded pagination and 30-day scheduled/local cleanup. Sharing/identity/project metadata stay current on restore.
- No known failing required implementation test remains. Not deployed or committed. ADR explicitly separates implemented behavior from remaining rollout work: staging/deployed rules/scheduler validation, coordinated maintenance release or future migration gate, prolonged chaos/soak matrix, cleanup throughput/metrics and exceptional absent/overwritten asset quarantine metadata repair.
- Original subagent handles remain available: /root/history_backend, /root/history_local, /root/history_ui. No replacement or termination; resume these handles for follow-up. Checkpoint and source remain in the attached managed checkout; relocation to repo .worktrees was deferred because the app exposes no safe attachment-preserving relocation operation.

### 2026-10-12 — new-board sync bug and sidebar controls

- User reported a new board showing Sync failed and requested History/Info above FAQ in right sidebar, with only an info icon (status inside popover).
- Live browser reproduces Cloud sync paused on localhost5173. Read-only endpoint probe: existing development ensureBoardScene responds; boardHistory/importBoardVersion/updateBoardContent/restoreBoardVersion all404. Development backend has not received the history implementation. Separate older tombstoned-board retries show permission-denied; not conflated with the new board.
- Retained local/UI agent handles resumed. Local agent adding protocol0 ordinary-sync compatibility while retaining immutable capture obligations for later history migration; UI agent moved controls to History→Info→Help bottom rail and removed header pills.
- Live CUA verification now shows All changes saved on the previously failing board; icon order and status/detail popover verified. Cloud history gated on confirmed protocol1 head; legacy backend shows disabled history requiring server update.
- Regression verification underway against actual legacy function/rule fixtures and current history backend. No cloud deployment or credentials reset performed.

- Latest user steering: Info icon returns to header; only History remains sidebar above Help/FAQ. Icon stays icon-only and status stays inside its popover. Live CUA confirms final placement.
- Actual legacy HEAD functions/rules regression passed basic new-board saves, rename and notes with zero history API calls; native suite now60 assertions. Review added strict protocol1 fail-closed and stale-generation protection, retained-notes hydration; extended safety run pending.

### 2026-10-12 — sync compatibility and final control placement PASS

- Final expanded old-backend/rail batch54068 exited0. Legacy fixtures pinned to commit4cd058ecf6dff522d5c7ba8aa8698d470e27d20a so committing the feature cannot silently change the compatibility fixture.
- Actual old functions/rules prove new-board scene/name/notes sync with zero history API calls and no fabricated capture receipts; queued captures rebind after migration despite previously acknowledged legacy scene revision. Stale generation writes are rejected; fresh stored protocol1 missing version fails closed even if an older callable omits protocol fields.
- Legacy cold hydration preserves known notes. Dirty generation advancement preserves scene, notes and all queued history in conflict; clean advancement keeps historical captures. Native IndexedDB suite now64 assertions PASS.
- Final layout proof: header Info only (status/details in popover), sidebar History→FAQ/Help; viewers have header Info and no history action. Popover bounds and Enter/Escape return-focus PASS. Screenshot proof under .system_generated/regression/board-rail-ui.test.mjs.artifacts/board-rail-owner-info.png.
- Current history backend local/cloud restore suites PASS (87731). Focused final placement suite PASS (80603); final pinned legacy+rail suite PASS (54068). Full workspace build/typecheck/lint PASS, seven warnings/zero errors; diffcheck PASS. Default emulator ports released.
- Live user board verified again after final source: All changes saved / Synced to cloud and this device. Cloud history remains disabled until history functions are deployed. No deployment or commit. Original agents retained.
- Re-run compatibility with pnpm test:e2e:history:legacy; layout with pnpm test:e2e:board-info.

### 2026-10-12 — actual actions and exact history E2E validation PASS

- Retained all three agents and delegated bounded timeline assertions, offline receipt assertions and the 64-case ADR coverage audit. Main owned emulator lifecycle, final verification and checkpoints. No real board changes, deployment or commit.
- New timeline suite compares every eligible gateway/persisted version to every grouped/paginated UI row. Six actual pointer/name/note saves are distinguished from 55 accepted callable rename mutations for pagination. All65 eligible IDs appear exactly once across2 pages; four selected previews verify historical name/notes/chunk bytes without live writes. Restore hides61 later/side-branch entries; a new pointer save and reload retain exactly6 eligible entries.
- Outbox assertions prove all three local capture receipts map to cloud entries/UI rows, canonical alias does not duplicate an entry, and restore discards unsynced old-world captures while denying abandoned history reads. Backend suite adds complete reconstruction of every eligible fixture through manifest/pages/chunks/notes and malformed hash denial.
- Initial batch recorded two new fixture failures (frame.children and ReactDOM interop) and a chaos teardown timeout after all assertions. Test-only fixes plus explicit Firestore termination resolved these; targeted rerun83312 passed. Final frozen nine-suite batch53978 exited0: timeline, local/cloud UI, outbox, chaos, rules, images, rail controls and exact five-chunk regression all exited0; no timeouts. Native64, model, backend and scene/import tests passed; targeted ESLint/diffcheck passed.
- Live development boardHistory still404: feature unavailable there until backend deployment. Finite emulator success does not prove all64 ADR cases. See docs/plans/board-history-e2e-report-2026-10-12.md and coverage audit for precise evidence/gaps, including debounce boundaries, full lifecycle flows, longer chaos, historical exact chunk reuse and deployed scheduler/soak. Final results/log under .system_generated/history-e2e-2026-10-12-final*. Default emulator ports released; original agent handles retained.

### 2026-10-12 — authorized development deployment in progress

- User explicitly authorized deploy to dev env. Explicit project open-excalidraw-dev-2 only. Actual target board was protocol0/G1/currentVersionId absent/zero cloud versions before rollout. Production untouched.
- Added server-only system/boardHistoryRollout migrationEnabled gate to ensureScene and migration transaction, so partial installation cannot initiate protocol1. Already-started migration/protocol1 recovery bypasses gate. Emulator backend full suite including closed gate/no partial head and migrated current access PASS; function build and targeted lint/diffcheck PASS.
- Closed dev gate, deployed20 named relevant functions plus six composite indexes (successful), preserving unrelated deployed functions. Refreshed70 existing board/project access policy mirrors with ETag/version guards. Development build and Firestore/RTDB/Storage rules + hosting deployment successful. API now401 for unauthenticated requests rather than404. Scheduler recovery everyminute and cleanup every60minutes ENABLED.
- Still waiting for six composite indexes READY before reopening migration. Scripts/artifacts .system_generated/dev-history-*; helper dev-history-rest.mjs accepts inspect/close/open/mirror with explicit GCLOUD_PROJECT=open-excalidraw-dev-2. SDK ADC is expired, so helper uses existing authenticated gcloud OAuth token internally without logging credentials. IAM signJwt not permitted: no role changes or impersonation bypass attempted; real verification will use disposable dev test identity/board. Original three agent handles retained.

### 2026-10-12 — development deployment and real backend smoke PASS

- Both explicit dev deployments exited0. All6 indexes READY; migration gate reopened. New callables ACTIVE, scheduled recovery/cleanup ENABLED. User board nowprotocol1/G1/one baseline cloud version/no barrier. User can refresh to renegotiate history and upload retained local captures. Production untouched.
- Actual dev Firebase + Puppeteer guest-editor smoke9914 exited0: one baseline + two toolbar/pointer shape saves = three cloud versions; native outbox drained and exact UI rowIDs equal deployed gateway IDs; page errors empty. Fixture boards marked deleted/inactive. Initial smoke assertions needed to distinguish pending local rows from completed cloud rows; demo fixture guard correctly refuses live use. No production bug required a fix during this smoke.
- Retained all three original agent handles after usage reset; backend handle resumed to audit gate, then completed. Audit documented gate-close/in-flight initial registration race (protocol0 preparation can occur, protocol1 migration still gated); ADR wording corrected. Gate is not universal editing maintenance. No IAM/auth-provider changes, no credential output, no user-board content edits.
- Deployment report docs/plans/board-history-dev-deployment-2026-10-12.md includes commands/artifact scope and verification limits. Main checkpoint complete; no commit made.

### 2026-10-12 — history theme, spacing and labels

- Replaced undefined history theme variables and hardcoded borders/text/selection with app tokens; preview canvas follows the current theme even when the historical scene used another theme. Confirmation/progress share the fix.
- Added consistent header/list/preview/action spacing and stacked narrow-mobile layout; rows show saved date/time with origin/current status, and Close is an accessible X icon. Historical board name remains in the preview and restore payload.
- Extended existing Puppeteer UI coverage for live dark/light switching, mobile bounds, labels and X accessibility; updated timeline/outbox assertions to compare exact timestamp metadata while retaining complete version-ID oracles. Typecheck, targeted ESLint and development build passed. Initial UI assertion assumed a theme--light canvas class; Excalidraw represents light by absence of theme--dark, so the assertion was corrected. Final focused regression and dev hosting update pending.

- The corrected switching assertion uncovered an existing editor lifecycle bug: resolvedTheme was a dependency of board loading, so a theme change reset board state and closed history. Initial loading now reads the latest theme through a ref; the existing controlled canvas/updateScene theme path handles changes without reloading the board. Rebuilt and typechecked successfully; ESLint has one existing unused-import warning, no errors.

- Dark/light/mobile screenshots visually reviewed. The extended viewport/theme sequence can leave a pending local save, so restore test now handles the existing data-loss confirmation before asserting completion, rather than waiting behind that intentional modal. No restore authorization behavior changed.

- Final local history UI suite51704 exited0: live theme switching keeps modal/selection, light/dark token equality, date/time-only labels, X accessibility, mobile bounds, restore/notes/lineage/reload/undo and no browser errors. Timeline and outbox suites45894 passed independently (initial batch exit1 was the subsequently repaired UI assertion/lifecycle issue). Development build/typecheck/diffcheck passed.
- Hosting-only deployment21465 to open-excalidraw-dev-2 completed successfully; hosted history asset matches the verified development build byte-for-byte. No functions/rules/production deployment. Logs .system_generated/history-theme-{tests,ui-final,build,dev-deploy}.log and screenshots under .system_generated/regression/board-history-ui.test.mjs.artifacts/.

### 2026-10-12 — shadcn accordion, restore availability, renderer links

- Added a reusable shadcn/Radix accordion using app tokens, animated chevrons and reduced-motion support. Multiple day groups can be opened, new pagination groups default open, and every version retains its identity and source order.
- Actual user-board DOM and explicit dev REST read confirm four device-only snapshots and one cloud current baseline. All five disabled restore buttons follow current eligibility: device-only cloud-board entries await cloud acknowledgement; Current cannot be restored. No board content was changed. Added visible per-selection disabled reasons instead of silently disabling Restore. This does not claim the older captures have uploaded or fix an unidentified upload blockage.
- Replaced preview renderer default MainMenu with Search/Help only. Verified actual user tab no longer shows Excalidraw links/GitHub/Follow us/Discord. Main editor already had a custom menu excluding these.
- Extended actual Puppeteer menu/current-reason assertions and updated full paginated timeline accordion interaction oracle. Initial menu test used Escape, which legitimately closes the Radix history dialog; changed to clicking its menu toggle. Typecheck, focused lint and development build passed; final UI/timeline/cloud regression and hosting deployment pending.

- Final UI rerun38888 exited0; timeline and public cloud/collaboration restore suites25789 each exited0. Screenshots verify new accordion and Search/Help-only menu. All checks passed; hosting-only dev deployment47129 successful, hosted history asset matches verified build. Production/backend/rules unchanged.
- Actual user-board UI verified new accordion, explicit device-only restore reason and vendor-link-free menu through read-only/select/expand actions. Older device-only versions still require upload/validation; this UI change deliberately does not bypass the shared restore fence or claim the older history has synced.

### 2026-10-12 — stranded local history sync diagnosis and recovery

- Resumed retained local/backend/UI agents. Local agent identified hydration assigning current cloudVersionId before binding missing legacy sourceBaseVersionId, plus startup/hydration wakeup omitting history-only outbox on synced boards. Backend agent verified narrow safe repair constraints; UI agent owns truthful separate history-upload status.
- New actual Firebase/native-store regression board-history-rollout-ui.test.mjs reproduces acknowledged protocol0 captures -> metadata-first protocol1 hydration -> uploader; red run69255 fails with three retained entries, each 'The local save has no validated cloud history base.' This is the exact reported state, not a simulated uploader.
- Main worker calls atomic legacy lineage recovery after resolving stale same-generation fences/receipts, and emits history-status refresh on worker completion/failure. Native repair only admits active, never-bound, unstaged, unreceipted captures with missing ancestry; existing bases, receipts, payload IDs and staging stay fixed. Current board must not change for history-only recovery. Green rollout/outbox run51954 in progress; deployment pending.

- Real worker RED69255 -> GREEN51954 reproduced and resolved metadata-first migration; all three captures get stable receipts, complete cloud chunk scenes and protected notes, current head unchanged, retry duplicates zero. Existing outbox suite passed, including lost replies, failed-restore fences, expired ancestry and generation discard. Native suite currently77 assertions green; final claim-race guard review ongoing.
- Live user-board automatic recovery observed without manual content/restore: four prior device snapshots are now cloud imports; five accepted capture receipts (one canonical alias included) and five cloud versions, current baseline ID and generation unchanged. UI froze/reloaded while modules changed, so final visible restored-button proof will be collected after freeze. Truthful pending/blocked info status includes anonymous guest auth identity and no cross-account leakage. Final six-suite regression15775 running; no deployment yet.

- Final UI proof: all four imported historical versions show Saved to cloud; selected imported version previews correctly and Restore is enabled. Current board was not restored or edited. Screenshot `.system_generated/history-upload-recovered-live.png`.
- First combined regression found two failures: guest status fixture accidentally captured an unsynced baseline (fixed fixture baseline metadata), and actual timeline rename lost explicit intent under stale native revision. Native RED reproduced rename loss; minimal fix preserves explicit changedFields.name while protecting newer scene/notes and implicit stale names. Native GREEN now85 assertions; storage/frontend typechecks and scoped lint pass.
- Corrected status/rollout suites passed8350; timeline rerun77136 passed full65-version preview/pagination/restore/new-universe/reload oracle. Prior outbox/cloud/UI suites15775 passed. One diagnostic launch failed because the emulator WebChannel port was still occupied during teardown; retry succeeded. Final frozen-source rollout/UI suites14825 in progress. Hosting-only dev deployment follows these checks; production untouched.

- Completed: frozen-source rollout/UI14825 exit0; final frontend/storage checks, scoped lint and diff check passed. Timeline diagnostic confirms exact submitted rename, HTTP200, new immutable version and incremented nameRevision; no browser errors. Hosting-only deployment86305 to open-excalidraw-dev-2 succeeded. Hosted index and three history/sync bundles byte-match the verified development build. No functions/rules/production deployment or user-board restoration. Retained agent references remain available.

### 2026-10-12 — real divergent collaboration E2E

- User requested complete offline-owner/online-collaborators reliability proof. Added board-history-divergence-ui.test.mjs and runner registration. Three actual editors use pointer/keyboard changes on a five-chunk board; only setup uses fixture APIs. No manual worker/flush during reconnect. Independent Firebase chunk/canvas/receipt/history/network oracles and cold browser/reload assertions.
- Scope/assertion rationale in docs/plans/board-history-divergence-e2e.md. Retained backend agent audited independent branch/receipt/chunk assertions read-only. First actual emulator run79132 in progress; no passing result claimed.

- Resumed after usage reset with all three agent references retained. Real multi-chunk browser test reproduced UTF-16 surrogate corruption at RTDB WebSocket frame boundaries: U+FFFD appeared in canonical cloud payloads after collaboration. Minimal ASCII-escaped JSON wire serializer fixes framing while existing JSON.parse readers remain compatible; escaped wire size now respects the strict 256KiB record limit. Focused collaboration17/17, native85 and frontend typecheck passed. No production deployment.
- Reconnect run51460 has passed three-editor/cloud convergence and exact original offline-capture receipts plus RTDB/network checks; history preview and cold-reader/reload checks still running. Initial chunk reuse assertion assumed transport attribution never changes; corrected to require identity reuse for byte-identical base chunks. Diagram comparison excludes transport-only lastModifiedBy; historical capture bytes and authenticated receipt ownership remain exact. Added optional slow-network/lost-success-response variant; not yet run.

- Ordinary complete run84219 exit0: actual pointer/keyboard offline edits, two online guests, deterministic conflict winner, independent tombstones/additions, exact original history receipts, branch ancestry/30-day expiry, RTDB/cloud/network agreement, read-only history preview, cold guest and owner reload. Evidence copied to .system_generated/history-divergence-evidence/ordinary. Cold hydration normalizes absent bindings null→[]; test compares that semantic equivalence while keeping original captured bytes exact.
- First lost-reply harness run88651 failed on a destroyed browser execution context during reconnect; it did not establish the intended one-shot response drop. Corrected CDP order: install interception while offline, toggle online, then apply throttling (Puppeteer offline toggle resets network conditions), finally reconnect Firebase. Polling retries only destroyed-context navigation errors, never assertions. Corrected native receipt normalization and require recovery request after the deliberate drop. Frozen batch8310 now runs fault variant plus cloud history and five-chunk regressions. Frontend check and development build passed; scoped lint zero errors/one existing unused argument warning.

### 2026-10-12 — divergent collaboration reliability checkpoint COMPLETE

- Full ordinary browser scenario84219 and corrected throttled/lost-reply scenario72193 each exited0. Four original owner captures map to exact immutable snapshots; live owner/two guest editors, independent Firebase chunk decoder and cold reader/reload agree. Both tombstones, independent additions, unrelated movement and deterministic same-shape winner survive. Receipt recovery occurs after the deliberately dropped successful response and preserves first-acceptance ID/time/expiry; no duplicate immutable version. Every final outbox empty; no page/interception errors. Reports/screenshots preserved separately under .system_generated/history-divergence-evidence/{ordinary,lost-reply}.
- Extra assertions exposed test API/readiness assumptions: staging metadata is read through getImportPublication (not stripped public version rows); receipt comparison normalizes omitted undefined fields; final readiness requires every original capture published, not a transient empty outbox during reinitialization. Assertions continue to fail on missing/corrupt versions, diagram differences or application errors.
- Cloud history and exact five-chunk regression individually passed in batch8310 (batch exited1 for the previous divergence harness assertion). Five-chunk controlled edit reused3 chunks. Collaboration17/17 and native85 passed; frontend typecheck/build, final scoped lint (zero errors/one existing warning), syntax and diff checks passed. Detailed boundaries/results in docs/plans/board-history-divergence-e2e.md and ADR007 link.
- Hosting-only deployment47912 to open-excalidraw-dev-2 exit0. Hosted index-CoiMZduE.js and board-editor-B2cg5NSt.js (containing Unicode serializer) byte-match verified local build. Verification metadata .system_generated/history-divergence-hosted-{verification,wire-verification}.json. No production/functions/rules redeploy; no user-board content edits/restores; no commit. Retained history_backend/history_local/history_ui references remain reusable. Larger dropout permutations, oversized live RTDB records and deployed-cloud soak remain outside this finite scenario.

### 2026-10-12 — deployed Firebase divergence rerun

- User requested real dev Firebase and screenshot slideshow. Local frontend points to open-excalidraw-dev-2; deployed Auth, Firestore, RTDB and callable functions, no emulator. Registered owner session reused from the user's existing Chrome through a one-use loopback handoff; credentials kept in memory, not logs/files. Guest contexts remain isolated. Temporary handoff page removed after bootstrap. Actual scenario now running; no pass claimed yet. Retained agent handles unchanged.

### 2026-10-12 — final live Firebase attempt (incomplete)

- Reused the registered dev owner session in an isolated Puppeteer Chrome against deployed `open-excalidraw-dev-2`; production remained untouched. Metadata-only RTDB changes no longer trip the offline-leak guard, which compares exact scene payloads, IDs, versions/nonces, generation and restore fence.
- All four owner offline captures and both guest edit sets completed. The live-only 360s idle timeout let the scenario reach the convergence check, but final report-time diagnostics still showed 4 owner, 3 guest-A and 1 guest-B outbox entries pending; later drain is unverified. Exact canvas-to-Firestore convergence failed: both expected/cloud visible ID sets had 25 entries and geometry/tombstones matched, but rectangle `mt6UXuKRLjCjmfrsYcgHy` had canvas version 9/nonce 241402669/updated 1791792216719 versus canonical version 9/nonce 486027608/updated 1791792231586. Keep this failure strict; reconnect receipts, history preview/restore, cold reader and reload remain unexecuted.
- Final report and ten actual screenshots: `.system_generated/history-divergence-live/`; slideshow is marked failed. 233 callable requests, 230 readable responses (225 HTTP 200, five 409), 67 network failures including expected aborted Firestore channels, zero page errors. No commit.

### 2026-10-15 — resumed real-Firebase consistency investigation

- Rechecked prior `transaction-rerun-3`: deployed-dev history outboxes eventually drained and all history captures received receipts, but the test failed before offline-owner reconnect because two online guest canvases disagreed with the canonical chunk head only on a same-version element's `versionNonce`/`updated`; geometry, IDs, tombstones, and chunk bytes agreed. Kept the assertion strict; this tie-break value can affect a later equal-version conflict.
- Added a focused post-reconnect canvas-vs-canonical version/nonce check for the next run, while retaining the original strict convergence guard. The new check distinguishes temporary collaboration/canonical drift from a true post-reconnect mismatch; it does not suppress or normalize tie-break metadata.
- Focused verification: collaboration edge cases 18/18; native local-history suite 85 assertions; history model suite; frontend and functions TypeScript checks; backend history suite. The previous live attempt also confirmed exact Firebase history receipts, immutable snapshots, delayed outbox drain, and no browser page errors before the strict divergence assertion stopped it.
- A fresh real-dev Firebase E2E is running under `.system_generated/history-divergence-live/transaction-rerun-4.log` with board fixture `aaf758c8-14fd-44e3-b895-f2cde1daf2ec`; owner is authenticated in the isolated Chrome profile. It is checking three editors, offline owner captures, guest collaboration, server receipts, reconnect merge, RTDB/canonical equality, history preview, cold read and reload. No pass or deployment claim yet.
- Follow-up minimized the live mismatch to Excalidraw normalizing a remote element during synchronous `updateScene`: `onRemoteSceneApply` set the saved signature to the incoming version, then normalized `onChange` saw the changed version/index and authored a local save/broadcast. Added that normalization to `tests/remote-scene-autosave.test.ts`; it failed before the fix with a duplicate capture.
- Fixed by bracketing remote `updateScene` with before/after callbacks. The editor suppresses synchronous remote-origin `onChange` from local broadcast/history capture and then sets the baseline from Excalidraw's actual post-normalization scene; pending local snapshot/timer and committed signature remain intact. Regression now passes, as do collaboration edge cases 18/18 and the whiteboard typecheck.
- Strict real-Firebase rerun after this fix is running under `.system_generated/history-divergence-live/transaction-rerun-6.log`. It will recheck the same-version winner and full offline-owner reconnect path; no live pass or deployment claim yet.

### 2026-10-15 — live offline/collaboration consistency verification

- Run 6 reproduced delayed remote normalization of version/index metadata; no content loss was found. Run 7 showed the owner’s head commit was still pending when the E2E compared canvases to Firestore; the runner had asserted convergence before waiting for the reconnect outbox. The owner outbox later drained and Firebase matched the owner’s moved shape and tombstone.
- Added focused outbox regression requiring reconnect `importBoardVersion` and `commitBoardScene` responses and an empty outbox before comparing the cloud head. Emulator regression passed. The live runner now waits for all owner capture receipts/head acknowledgement and both guest outboxes before canonical comparison.
- Kept strong semantic assertions for every shape, additions, tombstones, chunk payloads, board generation, sharing, and exact historical receipts. Excalidraw may locally normalize version/index/nonce/timestamps on non-contested RTDB elements, so exact LWW metadata is asserted on the deliberately conflicting `seed-0` only; the prior full metadata equality incorrectly failed on unrelated elements after semantic convergence.
- Real `open-excalidraw-dev-2` run 9 passed: three authenticated editor sessions, offline owner branch, concurrent guest edits, four offline captures uploaded once, canonical merged scene committed, multi-chunk Firebase records independently decoded, cold reader, history preview, reload, and final outbox drain. It observed 556 `boardHistory` calls, 10 `importBoardVersion` calls, 12 `commitBoardScene` requests (6 successful and 6 expected `ABORTED` CAS conflicts), zero page errors, and 16 screenshots. Offline transport failures were expected; no restore call occurred.
- Slideshow updated at `.system_generated/history-divergence-live/slideshow.html`; full report and screenshots are under `.system_generated/history-divergence-live/transaction-rerun-9/`. TypeScript, remote-scene regression, collaboration 18/18, and the existing history outbox regression passed. No deployment or commit performed.
