# Image format E2E report

Date: 3 October 2026. Browser: Google Chrome 154.0.8037.95, headless Puppeteer.

## Result

After the ICO and placement cursor fixes, **all 9 formats pass** locally, in Firebase emulators, and when testing the production Excalidraw bundle locally. The production frontend build also passed. This patch has **not been deployed**.

| Format | Local upload/render/reload/move | Emulator private/shared persistence | Production bundle locally | Stored MIME type         |
| ------ | ------------------------------- | ----------------------------------- | ------------------------- | ------------------------ |
| PNG    | Pass                            | Pass                                | Pass                      | image/png                |
| JPG    | Pass                            | Pass                                | Pass                      | image/jpeg               |
| SVG    | Pass                            | Pass                                | Pass                      | image/svg+xml            |
| GIF    | Pass                            | Pass                                | Pass                      | image/gif                |
| WebP   | Pass                            | Pass                                | Pass                      | image/webp               |
| BMP    | Pass                            | Pass                                | Pass                      | image/bmp                |
| ICO    | Pass                            | Pass                                | Pass                      | image/vnd.microsoft.icon |
| AVIF   | Pass                            | Pass                                | Pass                      | image/avif               |
| JFIF   | Pass                            | Pass                                | Pass                      | image/jpeg               |

For every passing format the cloud test recorded **two uploads**, one to the private root and one to the shared root. Actual mouse movement persisted its coordinates with **zero upload/read calls**. Private and shared reloads removed cached image bytes beforehand, verified a gateway read occurred, compared exact post-import bytes, and checked visibly rendered green pixels. Firestore scenes contained storage locators and empty inline image bytes.

## ICO failure and fix

Before the fix, the local and emulator suites each passed 8/9 formats. ICO showed “Unsupported file type” before any image gateway request. Chrome exposes the fixture's native MIME type as `image/vnd.microsoft.icon`; Excalidraw 0.18.1 listed `.ico` in the picker but accepted only `image/x-icon` in its MIME whitelist.

A version-scoped pnpm dependency patch now accepts the additional ICO MIME alias in both the development and production bundles. The existing `image/x-icon` entry and all other accepted image types remain supported. No file-extension bypass or forced MIME conversion is used. The real ICO fixture now passes rendering, exact-byte reload, private/shared gateway persistence, and movement with zero byte transfers.

`pnpm-workspace.yaml` registers `patches/@excalidraw__excalidraw@0.18.1.patch`, and `pnpm-lock.yaml` records its hash. The production-bundle E2E run explicitly selects the `production` export condition; its resolved entry was verified as `dist/prod/index.js`. Updating Excalidraw requires reviewing/rebasing this version-specific patch.

To make the ICO fix live, rebuild and deploy the frontend with the appropriate dev/production environment configuration. The ICO change itself requires no backend or rule change. Development's separate sharing compatibility problem described below remains unresolved.

## Placement cursor regression

Selecting an image now shows `move` once decoding/cache initialization completes and the image is ready to place. The patch removes the extra image thumbnail encoding for the custom cursor. Each of the nine formats checks the computed canvas cursor before clicking, then checks that pending placement clears and the cursor is no longer `wait`. The PNG regression failed before the patch and passed afterward. All three format suites were rerun successfully; the frontend production build and frozen-lockfile offline install also passed. These changes have not been deployed.

### Native Chrome follow-up

The user's already-running server on port 5173 still served the previous dependency after the patch installation. Selecting PNG through Chrome's native file dialog reproduced inline/computed cursor `wait`, including after a normal page reload. Restarting that Vite server and reloading the board resolved it: the same native dialog flow produced `move` while awaiting placement; Escape returned `auto`. This was verified in the logged-in Chrome session, rather than the headless HTML-input fallback. The format runner now uses its own Vite optimization cache for both development and production bundles. Dependency patches require restarting an existing Vite process to clear its old dependency resolution.

## Live development and deployed rules

The additional live development run uses the real `open-excalidraw-dev-2` services and isolated generated test boards. Private PNG upload and cloud reload passed on diagnostic retry. The current Share dialog then failed with `Missing or insufficient permissions`.

A read-only rules audit confirms development's deployed Firestore and Storage rules differ from this checkout. The deployed Firestore rules explicitly deny client creation of `boardShares` documents, while this checkout's sharing client creates the document directly. Increasing the wait timeout did not resolve sharing. The frontend's sharing path and this checkout's emulator rule fixtures need to be reconciled with the deployed project-sharing architecture before live shared coverage can pass. Replacing the newer deployed rules with this checkout's older rules would conceal the compatibility failure.

Development's deployed Storage rules also allow direct image reads/writes, whereas this checkout's image-hardening rules deny them in favor of the gateway. This is recorded as observed rule drift; this test task did not change either environment's rules. Production Firestore and Storage rules matched this checkout in the read-only audit. The live all-format production suite was **not run**. Testing the production Excalidraw bundle locally does not establish coverage on the deployed production site.

## Reproduce

```sh
pnpm test:images:formats
pnpm test:images:formats:cloud
pnpm test:images:formats:prod-bundle
pnpm test:images:formats:dev
```

Each suite exits nonzero when a format fails. The fixed local, emulator, and production-bundle suites exited 0. Cloud mode runs Auth, Firestore, Storage, RTDB and Functions emulators against `demo-image-persistence`, with real Firebase SDK calls and no service mocks. Development mode writes only newly generated test boards. Optional `--format=png` runs a single format. Live mode supports development only.

Committed fixtures avoid requiring Pillow or an encoder at test runtime. GIF coverage is for static, single-frame images; animation, large-image limits, arbitrary file attachments, and browsers other than this Chrome version are outside this matrix.

The runner is `tests/image-formats.test.mjs`; its setup/inspection helper is `apps/whiteboard/tests/image-formats-fixture.ts`. Raw results and screenshots are in `.system_generated/image-formats/{local,emulators,local-production-bundle,development}/`; the durable JSON report is `docs/features/image-format-test-results.json`.

Validation: the whiteboard TypeScript check, production frontend build, targeted ESLint, and `git diff --check` passed.
