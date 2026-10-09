# Board and project sharing audit — 9 October 2026

> Historical diagnosis before the fixes. The implementation now follows [ADR 005](../decisions/005-live-presentation-sharing.md): permission changes make one mutation, Copy makes zero calls, and the owner canvas remains mounted. The regression previously failing below now passes. Generated request traces contain the latest fixed run. Project coverage now passes 37 scenarios. The backend and authorization rules have since been deployed to development; frontend changes remain in the shared-sidebar worktree.

## Finding

The requested flow is straightforward: save a permission once, resolve the recipient's effective role, and render the appropriate board UI. The implementation currently combines permission changes with publishing a separate presentation snapshot. Copy link is therefore an expensive mutation, not a clipboard operation. That coupling is the principal mistake.

This audit makes no application or deployed-policy changes. It adds browser request instrumentation and an explicit failing regression reproducer. Tests use isolated demo Firebase resources; the user's development board and its sharing policy were not modified. The existing Chrome modal was inspected read-only. Development Cloud Run request logs were also measured.

## Measured evidence

- `node tests/run-regression-tests.mjs --test=sharing-flow-audit.test.mjs` drives actual modal clicks in headless Chrome against real emulated callable endpoints and security rules. It fails on the intended contract: **Copy link should make zero API calls; actual 8, expected 0** for an unchanged two-slide presentation.
- The first publication and a second Copy both invoked the same eight calls. Request timestamps and durations are in `.system_generated/sharing-slide-browser-audit.json`.
- A DOM observer detected removal of the Excalidraw canvas during sharing changes. The modal survived, but the canvas did not. Counts include individual DOM removals, not a claim that each removal represents an independent complete reload.
- Development Cloud Run logs contain 14 recent successful `manageBoardAccess` POST requests: median **542 ms**, minimum **123 ms**, maximum **1,594 ms**. These are server request durations, not browser click-to-completion times. They include capability probes and mutations; the log does not identify their request bodies.
- Additional recent development POST logs: `presentations` median **301 ms**, maximum **1,007 ms** (52 requests); `slideNotes` median **228 ms**, maximum **791 ms** (30 requests). Serial service work across these calls adds up before network round trips and rendering.
- Functions and RTDB are in `us-central1`; Firestore is `nam5`. A distant datastore-region mismatch was not found. US network round trips, browser work, and multiple serial calls add to the user-visible wait. Cold-start contribution was not separately measured.
- Request bodies in audit output retain only the operation/action, not authentication tokens, drawings, images, notes, or invitation emails.

## Exact presentation request chain

For `N` slides, choosing Presentation or copying an existing Presentation link performs **2N + 4 callable POSTs**. This excludes Firestore/RTDB listeners, CORS OPTIONS, authentication refreshes, workspace synchronization, and asset hydration.

| Order        | Endpoint / operation               | Current reason                                                                          | Needed for a simple permission change or Copy?                                          |
| ------------ | ---------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1            | `presentations / capabilities`     | Ensure the deployed snapshot backend supports notes                                     | No per-action probe; reject unsupported input in the mutation itself                    |
| 2            | `manageBoardAccess / capabilities` | Avoid an older backend silently treating Presentation as Viewer                         | No second RPC; strict role validation belongs in the mutation                           |
| 3            | `manageBoardAccess / share`        | Write public Presentation policy and disable project inheritance                        | One write only when the user actually changes access; never on Copy                     |
| 4, per slide | `slideNotes / read`                | Read editor-only notes for the published snapshot; a dirty local draft can replace them | Not on permission changes or Copy; load notes when the authorized presenter needs them  |
| 5, per slide | `presentations / write-page`       | Render PNG locally and upload it with notes                                             | Only necessary for the current snapshot model; unnecessary for rendering the live board |
| Last         | `presentations / publish`          | Atomically switch to a completed snapshot revision                                      | Only necessary for snapshots; unnecessary in the requested live-board model             |

Two slides: 8 POSTs. Six slides: 16 POSTs. Rendering, notes reads and uploads execute serially across slides. Cached sidebar previews do not avoid this rendering/upload loop.

`ShareModal.handleCopyLink()` directly invokes `handleGeneralRoleChange('presentation')`. That handler intentionally does not skip an unchanged Presentation role. Each Copy generates a new revision and performs all work again. Even if publication later fails, access may already have changed. Clipboard failure can also occur after publication succeeds.

Every board policy save also awaits `workspaceApi.flushCloud()` before the permission RPC. The scene is stripped from the RPC payload, but this flush can still synchronize drawing data and unrelated pending workspace changes. It is not necessary for updating an already-existing board's permission.

## Why the board behind the modal refreshes

`mutatePolicy()` performs four serial stages:

1. Firestore transaction: store the new policy with `pending: true` and a new access revision.
2. RTDB transaction: mirror that policy with `blocked: true`.
3. Firestore transaction: clear `pending` if the revision still matches.
4. RTDB transaction: mirror the committed policy with `blocked: false`.

Firestore rules define a live policy as `pending == false`. That check precedes the owner grant, and parent pending state also gates child boards. A sharing change consequently denies the owner temporarily. Denied listeners terminate. `subscribeToSharedBoard()` reports denial and retries; `BoardEditor` renders AccessDenied/loading and removes the canvas, then rebuilds it after reauthorization.

The temporary gate prevents stale RTDB grants during permission changes. Its security purpose is valid; treating it as permanent owner revocation and unmounting the editor is not. Moving the modal outside the canvas kept publication state alive but only masked the canvas problem. Project policy changes can affect every open inherited board and even independently shared children through the parent lifecycle gate.

A single API call can still contain multiple database operations. Reducing browser calls does not remove the need to synchronize Firestore and RTDB safely.

## Board modal: General access flows

| Flow                                                  | Current callable mutations     | Findings / edge cases                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open modal                                            | Usually 0                      | Uses cached policy; cold open reads Firestore policy/parent. Opening should not publish anything.                                                                                                                                                                                                     |
| Restricted → Anyone with link                         | 1 `manageBoardAccess/share`    | Changes access immediately; currently flushes workspace and may remount canvas.                                                                                                                                                                                                                       |
| Anyone → Restricted                                   | 1 `manageBoardAccess/share`    | Removes the public grant, preserves explicit invitees and retained role.                                                                                                                                                                                                                              |
| Viewer ↔ Editor                                       | 1 `manageBoardAccess/share`    | Expected one write, with the same unnecessary flush and temporary denial.                                                                                                                                                                                                                             |
| Select unchanged Viewer/Editor or access              | 0 for independent boards       | Browser-tested. An inherited setting can deliberately create a board override even if its displayed value matches the parent.                                                                                                                                                                         |
| Viewer/Editor → Presentation                          | `2N+4`                         | Forces Anyone with link, turns inheritance off, then publishes. Validation that there are slides occurs after the policy write.                                                                                                                                                                       |
| Select unchanged Presentation                         | `2N+4`                         | Republish, not a no-op.                                                                                                                                                                                                                                                                               |
| Copy Viewer/Editor link in ordinary Share             | 0                              | Clipboard-only code path. The dedicated Share presentation entry instead intentionally invokes publishing.                                                                                                                                                                                            |
| Copy Presentation link                                | `2N+4`                         | Browser-confirmed unnecessary permission write, repeated notes reads and page uploads.                                                                                                                                                                                                                |
| Copy while Restricted with retained Presentation role | Republishes and changes policy | `handleCopyLink` checks role, not access; its role-change helper forces public access. Source inspection shows that this path can therefore reopen public sharing. This edge was not confirmed by a completed browser trace and requires its own regression check before changing the implementation. |
| Use project access                                    | 1 policy save                  | Restores inheritance; direct board invitations remain stored. A board-specific edit disables inheritance for the whole board, not just the changed user.                                                                                                                                              |
| Done after successful save                            | 0                              | Correct; changes are persisted immediately.                                                                                                                                                                                                                                                           |
| Done after failed save                                | Retry policy write             | `needsSave` retains the retry. Pending publication and permission persistence have separate failure states.                                                                                                                                                                                           |

Other failure cases: offline, expired authentication, unavailable capabilities, permission RPC failure, upload/notes failure, no slides, oversized slide/count limits, revoked access mid-publish, and concurrent policy changes. Missing capability preflight preserves the old role; a failure after the permission write does not roll back that role. There is no need for these snapshot-specific failure cases in a pure permission mutation.

## Board modal: People with access

| Flow                              | Current mutations           | Findings                                                                                                                                 |
| --------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Add valid new email               | 1 `manageBoardAccess/share` | Defaults to Viewer; updates the complete collaborator map.                                                                               |
| Add invalid/empty email           | 0                           | Local validation; browser-tested invalid email.                                                                                          |
| Add duplicate email / owner email | 0                           | No-op; duplicates are normalized.                                                                                                        |
| Viewer → Editor / Editor → Viewer | 1 `manageBoardAccess/share` | Browser-tested; requires the unnecessary workspace flush.                                                                                |
| Select existing person role       | 0                           | Browser-tested.                                                                                                                          |
| Remove person                     | 1 `manageBoardAccess/share` | Removes the explicit grant; public or inherited grants may still authorize the person.                                                   |
| Give a person Presentation        | Unsupported                 | Browser menu contains only Viewer, Editor, Remove access. Backend collaborator sanitizer also converts anything except Editor to Viewer. |
| Inherited person shown on board   | Read-only row               | Must change at the project or explicitly override the board. An override does not copy all project invitees.                             |

Verified email is required to claim invitations. Role precedence must distinguish removal of one grant from loss of all access. Owners cannot be removed via this menu; board privacy is owner-managed, while project editors can currently manage project sharing. These permissions should be preserved intentionally, not inferred from whether a button is visible.

## Project sharing

Project policy saves use `manageProject / share`, not the presentation API. Subsequent edits should be one mutation regardless of board count. The existing implementation already avoids republishing every board on each project-role change.

However, the first edit in a modal session prepares missing/legacy board policies: it enumerates local boards, reads policies, flushes workspace changes if needed, and sends one `manageBoardAccess/share` for each unregistered board, in groups of eight, before saving the project. This supports the present global `boardShares` lookup but puts migration work on a permission action. Newly-created board registration or a separate repair path should handle this instead.

The final project E2E run passed **36 browser/network scenarios**, including the added action-by-action audit, with no uncaught browser errors. The measured first public-share change on one unregistered board made `manageBoardAccess/share`, `manageProject/share`, and `listSharedProjects`. Subsequent role/access/invitation changes made `manageProject/share` plus `listSharedProjects`. Copy, invalid email, duplicate invitation, unchanged roles/access, and Done made zero callable requests.

After each successful project change `onComplete()` refreshes workspace metadata. `listSharedProjects` calls and `boardAsset/read` requests from newly visible thumbnails can appear in the network trace. They are listing and hydration work, not additional permission writes. The report records requests by browser identity so background refreshes on other test users are not mistaken for one click's required calls.

| Project flow                           | Current behavior                                                   | Required behavior                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restricted ↔ Anyone                    | One `manageProject/share`, plus first-use preparation if necessary | One permission mutation; inherited boards resolve the new role                                                                                       |
| Public Viewer ↔ Editor                 | One `manageProject/share`                                          | Keep this shape                                                                                                                                      |
| Public Presentation                    | Not offered                                                        | Add first-class Presentation policy and role resolution                                                                                              |
| Add / change / remove invitation       | One `manageProject/share` per actual change                        | Include Presentation alongside Viewer and Editor                                                                                                     |
| Invalid / duplicate / unchanged inputs | No policy write                                                    | Keep no-op handling                                                                                                                                  |
| Copy project link                      | Clipboard-only                                                     | Keep zero calls; opening the link is a separate read flow                                                                                            |
| Done after persisted change            | No write                                                           | Keep it                                                                                                                                              |
| Existing/future inherited board        | Viewer/Editor inheritance works                                    | A user whose effective project role is Presentation opens each board in presentation UI                                                              |
| Explicit board override                | Overrides project membership for that board                        | Preserve and clearly display this exception, or deliberately change the product rule if project Presentation must override all explicit board grants |
| Project deletion                       | Blocks boards, including direct shares                             | Preserve lifecycle denial and do not confuse it with transient policy synchronization                                                                |
| Revoke one invitation                  | Other public/direct grants can remain                              | Recompute effective access; never promise complete revocation when another grant survives                                                            |

Opening the current `/presentations/{boardId}` link reads a snapshot manifest and then slide pages; it never resolves a Presentation role on `/boards/{boardId}`. The latter currently denies a public Presentation user instead of opening the requested start screen. These are separate routes/data models today.

The current type `ShareRole` is Viewer/Editor. `ProjectPolicy`, visible-project/board types, frontend effective-role resolution, backend `policyRole`, RTDB access projections, Firestore/Storage rules, and asset authorization do not model a presenter. Merely adding a dropdown option would produce denial or accidental Viewer behavior. The published-presentation endpoint also checks board Presentation policy, not inherited project Presentation. There is no complete project Presentation flow today.

## Proposed simpler architecture

1. **One consistent role model:** owner, editor, viewer, presentation. Resolve verified-email, public and inherited grants consistently on the backend and frontend. Owner/editor grants should retain their stronger capabilities; users whose effective role is Presentation get presentation UI. Board overrides remain explicit.
2. **One permission operation:** save only policy fields through the board/project callable. Validate roles strictly and return the committed policy/revision. No feature probes, scene flushing, notes reads, PNG rendering or publishing in this action. Skip unchanged policies; reject stale revisions to prevent concurrent full-map saves losing invitations.
3. **Pure Copy:** derive the board/project URL and write it to the clipboard. It must not change access, retry a policy mutation, or publish content. Failed/unsaved permissions are shown separately.
4. **Presentation is a rendering surface:** load an authorized existing board and render its slide frames, showing a Start presentation with notes button. Starting uses the current audience/presenter two-window setup. Presenters cannot edit, navigate the unrestricted board, or join editing presence.
5. **Notes load when used:** authorize notes reads for presenters according to the explicit sharing policy; writes remain editor-only. Avoid one independent note RPC per slide on permission changes. Cache notes/previews and fetch relevant presentation data on entry/start.
6. **Project inheritance uses the same resolver:** a project Presentation user sees project board listings and enters each inherited board in presentation UI. Do not publish every child board. Test both existing and newly-created boards, custom board overrides, revocation and deletion.
7. **Keep the owner editor stable:** distinguish synchronization pending from real revocation. Preserve the mounted canvas during the owner's access mutation; avoid briefly blocking a still-valid owner in rules while retaining lifecycle/deletion checks and secure peer revocation. Do not simply remove the pending gate and allow stale RTDB writes. Parallelize independent authorization reads and avoid duplicate projection writes where safe.

A material choice: rendering the full underlying scene in the recipient's browser exposes that scene payload, including off-slide elements. Hiding the board UI cannot make downloaded elements private. The earlier snapshot design was intended to honor “no board read access.” If slide-only data privacy remains required, return a server-filtered presentation scene (slides + included elements/assets + explicitly shared notes) through one read surface. That still requires **zero Copy calls and one permission mutation**, and does not require publishing PNGs whenever access changes. Presentation UI restrictions and data isolation are separate requirements.

## Source map

- `apps/whiteboard/src/components/share-modal.tsx`: General access/People handlers; `handleCopyLink` at line 355; immediate save and retry semantics.
- `apps/whiteboard/src/features/slides/presentation-sharing.ts`: capability checks at line 16; serial snapshot generation at line 30.
- `apps/whiteboard/src/features/sharing/sharing-service.ts`: save/flush at line 131; denied-listener recovery at line 211; effective role resolution in `getSharedBoard`.
- `apps/whiteboard/src/features/workspace/project-actions.tsx`: first-save board preparation at line 90.
- `functions/src/project-access.ts`: role resolver at line 25; pending bridge at line 91; owner board-access mutation at line 228.
- `firestore.rules`: live/read policy and parent lifecycle gates at lines 10–21.
- `functions/src/presentations.ts`: published snapshots, page reads, transactional policy authorization.

## Reproducible checks and artifacts

```sh
node tests/run-regression-tests.mjs --test=sharing-flow-audit.test.mjs
SHARING_FLOW_AUDIT=1 node tests/run-projects-e2e.mjs
```

The first command is an explicitly selected diagnosis test and intentionally fails until Copy is fixed; it is not part of the default regression list. The project suite logs action-level request traces and normal functional results in `logs/projects-e2e/results.json` under `sharingAudit`.

Earlier broad runs hit browser bootstrap/navigation failures; the final serial run with corrected input clearing completed all 36 scenarios. The slide audit remains intentionally red on Copy, not on test setup.

Artifacts: `.system_generated/sharing-server-latencies.json`, `.system_generated/sharing-slide-browser-audit.json`, `.system_generated/manage-board-access-latency.json`, `.system_generated/development-database-locations.json`, `.system_generated/sharing-slide-audit-run.log`, `.system_generated/sharing-project-audit-run.log`, and `.system_generated/slides/sharing-audit-final.png`.
