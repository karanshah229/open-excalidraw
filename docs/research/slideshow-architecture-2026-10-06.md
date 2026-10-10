# Slideshow architecture review

The [implementation plan dated 2026-10-07](../plans/slideshow-implementation-plan.md) supersedes this review's product-flow recommendations: Slide is a dedicated Components toolbar option, authoring remains continuous, and fullscreen is a separate local audience surface. The code findings below remain background evidence.

Reviewed 2026-10-06. This is a design proposal, not an implemented feature. Repository code and pinned Excalidraw v0.18.1 source were inspected; no application tests were run because only research documents changed. Dependencies are absent from this checkout, so upstream compatibility was checked against tagged source rather than a running build.

## Recommendation

Build slides on native Excalidraw frames, with explicit presentation metadata in `frame.customData`. Keep drawing content in the existing scene, playback state local, and speaker notes in separately authorized storage if viewers must not receive them. Extract scene observation and mutation from the editor before adding the slideshow UI. No canvas engine replacement or Excalidraw fork is required for the initial feature.

Use one deck per board initially. Ordinary frames remain ordinary frames until explicitly promoted, or created with the new Slide tool. This preserves existing boards and gives users a clear choice about what appears in a presentation.

## Excalidraw Plus reference

Beyond frames, navigation and speaker notes, Plus documents phone QR remote control, presenter view, slide templates, PDF/PPTX export, read-only presentation links, webpage embedding, autoplay, laser pointer, voice hangouts, interactive embeds, synchronized YouTube playback, audience admission/reactions/raised hands, and synchronized participant views. Presentation animation is still in progress. Public sources do not establish numbering/reordering rules, notes privacy, timers, or the exact slideshow fullscreen behavior. See [the sourced feature inventory](excalidraw-plus-presentations-2026-10-06.md).

The architecture below is our recommendation; it does not claim to reproduce Plus's private implementation.

## What the code already provides

| Area | Evidence | Consequence |
| --- | --- | --- |
| Native drawing engine | `apps/whiteboard/package.json`; `routes/board-editor.tsx:1865` mounts Excalidraw 0.18.1 with its toolbar | Native frame drawing, manipulation, selection and image rendering are available. Paid Plus slideshow functionality is not imported. |
| Frame restoration | `board-editor.tsx:155`; `docs/features/frame-reload-recovery-2026-10-05.md` | Saved native elements are loaded with `restoreElements`, preserving `frameId`, tombstones and bindings. Keep this path. Skeleton conversion remains for generating new elements. |
| Persistence | `packages/storage/src/index.ts:46`; board schema at `:110` | Scenes contain generic elements/app state/files; the scene schema permits additional properties. Frame custom data needs no board schema migration. |
| Change/save path | `board-editor.tsx:129`, `:1238`, `:1393`, `:1436` | Scene signature includes all element data, but only four app-state settings. Saves are queued and debounced; share-recipient drafts are journaled. Frame metadata fits this path. |
| Live collaboration | `use-collaboration.ts:212`, `:465`; `collaboration-service.ts:316`; `reconcile.ts:1` | Whole elements are sent per ID and reconciled by version/nonce. Slide metadata must bump the frame version. Concurrent edits to different fields of the same frame can still conflict. |
| Durable recovery | `functions/src/index.ts:103`; `shared-scene-drafts.ts:34`; `workspace-api.ts:216` | Backend compaction, offline drafts and cloud conflict resolution merge elements. Metadata on frames follows these existing merge paths. |
| Camera | `board-editor.tsx:91`, `:213`, `:234` | Existing centering uses editor padding and a zoom cap of 1. Presentation needs its own fit policy and ownership of camera changes. |
| Access | `board-editor.tsx:550`, `:1871`; `firestore.rules:52`; `database.rules.json` | Viewers can read the shared scene and element payloads. Hiding notes in UI would not make scene-embedded notes private. |
| Export/assets | `features/workspace/export-boards.ts`; `features/assets/scene-assets.ts` | Existing export produces whole-board Excalidraw/SVG/PNG and hydrates protected image bytes. It does not paginate frames or produce PDF/PPTX. |
| Agent editing | `packages/mcp/src/index.ts:200`; `board-editor.tsx:848` | MCP supports generic creation/patch/delete, but updates currently spread properties directly. Frame membership, slide duplication and undo need a shared command path. |

The editor is 1,952 lines and owns loading, permissions, persistence, camera, MCP operations and UI. Adding another large inline subsystem would make camera and save behavior harder to reason about.

## 1. Slide model and ordering

Recommended frame metadata, namespaced to preserve unrelated custom data:

```ts
type SlideMetadataV1 = {
  schemaVersion: 1
  orderKey: string
  hidden: boolean
}
// frame.customData.agenticWhiteboard.slide = metadata
// frame.id is the slide identity; frame.name is the editable title.
```

- A slide is a non-deleted native `frame` with valid slide metadata. Ignore magic frames and unknown metadata versions safely. Validate finite, positive dimensions before presentation.
- Sort by a presentation-specific fractional order key, then frame ID as a deterministic tie-break. Do not use scene array position or Excalidraw's `index`: those represent drawing order and can change through layer operations or reconciliation. `reconcileElementsLWW` rebuilds arrays from a map, not a deck sequence.
- Derive automatic numbering from sorted slides; never write a number into every frame after insertion/deletion. Recommended rule: hidden slides remain numbered in the authoring list; playback skips them and separately displays the current position/visible total.
- Creating a slide appends after the last slide unless a selected slide provides an insertion position. Reordering changes only that slide's order key. Concurrent equal keys must sort consistently; define insertion between tied keys and bounded rebalancing before selecting a rank implementation.
- Use `newElementWith` for changed frames and preserve the rest of `customData`. Capture authored commands immediately for undo; camera and incoming remote changes use `CaptureUpdateAction.NEVER`.
- Deleted frames stay tombstoned for undo. Unmarking a slide removes only its presentation metadata; it does not delete the frame or drawing. Explicit null/removal handling must survive replication.
- Imported frames are not silently promoted. Import/export retains slide custom data through native Excalidraw JSON; a plain board export excludes separately stored notes. A future deck bundle can carry notes through an explicit authorized export.

Why metadata on the frame: it gives ordering/visibility the same offline persistence, replication and undo mechanism as the object users manipulate. A parallel `scene.presentation.slides[]` registry would require updating every scene reconstruction, conflict merge, draft recovery, compactor and history path, plus a second undo mechanism. Avoid that for one deck per board.

Limitation: metadata and geometry share whole-element LWW. A concurrent frame move and slide reorder can lose one intent. Accept and test that policy for the first release; field-wise convergence or multiple decks would justify separate versioned presentation records later.

## 2. Frames are containers, not arbitrary camera bookmarks

Native elements have one `frameId`; frame-like elements are excluded from eligible frame children. Drawing a frame can establish membership and moving it can move its content. Duplicating a slide must duplicate its children, update IDs/bindings/groups/frame memberships and assign a new order key; a generic object clone is insufficient.

Recommended first-release semantics: slides use normal native frame ownership. Do not promise that two overlapping slides can independently own the same drawing, or that a slide can wrap existing frames as nested children. Test this explicitly with diagrams that already use frames.

If the intended product is overlapping crops/zoom steps over the same diagram, use non-owning viewport regions instead. That is a materially different model: custom drag interaction/overlays and geometric cropping, without reparenting scene elements. Decide that before implementation; it changes authoring and rendering, not just the toolbar label.

Creation UI: a Slide tool arms native frame drawing; finalize a locally drawn frame and attach metadata once. Also provide “Make slide” for an existing frame. Track drawing intent and created IDs so ordinary frames, imports and incoming remote frames are never accidentally promoted. Verify that drawing plus promotion is one meaningful undo action; do not mutate metadata from every `onChange`.

## 3. Extract an observable scene module and command seam

Create a small module exposing current scene snapshots, subscriptions and authored scene commands. Keep save queues, signatures and permissions behind that interface. Feed it both native changes and remote reconciliations; the slide list derives from its current snapshot.

This is necessary because the current refs are not reactive subscriptions. `onChange` returns before refreshing refs in read-only mode, and the RTDB reconciliation path mutates `elementsRef` and calls `updateScene` without a dedicated slide-state notification. A viewer's slide list must update when an editor changes slides.

Suggested implementation locations:

| Module | Responsibility |
| --- | --- |
| `features/scene/scene-session.ts` | Current scene, subscriptions, write capability, snapshots and save integration. |
| `features/scene/scene-commands.ts` | Versioned immutable changes; correct undo capture; native create/promote/reorder/duplicate/delete commands; MCP uses the same seam. |
| `features/presentation/slide-model.ts` | Metadata decoding, sorted slides, numbering, visibility, validation and deletion fallback. Pure and independently testable. |
| `features/presentation/use-presentation.ts` | Playback state, input handling and lifecycle; independent of durable authoring. |
| `features/presentation/presentation-stage.tsx` | Audience rendering, fit, clipping, fullscreen and overlays. |
| `features/presentation/slides-panel.tsx` | Reordering, thumbnails, titles, promotion and notes entry point. |
| `features/presentation/notes-store.ts` | Separately authorized note reads/writes and offline drafts. |
| `features/presentation/presentation-export.ts` | Common slide crop rendering, PDF/PPTX adapters and export cancellation. |

These are proposed files. Keep extraction scoped to the integration needed for slides; a complete editor rewrite is unnecessary. Avoid a new generic canvas abstraction when Excalidraw is the only implementation.

## 4. Playback and audience stage

Use ephemeral state such as `{ mode, activeSlideId, fullscreen, notesOpen }`, where mode distinguishes editing, local presenting and eventually following a live presenter. Resolve position from the current ordered deck; keeping only an array index breaks when collaborators reorder or delete slides.

- Start at the selected slide or first visible slide; support next/previous, Home/End, slide picker, arrows/PageUp/PageDown/Space, and Escape. Scope shortcuts away from notes inputs and embeds. Define no-wrap navigation at deck ends and an empty-deck state.
- If the current slide disappears/hides, choose the next visible slide, then previous; exit safely if none remain. Restore the prior editor camera/tool/UI on exit without restoring an old scene snapshot over live edits.
- Freeze authoring while presenting through UI mode, but do not change board permissions or collaboration write capability. Flush pending edits when entering; report save failure without erasing drafts. Remote content can continue to update the stage.
- Fullscreen is independent of playback. Request it on the stage container from the user's click, respond to `fullscreenchange`, resize and browser Escape, and retain useful windowed playback when fullscreen fails. Presenter notes must be outside the audience container.
- Camera fitting should use frame geometry and the measured stage rectangle, with letterboxing and no editor margins. Do not reuse the board-wide auto-center helper: its padding and `maxZoom: 1` are wrong for slide fitting. Suppress auto-centering and MCP camera commands while playback owns the camera.
- Zooming to a frame alone can expose nearby content in unused screen space. Enforce a clipped stage with a defined slide background and aspect ratio. Hide frame names/outlines while preserving clipping; disabling all frame rendering also disables clipping in v0.18.1.

Recommended first renderer: a crop of the current slide rendered through `exportToSvg` or `exportToBlob` with `exportingFrame`. Reuse it for thumbnails and PDF/PPTX. This guarantees a finite slide rectangle and keeps notes/editor controls out of the audience view. Pass non-deleted elements, authorized hydrated files and explicit export styling. Never replace the editor's scene with only the active slide to achieve isolation: that can enter persistence or remove assets/tombstones.

Static crop playback does not provide interactive embeds, synchronized videos or live annotation automatically. A live Excalidraw audience adapter can follow later, with clipping and camera/input locking verified separately. Native crop selection includes unowned overlapping elements or elements owned by the target frame, but excludes elements owned by another frame; that behavior must match thumbnails, playback and export.

Cache thumbnails by frame geometry plus relevant element versions, image identities and theme/background. Generate lazily for visible rows, limit concurrency, cancel stale work, release Blob URLs and avoid exporting every slide during every drag. Bound React publication to changes that affect the deck or current slide. The existing editor already serializes scene signatures on change; do not add another whole-scene serialization per slide.

## 5. Speaker notes and presenter view

For audience-private notes, use a separate note record keyed by board ID and frame ID, guarded by the existing board edit policy. Editors share notes initially; viewers get no read access. A presenter-only model would instead need user-keyed records and a separate permission decision.

- Add a local IndexedDB collection/cache for notes and queued drafts, with revision/conflict handling and identity isolation. This is a new local schema/store change even though frame metadata itself needs no board migration.
- Add server note reads/writes through authorized callables or a Firestore subcollection with explicit rules. Reuse effective project/board edit checks, including deletion and revocation. Firestore authorization must exclude viewers; keeping notes out of the rendered stage is insufficient.
- Notes must not appear in `boardShares.scene`, RTDB element payloads, the MCP scene response, thumbnail data, audience messages or ordinary `.excalidraw` exports. Do not introduce editor-only children under the current broadly readable RTDB board node: ancestor read grants cannot be revoked by child rules.
- Use plain text first, optional safe link rendering, bounded length and autosave with a visible dirty/conflict status. Keep note drafts when a frame is deleted so undo can restore access; establish retention and board-deletion cleanup separately.
- Note undo is separate from canvas undo when notes live separately; focus determines which editor receives undo. Duplicate explicitly copies notes after the frame clone, with recoverable failure behavior.

For the first release, notes can be an in-page presenter panel outside the audience stage. For a second display, share only the stage window and keep notes in a separate presenter view. A same-origin popup plus a scoped `BroadcastChannel` can synchronize local current-slide state without Firebase; bind it to board/session identity and clean it up on close. Fullscreen alone does not provide two-monitor presenter view.

If the product intentionally allows every board reader to read notes, storing notes in frame custom data is simpler and removes this backend work. That is a different access contract and should be explicit to users.

## 6. Shared playback and Plus-level additions

Independent playback from an existing read-only board link can use local state; add validated board search parameters (`mode`, `slideId`) to `router.tsx` and keep access checks in the board loader. A link opening one slide does not restrict access to the rest of the board.

Live follow requires a new ephemeral presentation-session record: host identity/session, active slide ID, monotonically increasing sequence, lease/heartbeat and audience follow preference. It must not be encoded in durable slide metadata or Excalidraw app state. Late joins read the current session; stale events are ignored; host loss/revocation ends following. Followers may opt out without ending the presentation.

Current live scene listeners are gated by `activeSessions.length >= 2`; presence contains cursors/selections but no active slide or presenter authority. An audience/remote presentation subscription must operate independently of that lazy editor gate. Receiving slide events and receiving the current slide's content are separate requirements. Snapshot and live subscriptions need a defined handoff so viewers do not follow to stale content.

Phone QR remote additionally needs scoped, expiring pairing authorization: allow slide control for one active session, not board editing or unrelated note access. Viewer roles currently cannot write element payloads, so implement authorized session control and rule validation deliberately. Reactions/admission/voice/media synchronization are further modules, not prerequisites for local slideshow.

PDF/PPTX: add deck export options next to the existing board export, with one crop per visible slide in explicit order, consistent aspect-ratio/background policy and sequential bounded rendering. Image-per-slide PPTX is a feasible first contract; editable Excalidraw shapes are separate work. Include notes only through an explicit authorized export option. Reuse image hydration and cancellation/account-change checks; decide embed fallbacks rather than implying that interactive content survives export.

Templates can later generate a native frame and children through scene commands. Multiple decks would require shared slide references/order outside individual frames; do not add that complexity before it is needed.

## Delivery sequence and verification

1. Establish native-frame ownership, ordering, hidden-slide numbering and note-access contracts. Extract the observable scene module and authored command seam; add pure model tests and a version/history compatibility probe.
2. Ship Slide drawing/promotion, derived numbering, reorder/rename/duplicate/delete, thumbnail list and clipped local playback with next/previous/fullscreen/exit restoration. Keep ordinary boards compatible.
3. Ship audience-private notes with offline drafts and server authorization, then presenter view. Notes are part of the requested feature; they are not complete until access and recovery work.
4. Add independent presentation links and PDF/PPTX, then live follow and QR remote if desired. Templates, autoplay and audience features can follow without altering the slide model.

Required behavior checks:

- Draw a native slide around images, bound text, arrows and existing groups; reload through real persistence; verify membership and asset hydration. Exercise the existing framed-scene-reload contract.
- Number/reorder/duplicate/hide/delete/undo/redo without confusing deck order with layer order; test equal concurrent ranks and unknown metadata versions.
- Verify metadata-only commands bump versions and converge across two clients; move and reorder the same frame concurrently and demonstrate the declared LWW policy. Cover offline drafts, reconnect and final-session compaction.
- Confirm a read-only viewer receives new/deleted/reordered slides while both solo snapshot and RTDB synchronization paths are active.
- Enter/leave presentation during pending saves, resize/fullscreen Escape, remote slide deletion and permission revocation. Navigation must not save the camera or populate canvas undo.
- Verify a viewer cannot fetch notes directly, and notes never appear in exported scene/RTDB/MCP/audience messages. Verify offline editor notes survive reload and access loss without being published to viewers.
- Check crop fidelity for unowned overlaps, elements in another frame, frame edges, fonts, dark mode, images and embeds; use the same crop semantics for stage/thumbnails/export.
- Stress a large scene/deck while dragging: thumbnail generation stays bounded and navigation remains responsive.

## Pinned engine evidence

- Native frame shape, single `frameId`, and `customData`: [v0.18.1 element types](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/element/types.ts#L72).
- Restore preserves custom data: [restore implementation](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/data/restore.ts#L209).
- Versioned immutable authored changes: [newElementWith](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/element/mutateElement.ts#L149); public exports include this helper and `CaptureUpdateAction`: [package entry point](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/index.tsx#L257).
- Frame child eligibility and overlap filtering: [frame operations](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/frame.ts#L440), [export overlap selection](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/frame.ts#L927).
- Public crop exports support `exportingFrame`: [export utilities](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/utils/export.ts#L29); crop bounds and hidden frame decorations: [render/export implementation](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/scene/export.ts#L114).
- Render flags, duplication hook and frame-rendering interface: [v0.18.1 integration types](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/types.ts#L276).
- General camera/history interface: [official integration documentation](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api). Current documentation is supplementary; the tagged source above establishes compatibility with this repository's version.
