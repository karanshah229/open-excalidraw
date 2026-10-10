# Recovering deployment chunk failures

An already-open app shell may reference a lazy editor chunk from an earlier Hosting release. On 2026-10-09, a request for the removed `board-editor-C5eX3kCU.js` returned HTTP 200 with HTML from Hosting's SPA rewrite. The browser rejected the dynamic import and the default router error screen stranded the board before the editor mounted.

The app handles Vite's preload error by reloading once per minute, guarded in session storage. It never automatically reloads an active Excalidraw editor. If storage is unavailable or the reload still fails, the router offers a manual Reload button. Recovery preserves IndexedDB boards and notes. Hosting responses require cache revalidation; existing app shells still require recovery when their referenced chunks are removed. Tabs opened before this handler was deployed need one manual refresh to load it.

The production-browser contract blocks a real lazy editor chunk: a transient failure recovers, a persistent failure stops after one automatic reload, and manual reload preserves both slides. A separate check verifies that an active editor is not automatically reloaded. `pnpm test:slides:prod` builds an actual production bundle in `e2e` mode so local production configuration is not embedded in browser tests.

Validation: production browser contract, TypeScript, lint and production release build passed. This recovery does not clear local storage, bypass access checks or alter backend settings.
