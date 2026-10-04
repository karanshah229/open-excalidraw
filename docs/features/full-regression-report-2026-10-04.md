# Full regression run — 4 October 2026

**The full test inventory is not green.** The image/project suites pass, but 17 of 19 older browser suites fail during setup. All 19 have identical pass/fail outcomes against archived main (`faea109`); the feature branch tested was `4008c5f`. These failures do not demonstrate an image-upload regression, but they prevent assurance for the workflows whose assertions never run.

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

## Older browser suites and main comparison

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

The anonymous-owner fixtures now conflict with server-owned project management. Other fixtures create only a localStorage share configuration without a real owned board/project, or use an outdated workspace setup/selector. Undo, multi-user collaboration, network lifecycle, inactive presence, owner visibility and MCP UI checks remain unverified where setup failed. Migrate those fixtures to registered owners and actual project/board/share callables, preserving isolated anonymous guest contexts and the existing behavioral assertions, before treating the full regression suite as a release gate.

## Live development and deployment audit

`pnpm test:images:formats:dev` was attempted: all nine cases stop before import with `Sign in to manage your workspace [401]`. That runner provisions anonymous owners, which the current live project-management API rejects. This is a setup failure, not evidence that nine image types are unsupported. It needs registered-owner provisioning before live format coverage is usable.

`pnpm check:images:deployment` completed as a read-only audit. It does not prove that the merged branch is deployed. No deployment or live production E2E run was performed.

## Historical security diagnostics

These scripts assert the presence of vulnerabilities; a `REPRODUCED` verdict is adverse evidence, not a green security test. The 12-scenario audit reproduced three findings:

1. A viewer creates enough fake presence/session records to force the owner into spectator mode, then malformed presence causes a renderer exception.
2. An unauthenticated public-editor upload accepts an arbitrary 11 MiB **snapshot** object, and RTDB accepts malformed/oversized element payloads. The image asset upload itself is correctly denied by direct Storage rules.
3. An unpaired MCP WebSocket adapter changes the agent-visible canvas and forges command acknowledgements; the cached canvas remains available after adapters disconnect.

These concern existing presence, snapshot/database and MCP paths documented in the earlier security audit. No first-party changes in this feature alter the RTDB validation or MCP adapter implementation. The nine remaining audit findings were inconclusive or stopped by protections: some rely on old share mutation APIs or outdated fixtures, so they are not verified fixes. Standalone Firestore and local-cache exploit scripts also stopped at their former prerequisites; the standalone MCP exploit reproduced. This audit does not establish the deployed production configuration's exposure.

## Evidence and reproduction

The durable machine-readable companion is `full-regression-results-2026-10-04.json`. Raw stdout/stderr, temporary runners, baseline comparison and screenshots are retained in `.system_generated/full-regression/`; format matrices also remain in `.system_generated/image-formats/`. Product source and original test assertions were not changed in this run.

Core commands: `pnpm test:collab`, `pnpm test:mcp`, `node packages/mcp/node_modules/tsx/dist/cli.mjs tests/collab-load-simulation.test.ts`, `node tests/image-access-policy.test.mjs`, `pnpm test:e2e:projects`, `pnpm test:images`, all three image-format modes, and `pnpm check && pnpm build && pnpm lint`. Image cloud persistence, cloud formats and deleted-project sync ran sequentially under Auth, Firestore, Storage, RTDB and Functions emulators. Older browser scripts ran through the retained `run-legacy.mjs` harness; the same scripts were compared through `run-baseline.mjs`.
