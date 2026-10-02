# First-class projects and bulk board download

Date: 2026-10-03. Status: implemented and validated in the worktree; production deployment pending.

## Confirmed user requirements

Build the project revamp before the account-wide download feature.

- Preserve the homepage project accordions and overall view. Do not add a new tab or page.
- Add a three-dot menu to each project: Share, Rename, Download, Archive, Delete.
- Share offers the same options as board sharing: restricted / anyone with the link, viewer / editor, and people added by email.
- New boards created in a project inherit its sharing options.
- A project link opens the homepage with that project selected in the filter.
- Project Download downloads all boards in that project.
- Project Delete is a backend soft delete.
- Preserve existing board sharing and avoid regressions elsewhere.
- Projects currently cannot be shared. The existing sharing design document describes intended behavior, not the current implementation.

Follow-up decisions confirmed by the user:

- Project sharing applies to existing and future boards, but the owner must be able to restrict individual boards, including making a board private inside a shared project.
- Project editors can create boards. Shared projects appear on recipients' homepages alongside their own projects; distinguish them with a UI indicator.
- Archive preserves links and editing, hides the project from the default homepage, and remains reachable through the existing filter.
- Project deletion disables all contained board links, including individually shared boards. Restore and retention details remain open.
- Explicit inheritance controls are accepted.
- For boards inside shared projects, replace the homepage card's hover Share action next to Delete with a privacy/inheritance action that toggles between making private and restoring project access. Keep the accordion layout.
- Only the project owner can change board privacy/inheritance or delete boards. Editors can create/edit boards; editor-created boards remain owned by the project owner.
- Make private removes existing individual invitations and public links, with confirmation explaining the access loss.
- Archive is a personal UI preference: it affects only the user archiving the project, including for received shared projects. It does not change project access, editability, or anyone else's homepage.

UI review requirements, confirmed before manual sharing testing:

- Use vertical three-dot triggers; dropdowns must allow app body scrolling.
- Reuse the board sharing component for projects, with project actions and links. Retain fetched sharing policies so opening the modal does not reload permissions.
- Polish Rename and Download to match sharing; reflect a saved project name immediately on the homepage.
- Reuse homepage filter checkbox spacing for multiple export formats. Name the ZIP after its project and reserve status space to prevent download progress/results changing dialog height.
- Include canvas background in image exports to prevent transparent PNGs appearing blank.
- Polish the archived filter. Selecting it shows archived projects; their Archive action becomes Unarchive.

Account-wide download answers, explicitly supplied by the user:

1. Download boards the user owns; exclude boards merely shared with them. Do not assume projects already support sharing.
2. Include both local-only and cloud boards.
3. Offer a dropdown with multiple checkboxes for all supported formats.
4. Include unsynced local edits.
5. Allow a partial download, list failures, and provide retry.

The earlier placement recommendation is Settings → Account → Your data, below the profile card. This placement is a recommendation, not a separately confirmed requirement.

## Recommended homepage details

Keep the count next to the project name; retain Last edited on the right, followed by the accordion control and the three-dot menu. On narrow screens move Last edited below the name. This keeps identity/count together and avoids crowding the action controls.

The accordion toggle and menu trigger must be sibling buttons. Current `GroupHeader` is a single button containing the whole row; nesting a menu button inside it would be invalid and could toggle the accordion unexpectedly. Preserve keyboard expansion, focus, and accessible labels.

Calculate Last edited from the maximum board content timestamp, independent of the selected sort. Current code uses `groupBoards[0]`, which can be oldest or alphabetically first. Decide whether counts describe all project boards or filtered results; recommend total count, with matched/total when searching. Keep project rename/sharing timestamps separate from board content timestamps.

Empty projects currently disappear from the normal home grouping. Show an empty accordion so its menu remains reachable, subject to the current project filter and search semantics. Reuse the current create-board flow with the project preselected.

Personally archived projects can be reached by an additional choice in the existing filter, without a new page/tab. Use Unarchive in the menu for projects archived by the current user. Owners, editors, and viewers can archive/unarchive their own view; these actions never mutate the shared project.

Keep owned and shared projects in the same accordion layout. Add a small people icon and Shared badge to projects owned by someone else, with owner attribution and the recipient's Viewer/Editor role available in the header or tooltip. Label owned projects shared with others as Shared by you where needed, so outgoing sharing is not confused with received projects. Extend the existing filter with Owned by me / Shared with me rather than adding navigation. Persistent homepage membership should come from accepted email/UID membership; simply visiting a public link should not permanently add the project without an explicit add action. This membership detail is proposed, not yet confirmed.

## Industry comparison and revised access recommendation

Checked official documentation on 2026-10-03. There is no single universal behavior:

- [Figma file and folder permissions](https://help.figma.com/hc/en-us/articles/35361119554711-File-and-folder-permissions): individual files cannot disable roles inherited from their folder. Folder inheritance can be changed on specified plans. File audience settings are independent, but do not remove inherited individual roles.
- [Miro board access](https://help.miro.com/hc/en-us/articles/4408888726290-Who-has-access-to-my-board): the highest access across sharing levels applies. [Making a board private](https://help.miro.com/hc/en-us/articles/360021095159-Make-a-Miro-board-private) requires removing all sharing levels; for shared spaces it advises moving the board out or unsharing the space.
- [SharePoint unique permissions](https://support.microsoft.com/en-us/sharepoint/lists/sharepoint-sharing-and-permissions/customize-permissions-for-a-sharepoint-list-or-library): documents/items can stop inheriting from their parent and use independent permissions. Microsoft supports this but recommends ordinary group-based management where practical.

Recommend explicit inheritance controls, using the independent-permission pattern to satisfy this app's confirmed requirement:

- Inherit project access (default): compose current project grants and direct board grants by the highest allowed role.
- Custom board access: ignore project sharing grants; allow the project owner plus the board's direct invite/link policy. This permits lower roles for selected project members and excludes everyone else.
- Make private: an explicit owner action that atomically disables inheritance, removes direct invitations, and disables public links. Owner retains access. Do not equate disabling inheritance with owner-only access if older direct grants remain.
- Restore project access: explicit owner action to resume inheritance; explain that this may broaden access. Direct board grants remain separately managed unless explicitly removed.

Project ownership and deletion checks always apply, including to custom/private boards. A project editor cannot change access, re-enable inheritance, or make their own created board private unless the product separately grants that management power. Creator identity is attribution; ownership remains with the project owner under the recommended model.

Private boards must disappear entirely for unauthorized recipients: no name, preview, ID, last-edited contribution, count contribution, download entry, or search result. Counts and Last edited must be computed from boards readable by the viewer. Authorized listing must filter server-side; fetching everything and hiding cards in React would leak metadata. Restoring project access must not silently discard direct grants.

The board inheritance flag is authoritative server-managed policy and must be honored by Firestore, Storage, RTDB, live listeners, previews, listing, and export. Changing it needs the same revisioned revocation flow as direct sharing. Retain independent grants when converting existing boards; existing boards default to inheritance unless the owner chooses an exception, and exceptions survive subsequent project-policy changes.

### Board-card privacy action

Accepted placement: replace hover Share beside Delete for boards inside shared projects. Proposed precise labels: Make private for inherited or custom-shared boards; Use project access for owner-only private boards. The second action restores inheritance, not historical invitations/public links. Keep full custom sharing controls in the board editor Share dialog and retain the existing card Share action for boards outside shared projects.

Show privacy and board-delete controls only to the authorized owner; editor creation does not imply permission-management or deletion rights. Enforce this server-side as well. Keep a persistent lock indicator on private cards and ensure hover controls also appear on keyboard focus and touch. Make private requires confirmation explaining that direct invitations/public access will be removed. Explain that Use project access grants the current project audience access; a separate confirmation for restoring inheritance remains a proposal.

Treat this as an asynchronous action with pending/failed states, not an optimistic visual switch. Do not claim privacy before authorization changes complete across stores. On failure, show the committed state and offer retry. Revocation disconnects affected live editors and rejects queued writes; preserve uncommitted edits as local recovery data. Privacy does not retract bytes already downloaded.

## Product decisions still open

These are proposals, not accepted user decisions:

- Recommend only the owner can share/manage the project, rename, delete the project, or manage direct board grants. Owner-only board privacy/deletion and editor board creation/ownership are confirmed. Personal archive/unarchive is available to each user independently of project role.
- Project deletion blocks all contained board links. Confirm the restore/retention policy; do not implement physical purging until specified.
- Readable boards remain downloadable unless the product explicitly introduces a download restriction. Account-wide export still includes only owned boards.
- Recommend including archived owned projects in account-wide download, excluding deleted content by default; confirm scope.
- Determine the supported format list from the installed editor/export capabilities. Do not promise PDF or other formats without implementing and validating them. The checkbox dropdown must keep selections open, prevent an empty selection, and report per-board/per-format failures.

## Current architecture and consequences

### Storage and identity

`packages/storage/src/index.ts` defines a project owner and a members array, but Board has no independent owner field. UI commonly derives board ownership from the project. This is adequate while only the project owner creates boards; shared-project creation requires an explicit invariant: project owner owns child boards, and creator identity is separate attribution. If independently owned child boards are desired, that is a larger model change.

Local RxDB uses one fixed database name, without an account namespace. Workspace lists are not filtered by active owner. Signing out stops listeners but does not clear/isolate local content. Before adding shared-project caches and owned-board export, isolate account workspaces and query caches; guard in-flight downloads/sync with an activation generation and captured identity. Keep guest/local data separate and explicitly claim it only during the appropriate sign-in flow. Never upload a cached collaborator project into the recipient's own user namespace.

The project schema is version 0 and has no delete state, revision, durable pending operations, or conflict metadata. Introduce an additive schema migration with safe defaults for existing projects, plus cloud normalization for legacy documents. Store personal archive preferences separately, keyed by user and project ID, rather than as shared project state. Legacy localStorage import also reuses the project schema and needs compatibility coverage when that schema changes. Do not interpret the currently unused members array as an enforced access policy.

### Private and shared persistence

Private cloud content is at `users/{ownerId}/projects/{projectId}/boards/{boardId}`. Shared scenes/config live separately at `boardShares/{boardId}`. The editor prefers a readable share scene and reconciles it with a local private scene. Project members cannot currently read the owner's private namespace; workspace sync downloads only the signed-in user's projects.

Add server-controlled project sharing metadata and an authorized project board listing with minimal metadata. Retain board IDs and existing board URLs. Bind each board to its real project/owner server-side, including legacy board share documents, with a validation/backfill strategy. A direct board share must not expose the parent project name, other board IDs, or project membership.

Do not turn project sharing into client-side copies of the project ACL into every board's collaborators map. That loses grant provenance and makes revocation partial. Keep direct board policy and inherited project policy separate; evaluate project grants only when the board's inheritance setting permits them. Owner access and parent deletion gating always apply.

For the initial rollout, retain `boardShares` as the durable shared scene path to preserve collaboration behavior. Provision missing shared scene documents/assets through a resumable server-coordinated process, using the owner's current local scene when unsynced edits exist. Keep project publication pending until its existing board listing/scenes are ready; show failures and retries. New-board creation must establish the parent binding and inherited access even when created through MCP or from another device. Offline creations remain local pending publication, with visible status. Avoid a second independent shared scene store; centralize scene load/save and reconcile policy so private sync, shared edits, previews, and export agree on scene freshness.

### Authorization across three stores

Firestore rules currently restrict private project reads/writes to the namespace owner. `boardShares` rules only understand direct board policy. Storage rules also consult only direct `boardShares` policy. RTDB consumes a separately mirrored `boardAccess` policy. Updating only React or Firestore would leave images, live editing, presence, and compaction inconsistent.

Introduce one effective-permission module used by UI and backend, with matching rules tests for Firestore, Storage, and RTDB. Separate project ownership actions from board editing. Store authoritative parent bindings and check project lifecycle on every child access. Preserve direct board grants independently. Provide server-authorized project discovery/listing without enabling public enumeration of private projects or boards.

For RTDB, prefer separately revisioned direct-board and project policies plus a server-controlled board-to-project binding and inheritance flag, evaluated together by rules. This avoids rewriting every child ACL on project permission changes and supports private exceptions. If access is materialized per board instead, the implementation needs an explicit revocation barrier and resumable reconciliation; eventual fan-out alone is insufficient. Cross-store writes are not one atomic transaction: restrict access first during revocation, publish grants only once authorization dependencies are ready, and reject historical policy revisions. Show pending/error states until completion.

### Existing sharing defects that must be addressed

These are source-inspection findings, also documented in `docs/security-audit-2026-10-02.md`; this planning pass did not rerun emulator reproductions.

- `saveShareConfig` merges collaborators maps, so removing one key can retain the old persisted grant. Replace the map atomically or delete the field explicitly, and ensure write permission requires a valid current membership.
- `accessPolicyFromConfig` uses raw email keys, which are incompatible with RTDB key restrictions. Prefer UID grants; handle verified-email invitations through a deliberate claim/normalization flow, without granting private access to unverified identities.
- Access mirroring blindly overwrites from trigger event snapshots, with no monotonic revision, allowing older grants to overwrite newer revocations. Use authoritative current policy plus transactional revision checks and retained deletion tombstones. Scene-only changes should not republish unchanged ACLs.
- Board share creation only checks the supplied owner UID, without proving ownership of the private board. Validate real ownership and immutable parent bindings server-side before creating policies.
- Share-dialog errors are only logged and Done closes even after failure; timeout reads become default restricted configs. Distinguish missing, denied, unavailable, and timed-out reads. Serialize mutations, show committed vs pending state, and never overwrite unknown policy with a fallback.
- Sharing modal derives owner identity from the current signed-in user. Shared-project recipients must see the actual owner; reusable sharing presentation must receive authoritative owner identity and scoped capabilities.

### Project links and discovery

`WorkspaceHome` currently redirects `/?projectId=...` to `/projects/$projectId`. Remove that redirect for the requested homepage-filter behavior. The existing app sign-in gate permits anonymous board URLs but blocks the homepage, including public project links. Add a narrowly scoped public-project mode that resolves the target's access before rendering; it must not expose the visitor's cached private workspace.

Recipients need authorized loading of the target project and its board metadata; setting a filter on their own workspace is insufficient. Handle restricted links with sign-in/access-denied states, and missing/deleted targets without leaking details. Opening a public project must not import it as owned content or claim it during authentication. Unrelated home search/sort state must not make a shared link appear empty unintentionally.

### Lifecycle, sync, and stale clients

`syncWorkspace` writes whole project documents with `setDoc`; dirty project IDs are only in memory. A remote update can blindly overwrite a pending local project change, or a stale whole-document write can overwrite new lifecycle/access fields. Persist project operations/revisions and use server-controlled lifecycle transitions with conditional metadata updates. Sharing/lifecycle fields must not be writable through ordinary scene sync.

Represent active and deleted project lifecycle explicitly, with deletion time/actor and revision. Archive is separate personal presentation state, not a lifecycle/access gate. Persist it in user-scoped preferences with a local cache; recommend syncing the preference across that user's devices without ever changing another user's view. Archived projects remain editable, accessible through links and the existing filter, and eligible for export; archiving must not unsubscribe active editors or revoke access. Losing access or project deletion still takes precedence over any personal preference.

Gate child operations by parent deletion state immediately instead of relying on per-board deletion fan-out. Deleting a project must deny shared/direct board reads/writes, asset fetches, RTDB editing, and compaction writes. Preserve board IDs, assets, history, and individual board deletion state for a possible restore. Retain a deletion tombstone so stale devices/triggers cannot recreate the project or reopen grants. Late cleanup jobs must be generation-aware.

Current active-board listeners convert removed query results to inactive boards but can merge dirty local scenes back instead of applying deletion. Deletion/lifecycle must take precedence over scene reconciliation; preserve unsynced work as a recovery copy rather than resurrecting a deleted remote board. Stop listeners and retries for inactive/deleted targets, and guard late listener completions with generations. Check the same lifecycle rules in create, duplicate, rename, save, and MCP operations. Board-only soft deletion must continue to work independently.

### Homepage freshness and scale

Workspace query uses a global key with infinite stale time; cloud subscriptions update RxDB without a general query invalidation event. Make workspace queries react to local metadata updates and scope keys by account/access context. Parent rename/state/access must update board breadcrumbs, previews, create-project selectors, and open editor capabilities. Empty projects need menus even without boards.

Do not attach full-scene listeners or eagerly fetch every image just to show a shared project accordion. Use paginated lightweight board metadata and lazy scene/assets loading. Large project publication, migrations, and lifecycle reconciliation need bounded batches, checkpoints, retries, and idempotency. Monitor permission-check overhead and payload sizes using real project sizes before selecting limits.

### Bulk export

Create a shared export module for project and account scopes. Enumerate authorized boards, de-duplicate by stable ID, read a stable per-board scene snapshot, preserve pending local edits, and reconcile with the canonical durable shared scene and relevant live deltas. Do not export only the local workspace cache: collaborators may have newer content, and a fresh device may not have all scenes. Flush pending saves in the initiating editor when applicable; another offline device's unsynced edits cannot be included.

Keep export read-only: it must not publish local data or change sharing. When versions conflict, preserve recovery variants or identify incomplete/conflicted boards rather than silently discarding work. Hydrate image bytes using authorized Storage reads and validated cache scope. Package selected formats into a ZIP with safe names, stable ID suffixes for duplicates, project folders, and a manifest recording scene revisions/times and per-board/per-format errors. Editable exports must be self-contained, not depend on private Storage paths.

Bound fetch/render concurrency and memory; render boards without navigating through the editor; support cancellation/progress and retry failed items only. Visual formats can fail due to missing assets, fonts, dimensions, or browser rendering limits. Do not label incomplete output as complete. Permission revocation/deletion during an export must stop subsequent unauthorized reads; already downloaded bytes cannot be retracted. Scope snapshot consistency per board and report capture times rather than promising an atomic snapshot across all live boards.

## Proposed delivery order and regression gates

1. Resolve open product semantics. Lock ownership, inheritance, editor powers, and lifecycle invariants.
2. Fix the relevant sharing defects; introduce permission composition, account isolation, migrations, and persistent project metadata operations.
3. Implement project metadata/lifecycle and the accordion menu, including rename, archive/unarchive, soft delete, empty projects, and freshness.
4. Implement project sharing, publication/new-board inheritance, authorized listing, and homepage-filter links. Preserve direct board sharing throughout.
5. Implement the shared multi-format export module and Project Download.
6. Add account-wide Download under Settings → Account → Your data using the same export module.

Validate before release using Firebase emulators plus browser/MCP integration coverage:

- Existing restricted/public viewer/editor board links, images, collaboration, presence, undo, rename, and board soft deletion.
- Project and board role combinations, direct grant preservation after project revoke, ordinary invited emails, failed policy writes, out-of-order mirrors, and ownership spoof attempts.
- Private/custom board exceptions within public and restricted shared projects; no unauthorized metadata/count/preview/export leaks; owner-only privacy transitions; restored inheritance; existing direct grants retained unless Make private explicitly removes them; later project updates preserving exceptions.
- Shared projects visible on recipients' homepages with correct owner/role badges; editor-created boards inherit policy and remain owned by the project owner; removing membership removes homepage access unless another valid project grant applies.
- Existing/future/empty project boards, owner/editor/viewer creation, local pending publication, and board-only visitors unable to enumerate parent/sibling data.
- Anonymous/public and signed-in/restricted project links, homepage query navigation, refresh, and sign-in transitions.
- Archive/unarchive and project deletion across direct links, Storage, RTDB, live editors, stale offline devices, queued saves, and compaction.
- Owner/editor/viewer personal archive independence: archiving by one user leaves all others' homepages and all sharing unchanged; unarchive/filter/direct links work; account switches isolate preferences; personal archiving never grants access to revoked/deleted projects.
- Reloaded pending project changes, two-device rename/delete races, account switches, local claims, and migration of existing/legacy databases.
- Multi-format export with local-only/cloud/unsynced/live scenes, duplicate names, embedded images, missing assets, failed formats, partial results, retries, cancellation, large projects, and permission changes mid-export.

The architecture sections above preserve the original planning analysis. The implementation and release requirements are recorded below.

## Implementation and release requirements

Implemented the existing accordion menu, shared/owned role badges and filters, personal archive preferences, owner-only privacy controls, shared editor creation/editing, project links on the homepage, and soft deletion. Board count stays next to the name; last edited remains on the right. Existing direct grants compose with project access unless a board explicitly disables inheritance. Making private clears all direct grants with confirmation.

Account download is under Settings → Account → Your data. Both scopes use the same read-only export pipeline with `.excalidraw`, SVG and PNG checkboxes, embedded image bytes, live RTDB changes, local pending edits, cancellation, per-format failures and retry. ZIP output includes capture times and failures in a manifest. Exports are consistent per board, not an atomic workspace snapshot; they cannot include unsynced edits from another device. Rendering is serial, PNG dimensions are capped at 8192, and uncompressed archive content is limited to 256 MB.

Policies are managed by owner-validated callables. Firestore policy revisions and pending gates coordinate monotonic RTDB projections; Firestore and Storage evaluate the current parent policy directly. Deleted policies remain tombstones. A failed sharing read disables saving; cloud policy mutations require connectivity. Recipient scenes are fetched only for visible previews and opened/exported boards, never included in project listings or imported as owned local data. Local queries and preview caches are scoped to the current identity.

### Deployment order

This change has **not** been deployed to production. Deploy the new Functions using the configured `SYNC_ACCESS_FUNCTION_REGION` and `FIRESTORE_FUNCTION_REGION` first. Build Functions and run `pnpm --filter @agentic-whiteboard/functions backfill:access` against the intended Firebase project with explicit Admin credentials/database configuration before switching RTDB rules. The backfill binds legacy board shares to verified private parents and upgrades access projections. Check unbound legacy shares manually; do not infer ownership from a client-supplied project ID. Then deploy all three rule sets and the frontend together. Old clients cannot create or mutate sharing policy under the new rules; prompt an app refresh during rollout.

Deletion retains private documents, share policy tombstones, history and assets; no retention purge or restore UI is introduced. Shared-home metadata currently refreshes every ten seconds. Listing and initial publication process all boards in a project; very large workspaces need pagination/checkpointed publication before claiming support at scale. Do not delete policy tombstones with an administrative cleanup job.

### Repeatable validation

Run `pnpm test:e2e:projects` with Firebase CLI, Java and Chrome installed (`CHROME_PATH` can override the executable). The runner compiles Functions, creates/restores local demo region parameters and uses the demo-projects Auth, Firestore, RTDB, Storage and Functions emulators on dedicated ports. Production Firebase requests are blocked in the browser. Puppeteer exercises UI interactions and real network requests; Admin SDK assertions inspect stored policies and retained records. Results, captured network responses and failure screenshots are written under `logs/projects-e2e/`.

Validation passed: 19 Puppeteer browser/network scenarios via Firebase CLI, `pnpm build`, `pnpm check`, `pnpm lint` (four pre-existing warnings), 17 collaboration edge-case tests, the existing project dropdown E2E and local image persistence/reload. The local image test used a separate port because another task occupied its default port. The emulator runner isolates both ports and temporary Storage files from concurrent tasks.

### Dev preview deployment

On 2026-10-03, the feature Functions and Firestore/Storage/RTDB rules were deployed to `open-excalidraw-dev-2`; production remains unchanged. The manual preview runs on `http://localhost:5174` with the existing ignored dev configuration and real Google sign-in. The public discovery callable smoke check returned successfully.

The dev backfill inspected 61 existing board-share records: five were bound to private project/board documents, while 56 had no matching private parent and were preserved without inventing ownership bindings. Their direct grants remain projected; management through the new owner-validated callables requires a genuine private parent. Backups and migration diagnostics are kept in ignored local logs. These legacy records need separate data cleanup before claiming the entire dev dataset has valid ownership links.
