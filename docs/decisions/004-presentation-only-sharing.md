# ADR 004: Publish audience slides separately from board scenes

- Status: Superseded by [ADR 005](005-live-presentation-sharing.md)
- Date: 2026-10-09

## Context

A Presentation link must open a slideshow without granting read or edit access to the underlying board while allowing the published speaker notes to be read by anyone with the link. Hiding the drawing editor after downloading its scene would still expose surrounding sketches, element metadata and image assets.

## Decision

Add `presentation` as a board's general link role. Existing invited collaborators retain their explicit permissions. Publishing overrides inherited project access for this board; parent deletion still revokes access. Firestore, Storage, asset authorization and RTDB projections exclude this role from public board read/write grants.

Before changing a share policy, the client checks capabilities on both the publishing service and board-access service. Missing or older services leave permissions unchanged. Deploy the permission rules and functions as one feature rollout.

The audience route `/presentations/{boardId}` mounts no editor and requests rendered PNG slides and explicitly published notes. The `presentations` callable authorizes every manifest/page read against the current sharing policy and board/project lifecycle. Direct access to `boardPresentations` remains denied. Editable scene data never enters these documents or embedded image metadata. Publishing copies notes into the snapshot; the original notes endpoint remains editor-only. The Share dialog explains that notes are included.

An editor uploads an immutable revision, then atomically publishes its manifest only after all pages exist. The audience uses one revision; concurrent republishing prompts a reload rather than mixing revisions. Copying the Presentation link publishes the current snapshot. Editing the board does not automatically republish it.

## Alternatives Considered

- Loading the raw scene in a read-only slideshow: rejected because it grants board-data access.
- Filtering elements client-side: rejected because clients would already have received the private scene.
- Live server rendering: deferred because it requires a new rendering service and complicates asset authorization. Snapshot publishing reuses the established slide exporter and makes the shared contents explicit.

## Consequences

Presentation links work for signed-out audiences and open a themed landing page with a Start presentation with notes button. That gesture opens a separate speaker window containing read-only published notes, filmstrip, navigation and timer; the original window shows slides and requests fullscreen. A Fullscreen button handles browsers that require another gesture after opening the popup. Blocked popups leave the landing page visible with a retry message. The maximum is 200 slides; image size is bounded before upload. Embedded interactions become static images. Already downloaded images cannot be recalled after revocation. Old or interrupted revisions remain private; retention cleanup is deferred, matching the existing recoverable-asset policy.

Deployment requires the new `presentations` function, updated `manageBoardAccess`, RTDB mirror functions (`mirrorBoardAccessToRtdb`, `mirrorProjectAccess`, `syncBoardAccessToRtdb`), `boardAsset`, and Firestore/Storage rules together with the frontend. Do not enable Presentation in a frontend against older authorization rules.

Clipboard access is requested synchronously during the click, using a promised `ClipboardItem` payload that resolves only after publication succeeds. This preserves the user gesture while rendering/uploading slides; see the [WebKit clipboard API](https://webkit.org/blog/10855/async-clipboard-api/) and [ClipboardItem constructor](https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem/ClipboardItem). The Share dialog stays mounted through temporary canvas reloads caused by permission updates.
