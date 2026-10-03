# Freemium integration with first-class projects

The freemium PR merges `faea109` (Make projects first-class with inherited sharing and bulk downloads, PR #1) without replacing its project model. That commit makes sharing policies server-owned, resolves the highest role from direct and inherited grants, retains the original owner's private namespace for editor-created boards, and gates both databases during policy transitions. It also adds project management, personal archive preferences, bulk exports, legacy owner repair and scene-free cached discovery.

## Preserved behavior

- Project owners/editors manage sharing, rename and soft deletion. Board policy changes remain owner-only; Restricted and Use project access retain their existing semantics.
- Pending or deleted boards/projects deny access even with a direct invitation. Verified emails are required for invitations. Revisioned RTDB projections retain their ordering and duplicate-write suppression.
- Personal archives, filters, cached sharing dialogs, startup hydration, preview refresh, account isolation and editor project management remain in place.
- Bulk downloads retain private/shared/live edits, conflict copies, multipart ZIPs, cancellation and retries. Read-only export captures do not occupy live collaboration slots.
- Project soft deletion retains its data and quota usage. The freemium permanent-board deletion action removes its data and frees capacity as described by its confirmation dialog.

## Quotas layered on those operations

`commitCloudBoard` checks private project lifecycle and inherited roles. Sharing metadata uses `manageBoardAccess`; a compatibility `share-config` request delegates there, preserving its scene and Firestore/RTDB transition barriers. Shared saves, image reservations, live admissions and live element commits all resolve current board/project roles and charge the original board owner.

`createProjectBoard` checks the owner's board, document-storage and daily save limits in the same transaction as creating both private/shared copies. `prepareBoardAccounting` gives policy mutations and publication repairs the same owner accounting boundary. Owner outbox commits publish new inherited boards atomically with accounting for both copies, avoiding a successful private commit followed by a quota-denied publication trigger.

Abandoned-room compaction reads the latest canonical scene and parent gate inside the accounting transaction, merges deltas there, and prunes RTDB only after a successful durable commit. Deleted/pending parents retain deltas without recreating their scene.

`getCloudBoardElements` provides an authorized one-time export capture and rechecks access after reading. It preserves owner repair of legacy projections. Live RTDB subscriptions still require admission; snapshot export creates no session grant. Project calls use the same quota-event client as board saves so an owner quota rejection can raise the in-product alert.

## Validation

The existing project browser suite uses a manual Pro entitlement for its synthetic owner, allowing its feature fixtures to exceed three boards. Its editors remain Free. Freemium tests exercise Free owner limits separately, including concurrent editor creation, exact accounting for both copies, inherited saves/uploads/live edits, custom-policy revocation, pending/deleted parent rejection, verified invitation checks and slot-free export capture.

These integration changes have not been deployed to development or production. The earlier live screenshots demonstrate the feature before this merge; fresh emulator validation exercises the combined implementation.

Validated: `pnpm test:freemium` passes 25 server checks and its Chrome UI suite; `pnpm test:e2e:projects` passes all 35 existing browser/network scenarios. `pnpm check`, frontend build and repository lint pass (four existing lint warnings). The eighth new server regression verifies recovery merges against the latest canonical scene without losing newer cloud elements.
