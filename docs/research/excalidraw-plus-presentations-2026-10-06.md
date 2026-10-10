# Excalidraw Plus presentation reference

Verified 2026-10-06 against first-party public pages. These establish product behavior, not its private implementation.

## Established capabilities

- Frames around drawings become slides automatically. Present directly from the board; use a laser pointer and voice hangouts. [Official presentation guide](https://plus.excalidraw.com/use-cases/presentations)
- Scan a QR code to control the presentation from a phone; share a slide link for independent viewing; embed the presentation in a webpage; export PDF or PPTX. [Official presentation guide](https://plus.excalidraw.com/use-cases/presentations)
- Share presentations read-only and run online presentations with slides and voice. [Education use cases](https://plus.excalidraw.com/use-cases/education)

The following shipped additions are documented in the [official changelog](https://plus.excalidraw.com/changelog):

| Release | Presentation capability |
| --- | --- |
| January 2026 | Presenter view; synchronized YouTube playback; QR session sharing; slide previews generated in a worker. |
| February 2026 | Admission waiting room; audience reactions and raised-hand queue; laser works in view-only mode and permits opening links/embeds. |
| March–May 2026 | Slide templates with tags/recent layouts, personal/workspace collections, and drag-and-drop onto canvas. |
| April 2026 | Presenter notes with links, adjustable font size, mobile swipe; interactive embeds function during presentations. |
| July 2026 | Autoplay for shared decks; improved presentation viewport locking. |
| August 2026 | Spotlight Me synchronizes participant views; notes focus the closest slide; improved PDF/PPTX rendering. |

## Roadmap and uncertainty

- Presenter notes are marked shipped; presentation animation is still in progress. [Official roadmap](https://plus.excalidraw.com/roadmap)
- Public pages reviewed do not specify automatic numbering rules, slide reordering mechanics, hidden slides, transition controls, presenter timer, exact keyboard shortcuts, or notes visibility/permissions. Do not describe these as verified Plus features.
- Fullscreen exists in the product (July changelog documents macOS fullscreen behavior), but the retrieved guide does not establish a slideshow-specific fullscreen contract. [Changelog](https://plus.excalidraw.com/changelog)
- A public read-only example exists, but text-only retrieval exposes metadata rather than interactive controls. [Official example presentation](https://link.excalidraw.com/p/readonly/LF1Z5T1eAeBQNvlcAFz2)

## Architectural implications for our design (inference)

Local slideshow, presenter notes, and ordering form a useful first release. Live audience sessions, remote control, and shared playback introduce separate session state and authorization; they should not be conflated with durable slide authoring. PDF/PPTX requires an export pipeline that clips each slide consistently. Presenter view requires audience-safe rendering separate from notes. These are design deductions, not claims about Excalidraw's internal architecture.
