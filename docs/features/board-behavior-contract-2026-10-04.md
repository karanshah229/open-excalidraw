# Board behavior confirmed on 4 October 2026

The user confirmed these requirements after reviewing changes to older regression fixtures:

1. Anonymous users can create and edit local-only boards. Creating owned cloud projects and publishing local boards require sign-in. Anonymous recipients retain the viewer/editor rights of public links.
2. A solo shared board may keep a lightweight session connection. Live scene/presence subscriptions stay inactive until another participant joins.
3. Email and public-link grants, viewer/editor changes, and revocation take effect in already-open boards without refreshing.
4. After a confirmed save, closing every app tab and opening a fresh tab restores elements, images, permissions, and collaboration.
5. Pending cloud changes trigger a close warning and remain locally recoverable. Cancelling the warning keeps the tab open.

## Audit and repairs

Reviewed commits: `2cc7432` added the aggregate test runner; `c0bb1a6` reused the network test's setup tab; `fdc41d5` recorded results. None changed application behavior. The earlier fixture repair migrated authentication and sharing setup. Registered cloud owners and a solo session lobby match the requirements above. Reloading after a direct API fixture does not prove that the actual Share UI updates an already-open board; reusing a setup tab does not prove fresh-tab recovery. A passing result from those fixtures was insufficient evidence for the broader user scenarios.

| Confirmed expectation                       | Decision after inspecting code and tests                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anonymous local-only creation               | Keep registered owners for cloud fixtures; repair the inaccessible local creation UI and add independent anonymous coverage.                                                                      |
| Lightweight solo connection                 | Keep the session-lobby architecture and network assertion; continue checking that live scene/cursor channels stay inactive while solo.                                                            |
| Permissions update without refresh          | Keep fixture reloads only for initial setup; add actual Share UI grant/downgrade/revoke tests on already-open recipient tabs and repair reauthorization.                                          |
| All tabs closed, fresh-tab recovery         | Add direct fresh-tab reopening for local images, owner recovery, shared permissions and renewed collaboration. Setup-tab reuse cannot establish this requirement.                                 |
| Pending changes warn and remain recoverable | Repair warning logic, explicitly handle warnings for deliberate fixture reloads, strengthen the completed-undo close assertion, and add offline image recovery for owners and public-link guests. |

`tests/board-behavior-contract.test.mjs` adds browser coverage through actual creation, drawing, image selection, Share controls, close dialogs and fresh tabs. Synthetic registered accounts and initial cloud boards are setup only. Permission grants use the UI, not direct database writes. Tests wait for the browser tab to actually close before reopening, wait for asynchronous image hydration, and compare retained bytes with the image accepted by Excalidraw (which can normalize PNG encoding).

The new tests reproduced application gaps before repairs:

- Signed-out creation was inaccessible: the sign-in screen had no local option and the New board action required an account. The local option now opens the existing local workspace without activating cloud synchronization.
- Reopening an anonymous-owned local board unnecessarily read cloud sharing metadata and could time out. These boards now load entirely from local storage.
- An initially denied recipient had no active reauthorization subscription. Existing authorized sharing retries now recover that board after an invitation, without browser navigation.
- Canvas focus/keyboard handling interfered with invitation input. The canvas yields focus and global keyboard shortcuts while Share is open.
- Completed local saves awaiting cloud synchronization did not warn on close. Pending/sync-failed states now warn, including while collaborating; confirmed anonymous local saves do not.
- An anonymous public-link editor's offline image was lost after accepting the warning and closing the tab. Unlike an owner, the guest had no workspace document to retain bytes before upload. Shared-recipient drafts now use a separate IndexedDB journal keyed by Firebase identity and board ID. Scene versions merge within the write transaction. Cloud acknowledgement clears only the matching draft revision, preserving newer edits in another tab. Recovery requires allowed board access; a viewer cannot replay a write. This journal does not grant workspace ownership or modify server permissions.

The older 19 suites remain enabled. The solo lobby assertion reflects the user's confirmed architecture. Fresh-tab coverage is added independently of the original network test, rather than declaring its setup-tab workaround sufficient.

Deliberate reloads in the chaos and undo fixtures now simulate accepting a pending-change warning, which is required by the user's answer even during collaboration. Their convergence/undo assertions remain intact. The separate incognito test still asserts that completed undo leaves no close warning, and now waits for the recipient tab to actually close before evaluating that assertion. The collaboration suite's third tab opens its board directly: immediately navigating homepage-to-board could interrupt startup and prevent the original multi-tab assertions from running.

The regression runner uses a temporary compiled Functions source with emulator-only parameters, preserving developer environment files. Emulator websocket ports are distinct from other running projects. No deployment or production data changes are part of this work.

Authorized tabs receive permission updates through snapshots. Firestore terminates a denied listener, so granting access to a previously denied tab uses the existing reauthorization retry (250 ms initially, capped at 5 seconds). Tests prove that no refresh is required; they do not establish a subsecond permission-update SLA.

## Verification

Targeted behavior suite: anonymous local creation/image reopening; email/public permissions without refresh; owner offline edits/images with warning/cancel/close/reopen/resumed cloud sync; anonymous public-editor offline drafts with close/reopen, cloud acknowledgement, and image hydration by another identity.

The first integrated run passed 12/13 aggregate stages but failed the browser stage: the new reopening test interrupted startup by immediately navigating from the homepage to the board, and three older suites left the newly required pending-change dialog unanswered during deliberate reloads. The new test now opens the board directly in a fresh tab; the targeted offline image recovery scenario passes. Raw first-run evidence is retained in `.system_generated/behavior-contract-first-full-run/`. No automatic retries or skipped stages are used.

The second integrated run passed all older suites but exposed the same immediate double-navigation problem in the public guest fixture. The third passed the original three behavior scenarios but exposed that setup pattern in the collaboration suite's third tab. Their direct-opening corrections preserve permission and multi-tab assertions. Those runs are retained in `.system_generated/behavior-contract-second-full-run/` and `.system_generated/behavior-contract-third-full-run/`. A separate red run of `anonymous-editor-pending-close` timed out waiting for the reopened image before the draft implementation; its recovered-image assertion then passed with the implementation.

Final `npm test` exited 0: **13/13 aggregate stages**, **20/20 browser suites** (all 19 older suites plus the behavior-contract suite), and **4/4 behavior scenarios** passed. The final invocation includes the guest cloud-acknowledgement and different-identity image checks. Build, TypeScript and lint passed; lint retains four preexisting warnings. Project scenarios, all nine image formats across local/emulator/production-bundle modes, image persistence/access policy and deleted-project sync are included. No cases were skipped or automatically retried.

The [machine-readable results](board-behavior-contract-results-2026-10-04.json) include source hashes, the final stage/suite/scenario results, the red anonymous-editor recovery result, and all three failed integrated diagnostic runs. Full stdout is in `.system_generated/behavior-contract-npm-test-verified.log`; per-stage and per-suite output remains in `.system_generated/all-tests/` and `.system_generated/regression/`. Existing live-account and historical security limitations in the full regression report remain separate.

Recovery applies to the same browser profile and Firebase identity. Browser storage deletion, private-window closure, or loss of the anonymous identity removes that local recovery path. Clearing a draft requires cloud acknowledgement, not merely seeing the image in the original tab. No production or development deployment was performed.
