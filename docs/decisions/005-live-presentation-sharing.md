# ADR 005: Render presentations from live authorized boards

- Status: Accepted
- Date: 2026-10-09
- Supersedes: [ADR 004](004-presentation-only-sharing.md)

## Context

Snapshot publishing made a simple permission change or Copy action perform capability checks, scene synchronization, slide rendering, uploads and publication. Temporary access synchronization also interrupted the owner's canvas. The user explicitly accepts exposing off-slide content to presentation recipients, so a separate snapshot boundary is unnecessary.

## Decision

Presentation is a board, project and invitation role. Resolve the strongest applicable grant: owner, editor, viewer, presentation. Board overrides disable project inheritance; deletion and pending access synchronization still block recipients. Owners remain authorized during pending synchronization, using an explicit active-owner projection that does not bypass deletion.

A sharing change performs one policy mutation and consumes its committed revision. The server rejects stale revisions and invalid roles, and treats an identical committed policy as an idempotent no-op. Conflicts refresh the dialog policy rather than resubmitting stale collaborator maps. Copy performs only a clipboard write and never changes permissions or publishes content.

Presentation recipients read the existing authorized board scene and assets, but cannot edit. Ordinary board links resolve the role and mount the presentation start screen. The presentation route uses the same data subscription and slide renderer. No published manifest, page endpoint or PNG upload is required. Rendering retains the previous image until its replacement is ready, caching slide renders and warming small decks or nearby slides for larger decks.

Starting presentation opens the existing audience and speaker windows. Speaker notes are view-only. Notes authorization permits editors/owners and recipients with an applicable Presentation grant, including inherited project access; plain Viewer grants remain insufficient. Presentation UI does not join editor collaboration or publish presence.

Register board access independently when private boards are published. Repair legacy missing registrations through the explicit backfill script, outside Share and Copy actions. Registration must preserve existing sharing grants.

## Alternatives considered

- Immutable published slide snapshots: rejected because their privacy benefit is no longer required and they add request/render/upload waterfalls.
- Removing synchronization gates entirely: rejected because recipients could retain access during a partially applied permission change.

## Consequences

Presentation recipients can obtain the complete board scene, including off-slide content. This is explicitly accepted. Live board changes appear without republishing. Browser restrictions require a Start gesture for popup/fullscreen, with retry controls when blocked. A permission change can still require network latency and server-side projection writes; Copy does not wait for them.

Roll out the frontend with updated manageBoardAccess, manageProject, slideNotes, boardAsset, publishProjectBoard and access mirror/synchronization functions, plus Firestore, Storage and RTDB rules. Build functions before deployment. Existing snapshot functions are unused by this frontend and can be retired separately. Run legacy registration repair only for the intended environment. These changes were tested with demo emulators and deployed to development on 2026-10-09; production and hosting were not deployed.

## Verification

The final Chrome/demo-emulator runs passed all three sharing/presentation regressions and 37 project browser/network scenarios. Board permission changes issued one manageBoardAccess call, project changes issued one manageProject call, and Copy issued zero callable calls. Project unchanged selections, invalid or duplicate invitations and Done also issued zero calls. Owner canvas continuity, inherited presentation access, separate audience/speaker windows, read-only notes, stale revisions and deletion were exercised. Slide model/cache and asset authorization tests passed. Workspace build, TypeScript and lint passed; lint retains four existing warnings. This is focused validation, not a claim that the entire application test suite was rerun.

## Share UI and development follow-up

The Slides header and board header open the identical board Share modal. Copy Link always copies the ordinary board URL; authorization selects the recipient UI. The dropdown displays Present while its persisted role remains presentation. The help popover explains notes and live updates; Escape closes help without dismissing Share. Presentation-access boards use the same header-free app layout as the explicit presentation route.

Chrome DevTools MCP inspection reproduced HTTP 403 on documents:commit with the previously deployed development rules in an isolated demo emulator. Those rules denied owners during pending synchronization and excluded presentation from public board reads. With current rules, the same owner commit returned 200. Subsequent UI permission changes made one manageBoardAccess request and zero scene commits; Copy made zero callable requests and zero scene commits, with the same owner canvas remaining mounted. The recipient board URL opened Start presentation and a separate speaker window with read-only notes. General access, invitations (including Present), unchanged selections, Copy, Done and project inheritance passed all 37 project browser/network scenarios; three focused sharing/presentation suites also passed.

Development rollout on 2026-10-09 succeeded for manageBoardAccess, manageProject, listSharedProjects, createProjectBoard, publishProjectBoard, syncBoardAccessToRtdb, mirrorProjectAccess, mirrorBoardAccessToRtdb, boardAsset and slideNotes, plus Firestore, Storage and RTDB rules. Development function regions remain us-central1 and the existing ASSET_ENFORCE_APP_CHECK=false setting was preserved. Firestore, Storage and RTDB rule sources match local after deployment. Frontend changes are in this worktree; hosting and production were not deployed. Existing snapshot functions were not deleted. No broad legacy-registration backfill was run.
