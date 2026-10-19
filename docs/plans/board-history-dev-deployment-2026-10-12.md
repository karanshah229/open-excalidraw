# Development deployment — 2026-10-12

User explicitly authorized deployment to development. Target project: `open-excalidraw-dev-2`. Production `open-excalidraw-b2ab4` was not touched.

## Completed

- Built functions and frontend using development environment. Full isolated backend suite passed after adding the server-only migration gate; targeted ESLint and whitespace checks passed.
- Closed `system/boardHistoryRollout.migrationEnabled` before installing services. Deployed 20 explicitly named relevant functions, preserving unrelated existing functions. Function deployment and rules/hosting deployment each exited 0.
- Refreshed 70 existing board/project access mirrors using current projection logic and RTDB ETag/version guards; existing sharing grants were not changed.
- Installed Firestore, RTDB and Storage rules and published the dev frontend at https://open-excalidraw-dev-2.web.app. All six deployed composite indexes reached READY before the migration gate reopened.
- Verified all new history callables ACTIVE. Unauthenticated `boardHistory` now returns 401 rather than 404. Scheduler jobs `recoverBoardRestores` (every minute) and `cleanupExpiredBoardHistory` (hourly) are ENABLED. Scheduler installation is verified; this is not a 30-day production soak result.
- Reopened migration. User board `d48bc362-9364-4041-9985-45fa7cdfe8aa` changed from protocol 0 with zero versions to protocol 1 with a baseline version; generation remains 1 and no restore barrier remains. No shapes, name, notes, sharing or project on that board were manually changed by verification.

## Actual deployed browser check

Used actual Firebase development services and Puppeteer at localhost:5173 with a disposable guest editor and a temporary board. One initial baseline became three cloud versions after two separate toolbar/pointer rectangle draws. Waited for the actual local outbox to drain, then compared every rendered history-row ID to the cloud list: exact equality; no page errors. Smoke process exited 0. Temporary boards were marked deleted/inactive after verification.

Email/password signup is disabled in this environment, so the first owner-test identity attempt was refused with `auth/operation-not-allowed`; no auth-provider configuration was changed. An initial comparison observed two legitimate pending local history rows and was corrected to wait for outbox completion. A subsequent diagnostic attempt correctly hit the emulator-only fixture guard; final verification imports the actual loaded storage module instead. SDK application-default credentials were expired, and IAM JWT signing was denied; deployment verification used existing authenticated gcloud OAuth internally and normal guest authentication. No IAM roles were broadened and no credentials were printed or stored in the report.

Artifacts (ignored generated files): `.system_generated/dev-history-functions-deploy.log`, `dev-history-rules-hosting-deploy.log`, `dev-deploy-gate-tests.log`, `dev-history-live-smoke-report.json`, `dev-history-live-smoke.png` and `dev-history-guest-smoke.log`. The report contains only fixture IDs, version IDs, endpoint names and assertion results.

## Operational notes

Refresh an already-open local/hosted board after deployment to refresh protocol negotiation and allow pending local captures to upload. Separate changes made before the history-aware client existed cannot be reconstructed from legacy cloud saves; migration preserves the current cloud tuple as its baseline. Captures retained by the history-aware client while the old backend was active remain eligible for its normal outbox upload.

The migration gate blocks new registration/upgrade, not ordinary legacy editing or protocol-1 editing/restores. In-flight initial registration may prepare a protocol-0 head during gate closure and finish after reopening. It must not be treated as a universal maintenance lock. See ADR007 for recovery and rollback requirements and the E2E coverage audit for outstanding validation. Actual 30-day retention boundaries, longer network/dropout permutations and production throughput remain outside this finite dev smoke.
