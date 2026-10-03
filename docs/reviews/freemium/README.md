# Freemium feature review

Open [the slideshow](index.html) locally in a browser; [slide 10](index.html#10) starts the collaboration review. Fourteen screenshots were captured from the actual app on port 15176 against `open-excalidraw-dev-2` on 2026-10-03. These are recorded screenshots; temporary users, manual entitlements and board/live fixtures were removed after capture.

Validation: 17 emulator integration checks plus the browser suite, 11 live usage/UI checks, and five live collaboration checks passed. The collaboration capture uses four distinct users in isolated browser contexts. The Pro ceiling test uses four editing browsers and six additional authenticated session reservations, then verifies that an eleventh browser receives a read-only snapshot. The 80% image warning uses a seeded counter on a disposable account. Google OAuth itself was not automated.

Dev has the eight freemium callable endpoints and a narrow own-session-grant cleanup rule. Other deployed project-sharing rules and background triggers were preserved. Full restrictive rules/background rollout and production deployment are pending; see [rollout details](../../plans/freemium-rollout.md).

| Slide | Feature                                                             |
| ----- | ------------------------------------------------------------------- |
| 1     | Free plan, pricing and live usage                                   |
| 2–3   | Early and critical cloud-board alerts                               |
| 4     | Quota-blocked cloud save with local drawing retained through reload |
| 5–6   | Pro request and responsive plan UI                                  |
| 7     | Image storage warning                                               |
| 8–9   | Complimentary Pro on desktop/mobile                                 |
| 10    | Bidirectional live edits across two browsers                        |
| 11–12 | Free capacity at three sessions and fourth-browser rejection        |
| 13    | Owner Pro admits a fourth editor while guests remain Free           |
| 14    | Pro ten-session ceiling and eleventh-browser rejection              |

After recapturing the live suites, regenerate this review with `node tests/freemium-feature-slideshow.mjs --publish-review`. The published review references local PNG files; it includes no Firebase credentials or raw logs.

The live screenshots were captured before the project-sharing merge. The combined implementation passes both emulator/browser suites; see [integration validation](../../plans/freemium-project-sharing-integration.md).
