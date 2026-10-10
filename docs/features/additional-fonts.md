# Additional whiteboard fonts

Excalifont remains the default. **Show fonts → Quick search** lists all 20 additional families immediately, with unquoted names even before their files download:

- System fonts: Arial, Times New Roman, Helvetica, Verdana, Georgia, Courier New, Trebuchet MS, Tahoma, Segoe UI, Calibri.
- Bundled web fonts: Roboto, Open Sans, Inter, Lato, Montserrat, Poppins, Noto Sans, Merriweather, Playfair Display, Fira Code.

## Loading and fallbacks

A fresh board renders before requesting additional fonts. Once its initial scene is ready, `BoardEditor` schedules the queue after two animation frames using `requestIdleCallback` (a one-second timer fallback where unsupported). Background downloads run two at a time and are deduplicated within the page. Opening the picker accelerates remaining downloads for its previews. Fonts used by an existing scene or export load immediately.

The picker remains searchable while downloading. Pending rows expose `aria-busy`, a progress cursor, and a loading message. Failed downloads show a system-fallback explanation and a Retry button; editing stays available. Fonts already loaded in the current page remain usable offline. Reconnecting retries failed faces automatically. A retry rebuilds errored `FontFace` objects because calling `load()` again on an errored face does not recover them. Font recovery preserves the chosen family and refreshes text dimensions for the downloaded face.

System fonts use local installations and need no font-file requests. Matching generic serif, sans-serif, or monospace fallbacks are used where absent. Proprietary font files are not redistributed or embedded in SVGs, so appearance and metrics can differ on another device. See the [Microsoft font redistribution FAQ](https://learn.microsoft.com/en-us/typography/fonts/font-faq).

Bundled fonts are regular (400), upright, self-hosted WOFF2 files with all source glyphs retained. Excalidraw embeds subsets into SVG exports. Copyright/license files and pinned source URLs are in `apps/whiteboard/public/fonts/SOURCES.md`.

## Integration

`whiteboard-fonts.ts` registers the catalog before React mounts. `font-loading.ts` owns scheduling, the retry queue, and font/network status subscriptions. `FontLoadingFeedback` attaches feedback to the existing picker. The Excalidraw 0.18.1 patch adds typed `registerCustomFonts` and `loadCustomFonts` seams in both development and production distributions, keeps failed selections usable with generic fallbacks, and refreshes custom text dimensions when its face becomes available.

IDs 2000–2019 are application-owned and persisted in text elements; never renumber or reuse them. Helvetica keeps upstream ID 2 and its existing metrics for saved-board compatibility. Excalifont keeps ID 5 and its default settings. Choosing another font retains Excalidraw's current-font behavior.

## E2E flow

Run `node tests/fonts.test.mjs` after `pnpm --filter @agentic-whiteboard/whiteboard exec vite build --mode e2e`.

1. Load a fresh board with the idle callback controlled: no additional font requests; new text uses Excalifont.
2. Release the idle callback while holding font responses: two background requests begin.
3. Open font search during the delay: all 20 names are visible, the progress cursor and busy state appear, and remaining files are requested.
4. Release responses: all ten bundled files return HTTP 200 and their `FontFace` statuses become loaded; the loading UI clears.
5. Go offline with loaded faces: downloaded fonts remain available without new downloads.
6. Load another fresh board, then go offline before releasing the idle callback: failed fonts remain searchable, fallback text can be entered, and reconnection reloads all ten faces without changing the selected family.
7. Return HTTP 503 for font downloads: failures clear the busy state and show Retry; successful retries restore all ten faces and correct the fallback text dimensions.
8. Check selection, reload persistence, JSON restoration, SVG embedding, and PNG export. Repeat loading, delayed response, offline, failed-request, and retry checks in the real production build.

The test controls idle callbacks and network responses instead of relying on wall-clock sleeps. It collects network statuses, inspects DOM state and browser font statuses, and checks that failures do not produce unhandled page errors.
