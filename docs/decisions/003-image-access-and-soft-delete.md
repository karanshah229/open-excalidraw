# ADR 003: Authorize image bytes through a gateway and retain soft-deleted assets

- Status: Accepted
- Date: 2026-10-03

## Context

Firebase browser uploads automatically produced permanent download tokens. A signed-out request to the production verification image returned 401 without a token and 200 with its token, despite restricted board access. Using authenticated downloads inside the app did not remove that bypass. Images must follow current board access and the existing soft-delete policy without being uploaded again when their position changes.

## Decision

Use a Firebase callable `boardAsset` for image existence checks, uploads, and reads. The callable validates identity and current sharing policy, checks the source board/project tombstones, and uses the Admin GCS client. Production enforces App Check (`ASSET_ENFORCE_APP_CHECK=true` in its Functions environment); development/emulators explicitly set it to `false`. Invited users must have a verified email; public viewer/editor policies remain explicit. Clients receive bytes, never a download URL or token.

Storage rules deny direct image reads, metadata access, and writes, including for the owner. This prevents browser clients from issuing `getDownloadURL` or creating new token-bearing uploads. Existing image download tokens are revoked during migration. Snapshot paths retain their separate existing policy; this decision covers image asset paths.

An Admin-only `boardAssetLocations/{boardId}` document binds a board ID to its owner/project. New private uploads provide the project ID; legacy descriptors are resolved from the owner's projects. Sharing metadata uses the project feature’s authoritative `projectId`; `sourceProjectId` remains a legacy fallback. Each request checks fresh board/project records, so restoring an active parent restores access without copying its images. Missing indexed parents deny reads. Legacy standalone shared boards continue using their share policy.

Soft deletion retains immutable objects:

| Action                | State                                          | Image bytes                                         |
| --------------------- | ---------------------------------------------- | --------------------------------------------------- |
| Delete image element  | Excalidraw `isDeleted: true`                   | Retained for undo and history                       |
| Undo/restore image    | Clear the element tombstone                    | Reuse the same file ID/path                         |
| Delete board/project  | Parent `active: false` or nonempty `deletedAt` | Retained; gateway denies further reads/writes       |
| Restore board/project | Restore active state and clear `deletedAt`     | Gateway permits access under current sharing policy |

No retention timer, lifecycle purge, or permanent asset deletion is introduced. An individually deleted image remains readable to authorized active-board users because the editor needs its bytes for undo. This is a recoverable tombstone, not per-image access revocation. Access changes cannot erase bytes a browser already downloaded.

The integrated project-deletion callable persists the project tombstone in Firestore at `users/{uid}/projects/{projectId}`. Local-only deletion cannot affect remote access. It must use `active: false` or `deletedAt`; restoring a project must preserve independently deleted boards. Image access consumes the existing deletion workflow; it adds no permanent object deletion.

## Alternatives Considered

### Keep direct SDK downloads and revoke tokens on upload finalization

Rejected: asynchronous revocation leaves an exposure window and metadata reads can support token creation. The permission check must be unavoidable for image bytes.

### Expiring signed URLs

Rejected for this requirement: an issued URL remains usable until expiration, even after board deletion or permission revocation.

### Delete image objects immediately

Rejected: it breaks undo, history, and board/project restoration.

## Consequences

- An initial transfer incurs a callable and authorization reads. Base64 transport adds roughly one-third payload overhead; images remain limited to less than 10 MiB. Cloud Function cold starts can affect the first load.
- Matching immutable storage receipts skip all image calls during movement. Older local snapshots use a gateway existence check before uploading. Known bytes are reused for element-only updates.
- Permission enforcement lives in the server gateway rather than Storage rules, so emulator E2E tests must exercise both gateway permissions and denied direct Storage access.
- Deploy gateway, frontend, restrictive Storage rules, and token migration in that order for each explicit Firebase project. Existing tabs using the previous client need a refresh after the rule change.

## Validation

Run `pnpm check`, `pnpm --filter @agentic-whiteboard/functions build`, `node tests/image-access-policy.test.mjs`, `pnpm test:images`, and `pnpm test:images:cloud`. The cloud suite verifies actual mouse movement, metadata-only reload, image tombstones, private/shared board deletion, project deletion, restore without byte loss, and denied direct downloads/token creation. Record live rollout results in the image feature document.

## Client follow-up: blocked sync under a deleted parent

The development project-deletion deployment revealed a stale-client failure: an active locally cached board could still open under a cloud project with `deletedAt`, then retry image/sync requests indefinitely. In the confirmed P1 case, Project 121 was deleted in both its private and sharing records; the image gateway's denial was correct.

The client now persists `sync-blocked` for boards whose cloud parent has `active: false` or a nonempty `deletedAt`. This is distinct from a transient `sync-failed` retry. It retains local scene/image bytes, clears retry scheduling, and shows **Project deleted** with a read-only cached view. Deleted parents are omitted from the workspace list and their child-board subscriptions are stopped. A subsequent live project restoration, or restoration discovered after reload, requeues retained changes without clearing independently deleted boards' `active` flag.

Project metadata transactions create only missing private records and check existing tombstones; policy changes stay server-owned. Board transactions also check the parent; a permission-denied image request caused by a concurrent deletion is classified as blocked only after checking the actual project record. Cached blocked parent IDs prevent repeated full-workspace scans on ordinary project updates. No server deletion flag, permission, image object, or deployed rule was modified by this follow-up.

`pnpm test:sync:deleted-project` uses the Firebase emulators and a real editor to verify the blocked status/read-only view, no image gateway calls during a blocked save, no loss of the project tombstone, pending image bytes surviving reload, and successful upload/sync after restoring the generated test project's parent. The existing cloud image suite and all nine format tests also passed after the change.

## Integration with inherited project sharing

After merging the first-class project feature, the gateway also evaluates `projectShares` and its `pending`/`deletedAt` gates. Direct board grants and inherited project grants combine only while the parent is live and ownership agrees; a custom board override disables inheritance. A published scene may retain its private-root locator: authorized board/project recipients can read that object through the gateway, but only its owner can upload to the private namespace. New owner images use the private root for both private and shared saves, deduplicating concurrent uploads; non-owner editors use the shared root. Reusing the existing locator avoids copying bytes on sharing or the first image move. The immutable location index and source parent checks continue to gate reads after deletion.

Policy mutations use `manageBoardAccess`/`manageProject`. Image synchronization does not write policy fields or replace a newer scene with a sharing modal’s snapshot. The Storage snapshot policy preserves the project feature’s inherited grants, while image paths retain gateway-only access.
