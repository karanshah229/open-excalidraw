# Board version history: feasibility and recommended design

## Recommendation

Ship **server-authoritative, immutable checkpoints** first: create a version after a durable save has been idle for 30 seconds (with a 2-minute maximum during sustained work), on an explicit “Save version”, before restore, and when the final collaborator leaves. Keep the current board as the mutable head. A restore creates a **new** version from the chosen content; it never rewrites or deletes history.

Use a hybrid format only after the checkpoint release is stable: compact operation/delta batches between compressed full checkpoints (for example, checkpoint every 20 batches or when replay exceeds 2 MiB). Do not use the existing RTDB deltas as the version log: they are latest-per-element values, omit complete app state/assets, are pruned on solo downgrade, and are not an ordered durable operation stream. [collaboration service](../../apps/whiteboard/src/features/collaboration/collaboration-service.ts#L331-L420)

## What exists today

| Concern                   | Current behavior                                                                                                                                                                                                                                                                                                           | Implication for history                                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local/solo persistence    | Each changed scene is saved as a whole `BoardDocument` in RxDB/Dexie; its local `revision` increments. [storage model](../../packages/storage/src/index.ts#L19-L58), [save](../../packages/storage/src/index.ts#L321-L348)                                                                                                 | Add a local version index/cache so offline users can browse and restore their own versions immediately. Do not treat revision numbers as globally ordered history IDs.               |
| Cloud workspace sync      | Unsynced whole boards are transactionally merged using element-level LWW, then overwrite the cloud board. [sync](../../apps/whiteboard/src/features/workspace/workspace-api.ts#L102-L172)                                                                                                                                  | A history write must happen only after the authoritative cloud head commit; client-side “on change” capture creates duplicate, missing, or divergent versions during retries/merges. |
| Shared-board cold storage | A complete scene is also placed in `boardShares/{boardId}.scene` on normal saves. [sharing service](../../apps/whiteboard/src/features/sharing/sharing-service.ts#L81-L148), [editor queue](../../apps/whiteboard/src/routes/board-editor.tsx#L1098-L1127)                                                                 | There are two current durable-head paths. Versioning needs one canonical board-head service/schema, or a strict source-of-truth rule, before capture.                                |
| Live collaboration        | RTDB broadcasts changed element patches; dragging buffers writes, and the elements subtree is removed when a room downgrades to solo. [hook](../../apps/whiteboard/src/features/collaboration/use-collaboration.ts#L442-L484), [RTDB](../../apps/whiteboard/src/features/collaboration/collaboration-service.ts#L331-L420) | Take the version from the converged durable scene after a collab flush, never from presence/RTDB alone.                                                                              |
| Offline/concurrency       | Firestore is configured with multi-tab persistence; workspace sync merges remote/local elements. [Firebase setup](../../apps/whiteboard/src/lib/firebase.ts#L110-L131), [merge](../../apps/whiteboard/src/features/workspace/workspace-api.ts#L133-L165)                                                                   | Capture carries an idempotency key and `headRevision/contentHash`; the backend deduplicates retried/offline submissions.                                                             |
| Security                  | Current share rules permit broad editor updates to the mutable share document and have no history rule; Storage snapshot paths allow any authenticated user. [Firestore rules](../../firestore.rules#L13-L35), [Storage rules](../../storage.rules#L5-L12)                                                                 | Do not let clients write/delete immutable version payloads. Enforce current board ACL in a trusted backend, and grant list/read/restore separately.                                  |

The editor already debounces solo saves by 450 ms and flushes on visibility/page exit. [editor](../../apps/whiteboard/src/routes/board-editor.tsx#L1229-L1368) That is far too granular to equate every save with a user-facing version.

## Proposed data flow and data model

1. Client saves the mutable head as now, then sends `captureCandidate(boardId, committedHeadId, reason, idempotencyKey)` to a callable Cloud Function/Cloud Run API. The service reads/authorizes the canonical head, validates it is still the requested committed head, hashes and compresses it, writes an immutable payload to Cloud Storage, then writes a Firestore manifest. Retries with the same key return the existing version.
2. Manifest: `boardId`, random `versionId`, `parentVersionId`, server `createdAt`, `actor {uid, displayName}`, `reason` (`auto|manual|restore|pre-merge`), `headRevision`, `sceneFormat`, `contentHash`, `byteSize`, `storagePath`, `assetManifest/hash`, `label?`, `restoreOf?`, and a small diff summary. Never store the full scene in the manifest.
3. Payload: canonical Excalidraw scene including _all_ persisted app state, deleted-element tombstones as needed for fidelity, library/semantic extensions, and referenced asset IDs/immutable asset hashes. Existing assets should be immutable/content-addressed or copied by reference with a retained reference count; otherwise an old version can render incorrectly after an asset changes or is deleted.
4. Restore API: authorize editor/owner, load and validate the chosen payload, write it as a new mutable head through the same conflict/merge path, then append a `reason: restore` version. Warn and require a fresh conflict check if another collaborator committed after the preview was opened.

Cloud Storage is preferable for payloads: Firestore documents are limited to 1 MiB and large fields have indexing limits; exclude all large metadata fields from indexes if any payload/chunk remains in Firestore. [Firestore quotas](https://firebase.google.com/docs/firestore/quotas), [best practices](https://firebase.google.com/docs/firestore/best-practices)

## Solo and collaborative behavior

- **Solo/offline:** retain local checkpoints in IndexedDB, show “stored on this device” until cloud sync. Capture after the same debounce policy; queue idempotent uploads. A local restore works offline and becomes a new cloud version after sync. Clear disclosure: clearing browser storage loses unsynced local history.
- **Solo/cloud:** capture only the cloud-committed, reconciled head. A single authenticated user’s devices may converge through the existing LWW merge; capture the post-merge result and optionally label a pre-merge safety version.
- **Collaboration:** all editors see the same timeline, but only capture after a stable checkpoint/last-editor-leaves/manual save—not each RTDB patch. Aggregate participating actor IDs during the interval; keep the initiator and contributors in manifest metadata. Freeze preview mode (no RTDB writes), and restore with an explicit confirmation. Spectators/viewers can inspect only if policy grants it; they never restore.
- **Transitions/failures:** on solo→collab, flush and capture the common base before enabling RTDB; on collab→solo, flush the converged scene and capture before clearing RTDB. For network loss, do not create a “successful” cloud version until the backend ACK; retain a local pending marker.

## Retention, limits, and cost

Start with **50 automatic versions per board or 90 days, whichever is reached first; named versions are retained for one year; cap at 10 named versions for free accounts**. This is understandable, bounded, and does not promise infinite history. Apply pruning asynchronously: never delete the last known-good checkpoint, a restore target, or payloads under legal hold. Offer export before destructive retention changes.

Cost is usage/region dependent. The incremental monthly model is:

`captures × (manifest writes + payload writes) + timeline/restores × (manifest + payload reads) + retained compressed GiB-month + egress + backend invocations`.

Firestore bills document reads/writes/deletes, storage and network; its free allowance includes 50k reads/day, 20k writes/day, 20k deletes/day, 1 GiB stored, and 10 GiB/month egress. Firestore listeners also bill changed manifest documents as reads. [Firestore pricing](https://firebase.google.com/docs/firestore/pricing) Current displayed Standard rates in `us-central1` are $0.30/M reads, $0.90/M writes, and $0.10/M deletes; verify the deployment-region SKU before budgeting. [Firestore Standard](https://firebase.google.com/docs/firestore/standard-edition)

RTDB bills storage and downloads, not per write, so copying full boards to RTDB for history would amplify egress to every listener; it has a 1 GiB storage/10 GiB monthly-download free allowance, then $5/GiB-month stored and $1/GiB downloaded. [RTDB billing](https://firebase.google.com/docs/database/usage/billing) Cloud Storage payload pricing/operations must be added for the chosen bucket/region. Before committing a dollar figure, instrument p50/p95 compressed scene bytes, versions/active-board/month, list/restore frequency, and asset duplication rate; a 2 MiB board retained 50 times is roughly 100 MiB per board before compression/deduplication.

Firestore PITR/backups are disaster-recovery mechanisms, not a per-board product timeline: PITR begins retaining only after it is enabled, incurs separate billing, and restore targets a new database. [PITR](https://firebase.google.com/docs/firestore/enterprise/use-pitr), [disaster recovery](https://firebase.google.com/docs/firestore/disaster-recovery) Do not expose them as this feature.

## Decisions and edge cases to close before implementation

- Canonical head: consolidate `users/.../boards` and `boardShares` scene ownership, or define authoritative replication and capture only after it succeeds.
- Timeline permissions: can link viewers see it; can editors restore; does removing a collaborator revoke old-version access immediately? Recommended: current ACL governs read, owner/editor governs restore, history hidden from public links by default.
- Fidelity/migrations: version the payload schema; retain migrations/readers before shipping destructive Excalidraw or app-state migrations. Reject corrupted/oversize payloads and keep the prior head intact.
- Size/asset policy: max version payload, compression algorithm, image retention/deduplication, and behavior when an old asset is unavailable.
- Human semantics: manual labels, version comments, contributor attribution for anonymous users, timezone/display, and whether a restore creates a new board versus changes the current board (recommended: new head plus optional “make copy”).
- Operational safety: backfill is opt-in (no history exists before release), server-side auditing/metrics, rate limits per board, retry idempotency, orphan-payload cleanup, retention jobs, export/import, board deletion/ownership transfer, and restore-vs-live-edit conflict UX.

## Delivery sequence

1. Define canonical head + ACL and add backend capture/restore APIs with emulators and idempotency tests.
2. Add immutable Storage payloads, Firestore manifests, local pending/version cache, retention job, and telemetry.
3. Add timeline/preview/restore UX; test offline, two tabs, concurrent editors, collab transition, retries, revoked access, deleted boards/assets, payload corruption, pruning, and schema migration.
4. Measure actual payload/capture behavior, then decide whether hybrid delta replay is worth its operational complexity.
