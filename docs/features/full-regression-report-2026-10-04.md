# Full regression run — 4 October 2026

**All 19 repaired browser regression suites now pass.** Collaboration unit tests (17 cases), MCP tool tests (four groups), image access policy, TypeScript, production build and lint also pass; lint retains four existing warnings. The full inventory still has live-authentication and security gaps described below.

The initial run failed 17 of 19 older browser suites during setup, with identical outcomes on archived main (`faea109`); its feature branch was `4008c5f`. The follow-up tests fixture commit `e92aa68`; application runtime is unchanged.

## Single test command

Run `npm test` (or `pnpm test`) from the repository root. It builds the workspace, runs typecheck/lint, collaboration unit/load tests, MCP tools, image policy, all 35 project scenarios, local/cloud image persistence, all nine formats in three modes, deleted-project sync, and all 19 older browser suites. Stages run sequentially to avoid emulator/port collisions; failures produce a nonzero exit code and logs/results under `.system_generated/all-tests/`.

The command requires installed workspace dependencies, pnpm, Firebase CLI, Java and Google Chrome. Project/image emulators use an isolated copy of the compiled Functions source with demo parameters, so the developer's `.env.local` cannot override their test configuration. Live development/production account checks, deployment utilities, migration scripts and historical security exploit probes remain separate; a passing functional run does not resolve the known security findings below.

Latest `npm test` at `c0bb1a6` completed with **exit code 0: 13/13 stages passed**, including 19 older browser suites, 35 project scenarios and 180 image-format checks. The first integrated run correctly exited nonzero when the network-lifecycle fixture intermittently timed out after closing its setup tab. Preserving that tab fixed the handoff race; its six network assertions remain intact. The final result comes from a complete fresh run, without automatic retries or skipped functional stages.

## Fixture repair follow-up

The older suites were written before server-owned project management. The initial failures happened before their behavioral assertions: anonymous owners cannot manage projects, localStorage share records do not create owned cloud boards, and the dropdown fixture used a mock identity instead of Firebase authentication.

The repair adds `apps/whiteboard/tests/regression-fixture.ts`, restricted to localhost demo emulators. Owners use registered Firebase accounts; guests use isolated anonymous accounts. Boards are saved under actual owned projects, cloud writes are flushed, sharing is published through the application callable, and the initial shared scene is saved separately from policy changes. Tests that publish an already-open private board reload before testing collaboration. Solo fixtures keep their setup tab to avoid racing its teardown with another tab's persistent storage initialization.

The Share-dialog test now selects public/editor access through the UI and waits for the real dialog's Done button after policy changes. The access-denied screen also uses `.google-share-done-btn`; the old broad selector could click its Go to workspace button while reads were temporarily blocked during a policy mutation. The test retains its avatar, editing and downgrade assertions.

Network probes now recognize emulator Firestore requests and RTDB sockets. The obsolete solo expectation of zero RTDB sockets is replaced by stronger semantic checks: one active session, no live presence/element subscriptions, no transition banner and no live collaboration. Shared boards need the lobby connection to detect another participant.

Run `pnpm test:e2e:regression` for all 19 suites, or an individual existing package test command. The runner builds Functions/MCP, launches isolated demo emulators and a frontend on port 15190, installs the repository rules, preserves any existing demo parameter file, and writes per-suite logs/screenshots/results under `.system_generated/regression/`. It does not target development or production Firebase accounts. Application runtime and deployed rules are unchanged by these repairs.

## Passing coverage

- Collaboration reconciliation: 17 edge cases; ten-client load simulation.
- MCP tools: template generation, layout, grouping and search test groups.
- Image access policy matrix.
- First-class project E2E: all 35 browser/network scenarios.
- Local and cloud image persistence, sharing reload, access revocation, soft deletion and restoration.
- Deleted-parent blocked sync, pending-image retention on reload and resumed sync after restore.
- Nine formats in local, Firebase emulator and local production Excalidraw bundle modes: 180 checks. Every cloud format made one initial image upload and zero image byte transfers during movement.
- Auto zoom/centering and delete-all/reload without a flash.
- TypeScript and production build; lint has zero errors and four existing unused-variable warnings.

## Initial older-browser run and main comparison

Tests used isolated synthetic Firebase demo data. Original assertions were preserved; temporary copies redirected only server URLs, Node import locations and screenshot output. The main comparison used an archived checkout, its own frontend/storage modules and compiled MCP server, with the unchanged project-policy backend in demo emulators. The MCP comparison was rerun after its missing compiled artifact was corrected.

| Suite                                       | Feature branch | Main | Observed result                                            |
| ------------------------------------------- | -------------- | ---- | ---------------------------------------------------------- |
| e2e-collab-suite.mjs                        | Fail           | Fail | Sharing fixture lacks an owned project/board               |
| collab-chaos-live.test.mjs                  | Fail           | Fail | Anonymous owner rejected by project-management callable    |
| network-lifecycle.test.mjs                  | Fail           | Fail | Anonymous owner rejected by project-management callable    |
| repro-user-str.mjs                          | Fail           | Fail | Anonymous owner rejected by project-management callable    |
| inactive-tab-presence-cursor.test.mjs       | Fail           | Fail | Anonymous owner rejected by project-management callable    |
| board-auto-zoom-center.test.mjs             | Pass           | Pass | passed                                                     |
| solo-no-collab-banner.test.mjs              | Fail           | Fail | Anonymous owner rejected by project-management callable    |
| incognito-undo-beforeunload.test.mjs        | Fail           | Fail | Anonymous owner rejected by project-management callable    |
| collab-undo-resurrect.test.mjs              | Fail           | Fail | Anonymous owner rejected by project-management callable    |
| delete-all-reload-flash.test.mjs            | Pass           | Pass | passed                                                     |
| unauthenticated-owner-hidden.test.mjs       | Fail           | Fail | Anonymous owner rejected by project-management callable    |
| solo-delete-collab-undo.test.mjs            | Fail           | Fail | Anonymous owner rejected by project-management callable    |
| collab-undo-further-ops.test.mjs            | Fail           | Fail | Anonymous owner rejected by project-management callable    |
| mcp-live-e2e.test.mjs                       | Fail           | Fail | Synthetic board never reaches editor; outdated share setup |
| create-board-modal-dropdown-scroll.test.mjs | Fail           | Fail | Outdated workspace setup/UI selector                       |
| e2e-smoke-test-and-screenshots.mjs          | Fail           | Fail | Sharing fixture lacks an owned project/board               |
| e2e-non-anonymous-test.mjs                  | Fail           | Fail | Synthetic board never reaches editor; outdated share setup |
| browser-collab-verify.mjs                   | Fail           | Fail | Synthetic board never reaches editor; outdated share setup |
| e2e-visual-screenshots.mjs                  | Fail           | Fail | Synthetic board never reaches editor; outdated share setup |

The anonymous-owner fixtures now conflict with server-owned project management. Other fixtures create only a localStorage share configuration without a real owned board/project, or use an outdated workspace setup/selector. Those failures initially prevented undo, collaboration, network, presence, owner visibility and MCP UI assertions from running. The fixture repair described above now exercises these workflows successfully in all 19 suites.

## Live development and deployment audit

`pnpm test:images:formats:dev` was attempted: all nine cases stop before import with `Sign in to manage your workspace [401]`. That runner provisions anonymous owners, which the current live project-management API rejects. This is a setup failure, not evidence that nine image types are unsupported. It needs registered-owner provisioning before live format coverage is usable.

`pnpm check:images:deployment` completed as a read-only audit. It does not prove that the merged branch is deployed. No deployment or live production E2E run was performed.

## Historical security diagnostics

These scripts assert the presence of vulnerabilities; a `REPRODUCED` verdict is adverse evidence, not a green security test. The 12-scenario audit reproduced three findings:

1. A viewer creates enough fake presence/session records to force the owner into spectator mode, then malformed presence causes a renderer exception.
2. An unauthenticated public-editor upload accepts an arbitrary 11 MiB **snapshot** object, and RTDB accepts malformed/oversized element payloads. The image asset upload itself is correctly denied by direct Storage rules.
3. An unpaired MCP WebSocket adapter changes the agent-visible canvas and forges command acknowledgements; the cached canvas remains available after adapters disconnect.

These concern existing presence, snapshot/database and MCP paths documented in the earlier security audit. No first-party changes in this feature alter the RTDB validation or MCP adapter implementation. The nine remaining audit findings were inconclusive or stopped by protections: some rely on old share mutation APIs or outdated fixtures, so they are not verified fixes. Standalone Firestore and local-cache exploit scripts also stopped at their former prerequisites; the standalone MCP exploit reproduced. This audit does not establish the deployed production configuration's exposure.

## Remaining fixes outside the regression fixture repair

The live development format runner needs a registered owner from an explicitly authenticated browser session or dedicated test-account setup. Its anonymous-account provisioning cannot create projects under the current policy; emulator owner creation must not be reused against live accounts. This follow-up does not claim new live development or production validation.

The reproduced security findings require application changes: bind presence/editor-slot admission to authorized, bounded sessions; validate snapshot type/size and RTDB element shape/size; and require adapter pairing/authentication plus command-bound acknowledgements in MCP. Those findings are not repaired by fixture migration and should have separate negative security tests before being marked fixed.

## Evidence and reproduction

The durable machine-readable companion is `full-regression-results-2026-10-04.json`. Raw stdout/stderr, temporary runners, baseline comparison and screenshots are retained in `.system_generated/full-regression/`; format matrices also remain in `.system_generated/image-formats/`. Application runtime is unchanged by the fixture repair. Behavioral assertions are retained, with the obsolete solo zero-socket assertion corrected to check active-session and live-channel behavior. Fresh logs, screenshots and all 19 passing results are in `.system_generated/regression/`; the JSON companion retains the original failing run and main comparison.

Core commands: `pnpm test:collab`, `pnpm test:mcp`, `node packages/mcp/node_modules/tsx/dist/cli.mjs tests/collab-load-simulation.test.ts`, `node tests/image-access-policy.test.mjs`, `pnpm test:e2e:projects`, `pnpm test:images`, all three image-format modes, and `pnpm check && pnpm build && pnpm lint`. Image cloud persistence, cloud formats and deleted-project sync ran sequentially under Auth, Firestore, Storage, RTDB and Functions emulators. Older browser scripts ran through the retained `run-legacy.mjs` harness; the same scripts were compared through `run-baseline.mjs`.
