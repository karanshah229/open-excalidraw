# Slide feature implementation plan

Date: 2026-10-07. Status: proposed; implementation has not started.

This plan supersedes the product-flow recommendations in the [architecture review](../research/slideshow-architecture-2026-10-06.md). It incorporates the requirement for a dedicated **Slide** option under **Components** in the drawing toolbar and continuous authoring on a board that contains both presentation content and ordinary drawings.

## Product contract

The board is always one free-flowing drawing surface. Slides are objects on that surface. There is no presentation board type, drawing-to-presentation conversion, or persistent editing/presenting state on the document.

1. Open the toolbar's **Components** section and select **Slide**, a distinct frame-like option alongside ordinary Frame.
2. Drag around existing drawings to create a slide. The drawings remain at their existing coordinates; surrounding sketches and context remain on the board.
3. Draw inside or outside any slide using the same drawing tools. Slide creation never restricts further authoring.
4. Slides show an automatically derived number and an optional title. A slide list provides thumbnails, reordering, selection and speaker notes.
5. Click a thumbnail to navigate to that slide on the board. Next/previous controls navigate the same canvas, with all authoring still available.
6. Use **Fullscreen** to open an audience view of the current slide. Closing it returns to the same live board. Fullscreen is a local viewing surface, not a mode or permission change on the drawing.

Ordinary frames do not become slides automatically. No setup or “start presentation” step is necessary to draw the first slide. Initially, all Slide objects on a board form one ordered presentation; multiple decks on one board are deferred.

### First-release scope

- Dedicated Slide tool under Components, distinct from Frame.
- Draw around existing content; edit slide bounds and continue drawing freely.
- Automatic numbering, optional titles, thumbnail list and reordering.
- Previous/next and direct slide navigation on the board.
- Fullscreen audience view with keyboard navigation.
- Speaker notes with autosave and offline recovery.
- Save/reload, import/export compatibility, undo/redo and collaborative slide edits.

PDF/PPTX, phone remote, audience following, autoplay, templates and live audience features are follow-ups. The first release is not complete without speaker notes and the existing persistence/collaboration behavior.

## Architecture decisions

| Concern | Decision |
| --- | --- |
| Canvas | Keep the existing Excalidraw canvas and native drawing tools. |
| Slide geometry | Use a native `frame` tagged with namespaced slide metadata. It remains distinct from Frame in the product UI. |
| Content | Use native frame membership and manipulation; do not copy drawings merely to make a slide. |
| Presentation order | Store an independent order key on each Slide; never infer sequence from coordinates or layer order. |
| Numbering | Derive `1..N` from sorted, non-deleted Slides; do not persist numbers. |
| Authoring | Never set the board read-only merely because a slide is selected, navigated to, or displayed fullscreen. |
| Viewing state | Keep active slide ID, panel visibility and fullscreen-window state local to the client. |
| Notes | Store separately from the shared scene, readable/writable by authorized board editors. Viewers cannot fetch them. |
| Rendering | Reuse one slide-crop renderer for thumbnails and fullscreen. Keep the original scene mounted and intact. |
| Collaboration | Reuse versioned element replication for Slide metadata; use an observable scene module for the slide UI. |

### Native-frame behavior to preserve and explain

Native Excalidraw frames own their children: moving a Slide can move its contained drawings, resizing can change membership, and each element has one `frameId`. Slide creation changes containment, not the drawing's position or the board's capabilities. Deleting only the Slide boundary should preserve its drawings; expose a separate explicit action for deleting the Slide and its content, if needed.

For the first release, use native containment semantics, and verify normal frames and Slides can coexist without unexpected reassignment. Two Slides cannot independently own the same element. Native frames cannot nest as children, so a Slide drawn over an already framed diagram needs clear handling: preserve the existing frame and its members; indicate that already framed content was not adopted rather than silently stealing it.

An alternative with arbitrary overlapping crops would require non-owning slide regions and a custom membership/rendering policy. That is a follow-up design if shared-content or nested-frame slides become requirements; it is not required to keep normal sketches alongside slides.

## 1. Extend the toolbar with a real Slide entry

The pinned Excalidraw v0.18.1 extra-tools menu is rendered inside `packages/excalidraw/components/Actions.tsx` by `ShapesSwitcher`. It hardcodes Frame, Embed and Laser entries. The public integration props do not expose a custom entry slot for this menu. `renderTopRightUI` would place Slide elsewhere and would not meet the requested location.

Extend the repository's existing version-scoped Excalidraw patch with a small host-rendered menu slot. Wire it through the package props and toolbar rendering, allowing our app to render the **Slide** entry under **Components** beside Frame. Match existing dropdown selection, keyboard navigation, icons and mobile behavior. Keep ordinary Frame's label and shortcut.

The host entry arms native frame drawing and records local Slide-tool intent. This is a selected tool, like Rectangle or Frame, not a drawing/document mode. Show Slide as selected while that intent is armed; clear it on switching tools, cancellation, board navigation or completion unless tool-lock is enabled.

Implementation requirements:

- Use a stable extension hook, not DOM queries, menu-item injection, or CSS-positioned imitation controls.
- Track intent for the local drag and its newly created frame ID. Never promote imported frames, remote frames, or an ordinary Frame drag.
- Attach Slide metadata within the same creation/undo transaction. First verify the engine's frame creation and pointer-up ordering. If public callbacks cannot accomplish a single undo step, add a narrow frame-creation callback to the patch and stamp metadata before the engine commits the new frame.
- Do not repeatedly modify frame metadata from `onChange`; that creates save loops and ambiguous undo.
- The first persisted/broadcast frame should already have its Slide metadata. A peer should not temporarily see a plain frame that later becomes a slide.
- Update both development and production patch artifacts, the pnpm patch hash, and `patches/README.md`. Preserve the current image-format and cursor fixes.

No new Excalidraw element type or global canvas-engine fork is needed. The limited toolbar/creation extension is still a maintained package patch and must be verified when upgrading Excalidraw.

## 2. Add the slide model and authored commands

```ts
type SlideMetadataV1 = {
  schemaVersion: 1
  orderKey: string
}

// element.type === 'frame'
// element.customData.agenticWhiteboard.slide = metadata
// element.id identifies the slide; element.name holds its optional title.
```

Decode metadata defensively; ignore deleted elements, invalid dimensions, magic frames and unsupported versions. Preserve unrelated custom data. Existing boards need no conversion or backfill.

Use a fractional ordering scheme with a deterministic frame-ID tie-break. Creation appends by default; duplication inserts after its source; reordering changes only the moved Slide's key. Define insertion among equal concurrent ranks and bounded rebalancing before selecting the rank implementation. Array order, native `index`, and canvas coordinates must never become presentation order.

Render the number separately from the user-authored title. Prefer an engine-supported frame-label extension through the existing patch if needed; do not update every frame's `name` or add ordinary text elements whenever numbering changes. Include numbers in thumbnails/list rows even if the canvas label extension is delivered later within the same release.

Provide versioned commands for rename, reorder, resize, duplicate and remove-boundary. Use Excalidraw's `newElementWith` and explicit undo capture for authored changes. Duplicate through native duplication behavior that repairs child IDs, groups and bindings; normalize copied metadata to a new order key without adding another undo step. Keep deletion tombstones and clear membership from preserved drawings when removing a boundary.

MCP should invoke the same commands for slide operations. Generic patches must not circumvent metadata validation, frame version increments or membership invariants. Playback navigation is a local operation and must never mutate scene elements.

## 3. Publish current scene state without coupling it to saves

Introduce a small observable scene module and authored-command interface used by the Slide UI, the editor integration and MCP. Keep the existing save queue, drafts, image handling and collaboration transports.

The current editor uses mutable element refs. Its `onChange` returns early in read-only cases, and remote reconciliation can update refs without notifying a slide list. Separate three concerns:

1. Observe the current elements/files regardless of write permission.
2. Publish relevant changes to the Slide UI and renderer.
3. Persist or broadcast only authorized authored changes through the existing paths.

Connect observation to initial load, native edits, cloud snapshots, RTDB reconciliation, undo/redo and imports. Prevent remote updates from being re-authored or added to local undo history. Keep derived slide subscriptions cheap; avoid another whole-scene JSON serialization for every thumbnail.

Metadata rides existing element replication, offline scene drafts and backend compaction. It needs no board-schema migration. Concurrent geometry and metadata changes to the same frame still use whole-element last-write-wins; document and test that limitation rather than implying field-level convergence.

## 4. Build continuous in-board slide navigation

Add a collapsible Slides panel with thumbnails, number/title, reorder handles and a notes entry point. Keep canvas tools accessible while the panel is open. The panel is optional UI, not a prerequisite for creating slides.

Store `activeSlideId` locally. The panel and controls derive the current position from the latest ordered Slides; an array index becomes stale after collaborative reordering. A thumbnail click fits the main canvas camera to that Slide; the user can immediately draw, pan or return to adjacent context.

Previous/next should stop at deck ends. Keyboard shortcuts apply only when slide navigation or the fullscreen view has focus; do not steal arrows, Space or undo from text editing, notes or drawing tools. Clicking unrelated drawings does not change their type or require leaving a presentation state.

Use measured canvas dimensions when fitting. Keep the existing whole-board initial-centering helper, but prevent delayed initial centering from overriding an explicit user slide navigation. In-board camera movement must not change the saved board scene, cause a save, or enter canvas undo history.

If the active Slide is deleted remotely, choose the next Slide from the previous sequence, then the preceding Slide. If none remain, clear navigation state and leave the board available. Remote reorder updates the list but should not unexpectedly move a user's main camera.

## 5. Add fullscreen as a separate audience surface

Open a fullscreen-capable stage layered above the editor, with a current slide crop, previous/next, slide count and close control. Keep the board mounted with its live data subscriptions; never replace its scene with only the active Slide or change its authorization flags.

Request the Fullscreen API from the user's click; handle browser Escape, `fullscreenchange`, resize and fullscreen failure. Support a windowed stage when the browser cannot enter fullscreen. Closing the stage restores focus and exposes the same board, with edits received while it was open still present.

Use the existing crop-capable `exportToSvg`/`exportToBlob` helpers with `exportingFrame`, hydrated authorized image files, non-deleted elements, a defined background and no frame decorations. The finite crop prevents adjacent sketches from leaking into the audience view. Letterbox arbitrary slide dimensions instead of forcing the board geometry to a fixed ratio.

Keep native crop semantics consistent across thumbnails and fullscreen: overlapping unowned drawings may appear; drawings owned by a different native frame are excluded. Verify this against the authoring containment rules. Static playback will not automatically support interactive embeds or live drawing on the stage; the board remains the place to edit and updates regenerate the displayed crop.

Cache by relevant geometry, content versions, files and styling. Render thumbnails lazily, bound concurrency, cancel stale work, discard out-of-order results and release Blob URLs. A change to unrelated board context should not regenerate every slide.

An optional second-window audience view can follow, sharing current-slide state through a session-scoped same-origin channel. Never send notes through that channel. No backend presentation-session system is needed for local fullscreen.

## 6. Add speaker notes with explicit access and recovery

Editors may open notes for any Slide while drawing or navigating. Notes never appear as drawing elements or in the audience crop. Default to shared editor notes: owners/editors can read and edit; board viewers cannot fetch them.

Add separately authorized records keyed by board ID and Slide ID, plus an identity-scoped local IndexedDB notes store and queued drafts. Use effective board/project edit permissions, including project deletion and access revocation. Do not store private notes under the existing RTDB board node because its ancestor read grant includes all children.

Use bounded plain-text notes with debounced autosave, durable local drafts, revision checks and visible save/conflict status. Concurrent note edits must preserve a recoverable conflicting draft rather than silently overwrite it. Preserve notes through Slide undo and board reload; define duplicate-note copying and retention for removed Slides. Note-input undo is separate from canvas undo and follows focus.

Keep notes out of shared scene payloads, ordinary `.excalidraw` exports, thumbnails, MCP scene responses and audience messages. A future explicit authorized deck export may include them. This adds notes storage and backend authorization work; it does not require changing the existing scene format.

## Code touchpoints

Paths below are relative to the repository root. New filenames are proposed.

| Location | Planned change |
| --- | --- |
| `patches/@excalidraw__excalidraw@0.18.1.patch`, `patches/README.md`, `pnpm-workspace.yaml` | Toolbar entry slot, atomic creation/label hooks if required; retain and verify existing patch behavior. |
| `apps/whiteboard/src/routes/board-editor.tsx` | Wire Slide tool intent, observation, commands, panel and audience stage; preserve existing save/access logic. |
| `apps/whiteboard/src/features/scene/scene-session.ts` | Observable current scene independent of persistence gating. |
| `apps/whiteboard/src/features/scene/scene-commands.ts` | Shared versioned mutations and undo behavior for UI/MCP. |
| `apps/whiteboard/src/features/slides/slide-model.ts` | Metadata parsing, ordering, numbering and active-slide fallback. |
| `apps/whiteboard/src/features/slides/slide-tool.ts` | Local creation intent and atomic tagging integration. |
| `apps/whiteboard/src/features/slides/slides-panel.tsx` | List, thumbnails, reorder, titles and continuous navigation. |
| `apps/whiteboard/src/features/slides/slide-renderer.ts` | Crop rendering, cache invalidation and bounded work. |
| `apps/whiteboard/src/features/slides/fullscreen-slides.tsx` | Independent audience surface and input/fullscreen lifecycle. |
| `apps/whiteboard/src/features/slides/slide-notes.tsx`, `notes-store.ts` | Notes editor, local drafts and remote sync. |
| `apps/whiteboard/src/features/collaboration/use-collaboration.ts` | Publish remote scene updates to the observable module. |
| `packages/storage/src/index.ts` or a dedicated local notes store | Typed slide metadata where shared; notes cache/revision persistence without adding notes to `BoardScene`. |
| `functions/src/project-access.ts`, `functions/src/index.ts`, `firestore.rules` | Authorized note reads/writes or dedicated notes-subcollection rules, cleanup and policy tests. |
| `packages/mcp/src/index.ts` | Validated slide commands through the shared mutation interface. |
| `apps/whiteboard/src/styles.css` | Slides panel, selected Slide tool, canvas numbering and fullscreen controls. |

## Implementation sequence

| Step | Deliverable | Completion gate |
| --- | --- | --- |
| 1. Engine integration probe | Components → Slide entry; local frame creation with metadata and distinct selected state | One drag creates one Slide with one undo step; Frame stays ordinary; both patched builds pass. |
| 2. Model and command integration | Ordering, numbering, observable scene and versioned commands | Reload/undo/remote updates preserve identity, membership and metadata; no migration of ordinary frames. |
| 3. Continuous board UX | Slide labels, panel, reorder, rename, duplicate and previous/next | Users draw inside/outside Slides and navigate adjacent context without switching document state. |
| 4. Audience rendering | Shared crop renderer and fullscreen stage | Crop fidelity, resize/Escape, remote updates and bounded rendering verified; editor remains mounted. |
| 5. Notes | Authorized remote notes, offline drafts and note UI | Viewer access denied directly; editor recovery/conflicts/undo/duplication verified. |
| 6. Release verification | Browser/collaboration contracts and existing affected regressions | All checks below pass in development and production bundles before rollout. |

Keep extraction limited to the scene/command integration needed for slides. Do not block this feature on rewriting the entire editor or building live audience infrastructure.

## Acceptance checks

1. **Toolbar:** Slide appears under Components on desktop/mobile, has an accessible label and selected state, and leaves ordinary Frame behavior intact. Switching/canceling does not tag the next unrelated frame.
2. **Coexistence:** Create drawings before and after Slides, both inside and outside their boundaries. Normal sketches, Frames and Slides persist together; no drawing/document mode or editing lock is introduced.
3. **Containment:** Existing positions stay unchanged on creation. Verify groups, arrows, bound text, images, resize, moved-in/out elements, overlapping Slides and already framed diagrams. Remove-boundary preserves drawings.
4. **Undo:** Creation plus metadata is one undo step. Rename/reorder/duplicate/remove/redo behave consistently. Duplicate repairs IDs and bindings and receives a fresh rank.
5. **Ordering:** Layer changes and moving Slides on the board do not alter sequence. Concurrent equal ranks produce identical numbering on every client. Deletion and undo renumber without rewriting all frames.
6. **Persistence:** Reload and native export/import preserve Slide metadata and assets; ordinary frames remain ordinary. Cover shared-recipient drafts, offline recovery and final-session compaction.
7. **Collaboration:** Viewer/editor lists update through both durable snapshots and live element sync. Remote reorder does not hijack the main camera. Same-frame concurrent edits obey the documented LWW policy.
8. **Navigation/fullscreen:** In-board navigation stays editable. Keyboard focus does not interfere with drawing/text/notes. Fullscreen crops out surrounding context and handles deletion, resize, browser Escape and denied fullscreen.
9. **Notes:** Editors autosave/recover drafts; conflicting edits retain a recoverable version. Viewer direct reads are denied. Notes are absent from audience output, scene exports, element replication and MCP scene data.
10. **Performance/regressions:** Large-board drag/navigation remain responsive; thumbnail work is bounded. Run frame-reload, image-format/placement, relevant save/undo/access and collaboration suites against both patched engine builds.

## Reference evidence

- Current architecture and repository findings: [architecture review](../research/slideshow-architecture-2026-10-06.md).
- Exact toolbar implementation: [Excalidraw v0.18.1 Actions.tsx](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/components/Actions.tsx#L269).
- Available public props and pointer hooks: [v0.18.1 integration types](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/types.ts#L497).
- Native frame eligibility and membership: [frame implementation](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/frame.ts#L440).
- Versioned mutations: [newElementWith](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/element/mutateElement.ts#L149).
- Crop rendering support: [export utilities](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/utils/export.ts#L29).

## Implementation status (2026-10-07)

The core feature is implemented. See [implementation and deployment notes](../slideshow.md) for the final module boundaries, verification, and remaining extensions. Native frame creation/title hooks were required and are patched in both engine builds. The `slideNotes` callable is deployed to development. Present now keeps the audience view in the main window, with private notes, slide previews, navigation, and a timer in a separate Speaker view popup. PDF/PPTX export, remote control, autoplay, permanent notes cleanup, and a background notes outbox remain future work.
