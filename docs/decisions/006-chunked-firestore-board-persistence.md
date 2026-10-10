# ADR 006: Persist boards as versioned Firestore chunks

- Status: Accepted — storage approach, canonical scene location and secure commit protocol; tuning items remain open below
- Date: 2026-10-10
- Related: [ADR 002](002-storage-seam-and-local-indexeddb.md), [ADR 003](003-image-access-and-soft-delete.md), [ADR 005](005-live-presentation-sharing.md)

## Context

Cloud board scenes currently live inside individual Firestore documents, whose maximum size is 1 MiB. A board can exceed this through elements, freehand points, text and other persisted state even though image bytes already live separately. Firestore subcollections do not count toward the parent document's size. [Limits](https://firebase.google.com/docs/firestore/quotas), [size calculation](https://firebase.google.com/docs/firestore/storage-size)

The user selected solution B: split durable scenes across Firestore documents and preserve the existing local-first and collaboration flows. Do not make RTDB the mandatory edit/persistence transport for all solo boards.

**Stale whole-scene overwrites are an existing risk even with one chunk.** Alice editing X and Bob editing Y can lose changes if both overwrite a stale full scene. Chunking does not introduce this class of conflict; it adds coordination across chunk boundaries. One-chunk and multi-chunk boards must use the same revision and merge contract.

### Existing code and migration surfaces

| Surface | Current behaviour | Required change |
| --- | --- | --- |
| [Workspace storage](../../packages/storage/src/index.ts) | RxDB/Dexie stores a complete local `BoardDocument`; exposes `WorkspaceStore`. | Keep the assembled local document interface; isolate cloud chunking behind a persistence boundary. |
| [Workspace sync](../../apps/whiteboard/src/features/workspace/workspace-api.ts) | Reads private cloud boards, merges elements on revision conflicts, transactionally writes full documents. Workspace subscriptions hydrate scenes and assets for active boards. | Read/write committed chunk revisions; distinguish board metadata discovery from scene hydration and preserve existing offline queues. |
| [Shared scenes](../../apps/whiteboard/src/features/sharing/sharing-service.ts) | `updateSharedScene` and `syncBoardSceneToShare` write `boardShares.scene`; subscriptions consume it. | Use the same scene commit/load contract; shared writes need conflict checks rather than unconditional scene replacement. |
| [Editor](../../apps/whiteboard/src/routes/board-editor.tsx) | Serialises saves, journals drafts, flushes on lifecycle events and solo/collab transitions. | Preserve these behaviours; acknowledge the exact committed local revision and retain later pending edits. |
| [Collaboration](../../apps/whiteboard/src/features/collaboration/use-collaboration.ts) | RTDB streams latest per-element records and presence while live collaboration is enabled. | Keep live element reconciliation; use committed chunks as the durable base. |
| [Abandoned-room compaction](../../functions/src/index.ts) | Last presence deletion triggers a grace period, merges RTDB elements into a full Firestore scene and writes full-scene history. | Reuse merge logic, but read/commit chunk revisions and protect newer RTDB edits during cleanup. It is a fallback, not a continuous solo sync worker. |
| [Project access/publishing](../../functions/src/project-access.ts) | Creates/copies embedded scenes while registering and publishing boards. | Register/reference the scene head without creating an independent payload authority or overwriting newer content. |
| [Exports](../../apps/whiteboard/src/features/workspace/export-boards.ts), [presentation ADR](005-live-presentation-sharing.md) | Consume a complete scene and authorized assets. | Assemble committed revisions; retain live presentation behaviour and role checks. |
| [Firestore rules](../../firestore.rules) | Authorise existing board/share documents; chunk paths are not covered. | Add explicit chunk/head rules and preserve current grants, parent tombstones and immutable history policy. |

## Decision

Use **size-bounded, immutable Firestore chunks with a committed scene revision manifest**. Browser clients read and stage payloads directly in Firestore; a callable validates and publishes each cloud commit. Server collaboration compaction invokes the same commit service internally using the Admin SDK. RTDB remains the existing collaboration transport, rather than a prerequisite for every solo save.

- Small boards use one chunk; large boards use several. There is no special conflict-free fast path for one chunk.
- Chunk by encoded Firestore document size with headroom, not element count or canvas coordinates. JSON character count is not a sufficient size check.
- Keep stable element IDs and stable chunk membership where possible. Edit B by replacing its containing chunk, not appending a duplicate to an overflow document. Split a growing chunk when necessary; avoid repartitioning the whole board on every save.
- Preserve deleted elements/tombstones, stacking indices, bindings, groups, frames, file descriptors and all supported persisted state. Images remain separate under ADR 003.
- New commits reuse unchanged immutable chunks and write replacements only for changed chunks. Never modify a chunk referenced by a committed revision.
- Publish a complete revision by advancing a small head pointer with an expected-revision check. Readers follow that revision's references, never an unfiltered collection of whatever chunks happen to exist.
- Keep the local editor working with a full assembled scene. Initial delivery loads the complete revision before enabling editing; partial editing and spatial loading are separate features.

### Canonical scene location

**`boardScenes/{boardId}` is the sole cloud scene authority for private and shared boards.** Use a separate collection so a scene commit cannot mutate sharing policy or trigger RTDB policy mirroring merely because drawing content changed.

- `users/{ownerId}/projects/{projectId}/boards/{boardId}` becomes the owner's board metadata/index, retaining name, active/deletion state and existing workspace identity. It references `sceneId: boardId`; local IndexedDB still stores the assembled scene.
- `boardShares/{boardId}` remains server-owned access/publishing metadata, also referencing `sceneId: boardId`. Sharing, access registration and Copy never copy a scene or advance an existing scene head; initial scene bootstrap belongs to the scene registration/migration service.
- `boardScenes/{boardId}` binds `ownerId` and nullable `projectId` to that ID, plus head/generation/format metadata. Clients cannot create or modify this binding. Registration verifies the actual owner/private board and parent records; it cannot claim a board using supplied IDs alone. Existing sharing and asset-location bindings must agree.
- New cloud-board creation establishes metadata and an empty scene head through the existing server creation flow or an idempotent registration callable for the owner-local creation path. Pure local boards remain local until cloud sync. A metadata-only index is not proof that a cloud scene has committed.
- Existing standalone shared boards without a private workspace record can be registered only by trusted migration after checking their authoritative sharing record. A project-linked board with missing/deleted authoritative parent records must fail closed.

This separates scene authority from policy authority; it does not replace the current project, board or asset access model. Published revision payloads are immutable; head and server upload-status records are mutable. These are the selected paths for implementation, not deployed collections:

```text
boardScenes/{boardId}                           -> ownerId, projectId, headRevisionId,
                                                  generation, sceneFormatVersion
boardScenes/{boardId}/chunks/{chunkId}           -> immutable payload, uploadId, slot, uploaderUid,
                                                  generation, kind, content digest
boardScenes/{boardId}/uploads/{commitId}         -> immutable candidate identity/base/counts;
                                                  server-owned status/receipt/validation lease
boardScenes/{boardId}/uploads/{commitId}/pages/{pageId}
                                               -> immutable proposed manifest pages
boardScenes/{boardId}/revisions/{revisionId}     -> server-published manifest root and summaries
boardScenes/{boardId}/revisions/{revisionId}/pages/{pageId}
                                               -> server-published reference pages when needed
boardScenes/{boardId}/versions/{versionId}       -> retained revision, label, actor, reason, timestamp
```

The manifest must cover the **whole persisted board payload**, including app state and file descriptors. Growing semantic data or asset descriptors cannot simply move into another unbounded metadata field. Large manifests must also be partitioned or use a bounded hierarchy; the head remains small.

Revision identity, scene schema version and board generation have different purposes. A generation changes when replacing the board's state, for example on restore; it prevents old live-room/offline edits from being silently merged into the replacement.

### Authorization and secure publication

**Use direct Firestore staging plus `commitBoardScene` as the only external scene-head publisher.** Do not let browser clients directly update the head or publish revision/history documents, including for one-chunk boards. This is solution B with server-validated publication, not RTDB-first persistence.

Firestore rules can validate bounded document relationships, but have document-access limits; checking an arbitrary complete manifest and all its chunks in one browser commit is unsuitable. The callable performs that validation with bounded server reads, then a small transaction publishes the head. [Rule limits](https://firebase.google.com/docs/firestore/quotas)

| Resource/action | Authority and checks |
| --- | --- |
| Scene registration/ownership | Trusted server flow verifies private/project/sharing identity. Owner/project bindings cannot be changed by scene commits. Board moves/ownership transfers require a separate server operation. |
| Head, committed revisions, retained versions | Clients may read under current board access, but cannot write/delete. Only the commit/restore/version service and trusted migration write them. |
| Upload candidate creation | An authenticated owner/editor can create an immutable candidate for the current generation, binding `commitId`, UID, expected head, bounded page/chunk counts, format and candidate digest. Clients cannot set committed status, server receipts or validation leases. No candidate updates/deletes are permitted. |
| Chunk/manifest-page staging | Create-only, under the candidate's board and actor; enforce bounded fields, schema envelope, deterministic page/slot bounds, generation and expiry. Payloads cannot be replaced. An identical retry verifies the existing immutable object rather than overwriting it. |
| Payload/head reads | Evaluate current board grants and inherited project grants plus private/project tombstones. Owner/editor/viewer/presentation semantics follow ADR 005. No permissive top-level collection list rule; fetch by known board and references. |
| Server compaction | Invokes the same publication service with explicit trusted identity and room generation; checks current board/parent liveness. It is not an unchecked alternate writer. |

Use the existing [effective-role resolver](../../functions/src/access-role.ts) and matching Firestore rule semantics, extending them to check the registered scene binding and authoritative private/project liveness. A private unpublished board grants only its owner; a published board combines direct and inherited grants. Verified-email invitations and pending-policy owner exceptions remain as currently defined. Anonymous authenticated guests with an editor link can commit scenes; do not reuse the workspace-management helper that rejects anonymous users. Presentation/viewer users cannot stage or commit.

The callable explicitly repeats authorization because Admin SDK writes bypass Firestore rules. Validate current policy when processing the candidate **and inside the final head transaction**, reading the governing board/private-parent/project policy records there so concurrent revocation, deletion or ownership changes invalidate/retry publication. Apply the app's environment-specific App Check policy to new callables, with emulator support; it supplements authorization. [Server SDK security](https://firebase.google.com/docs/firestore/security/insecure-rules)

Commit service contract:

```text
commitBoardScene({ boardId, commitId })
  -> { revisionId, generation, candidateDigest, committedAt }
  or conflict { currentHeadRevisionId, generation }
```

The upload candidate contains the immutable expected head/generation and page counts; the callable request contains references, not the entire board. Server limits bound concurrent uploads, document/page counts, total encoded bytes, validation time and retry cost. Numeric limits are implementation tuning, but exhaustion must reject safely while retaining the local draft.

1. Authorize and acquire a bounded server validation lease on the candidate. Cleanup must honour this lease; expired/missing candidates return a restage-required result.
2. Read the exact candidate pages and referenced chunks in bounded batches. Check all exist, digests/encoded sizes match, IDs are unique, schema/ordering/state descriptors are complete, and every reference is local to this board. Newly staged chunks belong to this candidate/actor/generation; reused chunks must belong to its expected committed base. Cross-board references, incomplete scenes and unsupported formats cannot advance the head. Validate referenced asset locators and authorization without re-downloading every image.
3. Stage the server-owned immutable revision root/pages before publication; these carry the verified candidate digest. They are not authoritative until the head points to them. Preserve the validation lease/pins through publication, including reused chunks.
4. In one small transaction, recheck authorization, candidate status, expected head and generation; atomically advance the scene head and write the candidate's receipt/status. No payload uploads or full-board validation occur inside the retrying transaction.
5. A retry of the same committed candidate returns its original receipt, even if the head advanced again. Reusing a commit ID for different content is invalid. A stale-head conflict publishes nothing: the client re-reads, merges and stages a new candidate/commit ID. A generation conflict requires explicit recovery, not automatic LWW merge.

Draft chunks and committed chunks use the same current board read ACL; draft storage is not a privacy boundary between authorized board users. Do not claim that hiding a history button restricts access to historical payloads. If a future product requires narrower history/draft visibility than board access, introduce a revision-scoped gateway/authorization design before that feature. Server-only history writes still prevent clients rewriting the timeline.

This adds a callable/cold-start and validation-read cost to each debounced cloud save, plus a server write for revision metadata. It does not add a function per stroke, route large payloads through the callable, rewrite unchanged chunks or require solo RTDB. One protocol for small and large boards is preferred over separate browser-publication and server-publication security paths.

### Save and conflict contract

1. Save to IndexedDB and retain the local draft/revision immediately. Determine changes against the last acknowledged cloud base.
2. Load the current committed cloud revision. If the base is stale, merge by element identity using the existing version/nonce semantics: higher element version wins; for equal versions, lower `versionNonce` wins. Preserve deletion tombstones. Do not resolve conflicts by whole-chunk last-write-wins.
3. Pack changed records, validate sizes, and stage new immutable chunks. Reuse unchanged references. Upload required assets before publishing references to them.
4. Call `commitBoardScene` to validate/publish the complete revision only if the expected head and generation still match. If another writer won, re-read, merge and stage a new candidate with bounded backoff. Never blindly force the stale revision onto the head.
5. Mark only the corresponding local revision acknowledged. Newer local edits remain pending. An idempotency/commit identity handles a network failure after the server committed but before the client recorded its acknowledgement.
6. Retain the previous complete revision until cleanup is safe. Failed staging leaves unreferenced chunks, not a partially published board.

Firestore transactions can rerun and fail offline. Side effects such as asset uploads must stay outside retrying transaction callbacks; existing local queues remain responsible for offline edits. [Transaction behaviour](https://firebase.google.com/docs/firestore/manage-data/transactions)

Use the server publication contract for every cloud commit. Readers also validate completeness and retain/retry the previous scene on missing/corrupt data; server validation does not remove transport failures or unsupported-client schemas. Garbage collection must not race validation/publication or active readers: pin candidate/base references during validation and retain superseded revisions for a read grace period. Chunks are eligible only when unreferenced by heads, retained versions or active validation/upload pins; a raw age/TTL policy is insufficient.

App-state and future semantic-model conflicts need explicit policies; existing element LWW does not automatically merge arbitrary board-level objects. Reuse current app-state behaviour initially and avoid promising semantic collaborative merges before defining them.

### Load and rendering contract

1. Render a usable local cached scene when available, subject to current access policy; a cached scene does not grant remote access.
2. Fetch the authorized head and committed manifest; load its chunks with bounded parallelism, cancellation and retry.
3. Validate completeness, unique IDs and supported schema; assemble elements and persisted state, restore stacking order and assets, then hydrate Excalidraw.
4. If live collaboration is active, reconcile newer RTDB records onto the committed base; do not regress the canvas to an older snapshot.
5. A new head cancels or supersedes older hydration work. Never apply a slow result to another board, account, generation or revision.

Reading head R and then R's immutable chunks remains consistent even if the head advances to R+1. Subscribe to head changes, not to every historical chunk. Metadata-only board listings should not automatically fetch every large scene; changing eager workspace hydration requires explicit offline-availability behaviour.

### Collaboration contract

Solo editing uses the existing local/cloud save path. A collaborator joining enables the existing RTDB scene stream; returning to solo persists the converged scene through the chunk commit contract. The abandoned-room function remains the crash/disconnect fallback.

Browser checkpoints and server fallback checkpoints can compete. Both must check the head/generation and merge the latest committed base. The existing function lock coordinates function executions; it does not alone exclude browser writes.

Do not clear RTDB solely because a checkpoint succeeded or presence appears empty. Remove only records included in that checkpoint and still unchanged, with reconnect/generation checks. A record updated during upload must survive cleanup. Presence itself is not a commit boundary.

Current RTDB records are latest-per-element state, not an ordered historical journal. They cannot alone implement board history, semantic UML history or complete app-state history.

## Alternatives considered

| Approach | Benefits | Reason not selected now |
| --- | --- | --- |
| RTDB for all edits + function checkpoints (solution A) | Unified edit pipeline; a sole checkpoint authority can reduce competing snapshot writers. | Larger solo-flow migration; mandatory connections; checkpoint lag, worker retries, replay and cross-database cleanup. More total failure paths for this codebase. |
| Whole scene in Firebase Storage | Removes Firestore payload ceiling; simple snapshot/export format. | Full cold-download/parse and checkpoint costs; requires a separate synchronization/conflict contract. Still viable later, especially for archival payloads. |
| Spatial tiles or logical pages | On-demand transfer and reduced client memory for huge boards. | Cross-region dependencies, movement, bindings, search and exports require editor changes. Dense tiles still need byte-size bounds. Deferred as a loading optimisation. |
| Firestore document per element | Natural granular updates; no chunk rewrite for small edits. | Many document reads/listeners and edit writes; ordering and bulk edits still need coordination. |
| Dedicated record database + WebSocket rooms | Explicit authority, granular persistence and richer queries. | Largest infrastructure and migration cost; unnecessary for removing the immediate document ceiling. |
| Compression inside one Firestore document | Postpones the limit for compressible scenes. | Retains the same hard ceiling; unsuitable as the durable fix. |

Industry evidence supports separating persistence from live sync rather than one universal backend: Figma documented compressed checkpoints plus a journal and later dependency-aware page loading; Word web separates live merges from periodic full-file saves; tldraw documents record persistence. These are precedents, not claims that those applications use this chunk schema. Excalidraw+ internals are not established by open-source Excalidraw. [Research and primary sources](../research/large-board-storage.md)

## Questions and answers

| Question | Answer |
| --- | --- |
| Does overflow mean we start writing everything to the next document? | No. New content can create/split a chunk; existing content retains its identity and updates its containing chunk. Never duplicate old elements across chunks as an append-only overflow scheme. |
| Does the client assemble the board? | Yes. The cloud adapter assembles one `BoardDocument`/scene before handing it to the existing editor. Chunking is a persistence detail. |
| Does the app stop using Firestore directly? | No. Browsers read heads/chunks and stage payloads directly in Firestore. A callable validates and advances the head; server fallback uses its underlying commit service. No solo RTDB connection is required. |
| Why add a callable to B? | It validates all referenced chunks and publishes under fresh authorization without unbounded Firestore-rule checks. It receives IDs, not a full board, and runs per debounced cloud save rather than per stroke. The extra save latency/read cost is accepted. |
| Where is the source of truth? | `boardScenes/{boardId}.headRevisionId`. Workspace and sharing documents reference that board ID and hold metadata/policy; neither owns another scene head. |
| Does a solo board require RTDB? | Not for persistence. Shared boards currently keep an RTDB active-session lobby even when scene collaboration is disabled; removing that connection requires a separate discovery change. |
| Is the free connection limit 50? | Firebase documents 100 simultaneous Spark connections and up to 200,000 per Blaze database. A connected browser tab/device/server counts, not each listener. This decision does not assume our deployed plan. [Limits](https://firebase.google.com/docs/database/usage/limits) |
| Can the existing function be reused? | Reuse its merge logic and change its scene reader/writer. Keep its disconnect/grace-period purpose; it does not become a continuous solo checkpoint worker. |
| Is B always less race-prone? | It has fewer total pipeline failure paths here. A correctly serialised server authority can have fewer competing snapshot writers. Both require correct chunk publication, merge and cleanup. |
| Can we show loading progress? | Yes: count loaded chunks and optionally weight by manifest byte sizes. Separate download from assembly/assets/rendering; chunk count is not an exact time estimate. This is possible in A too because both load chunk snapshots. |
| Can we render progressively? | Later, as read-only preview with dependency handling. Arbitrary size chunks may mix distant regions. Missing arrows/text dependencies and incomplete bounds can cause visual jumps. Initial delivery waits for the full scene before editing. |
| Why not enable editing after the first chunk? | Select-all, delete, fit-to-content, search, exports and autosave assume a complete scene. An incomplete scene must never be saved as though missing elements were deleted. |
| Does chunking make huge boards fast? | It removes the storage ceiling; total transfer, parse, memory and render costs still grow. Measure those separately before adopting spatial loading. |
| What if one element exceeds the safe chunk size? | Use an explicit large-record representation/splitting policy or return a recoverable size error retaining the local edit. Do not silently drop content. Existing collab broadcasts also have a separate 256 KB per-element guard. |
| Is every persisted revision a user-visible version? | No. Keep commit revisions separate from named/automatic retained versions. Select meaningful checkpoints; do not turn every debounced save into timeline noise. |
| Can we revert a board later? | Retain complete immutable revision references and assets. Restore creates a new head/generation; never overwrite history. Old pending edits require explicit reconciliation rather than silently undoing the restore. |
| Will this block UML, AI edits or auto-layout? | No. Preserve versioned semantic payloads alongside visuals, stable IDs and references. Multi-element/model updates publish one logical revision; semantic collaboration needs its own conflict policy. See the [structured-diagram design](../features/structured-diagrams-on-excalidraw.md). |
| What about comments and presentations? | Comments can reference stable element IDs separately, with behaviour defined for deleted/restored targets. Presentations continue reading the authorized live board under ADR 005; sharing changes and Copy must not trigger scene commits. |

## Consequences

- Fewer infrastructure changes than A; existing local saves, drafts and collab behaviour remain useful. Clients share one candidate codec and the backend owns one publication service; server compaction reuses it without making a callable round trip.
- Editing a small element rewrites its chunk. Small chunks increase read/document overhead; large chunks increase transferred/re-written bytes. Stable partitioning and unchanged-chunk reuse limit amplification.
- The head remains a coordination point. Chunking increases capacity but does not remove board-level commit contention.
- Immutable chunks support efficient history and reuse but require reference-aware orphan/retention cleanup. Do not delete chunks/assets referenced by the current head or retained versions, or ones still being staged/hydrated.
- Complete payload validation, authorization and schema evolution become explicit. Unsupported schema or missing chunks must retain the last usable scene and show a recoverable error.
- Keep image soft-delete/retention and gateway authorization from ADR 003. This ADR introduces no destructive asset-retention policy.

### Open implementation questions

| Question | Recommended resolution / required work |
| --- | --- |
| What is the initial size budget? | Start evaluation around 512 KiB per payload document, with a separate lower manifest budget. This is a tuning candidate, not an accepted exact threshold; measure encoded sizes and representative boards. |
| What are operational upload/commit limits? | Measure encoded payloads and function memory/time to set candidate expiry, page/chunk/byte budgets, read concurrency, rate limits and read-retention grace. Secure server validation/publication is settled; these numeric limits remain tuning. |
| How are generations represented in RTDB? | Define room generation scoping and reject/quarantine old-generation broadcasts. This is required before shipping restore, and the persistence interface should reserve it now. |
| How much history is retained? | Product retention/capture cadence is separate. Reuse [version-history research](../research/version-history-feasibility.md), updating its whole-scene assumptions to immutable chunk revisions. |
| What is the oversized-element policy? | Choose a representation preserving Excalidraw round trips and collab transport compatibility. Aggregate capacity must not be presented as unlimited single-element capacity. |

## Implementation sequence and validation

### Migration of the two existing scene copies

For a board not yet in `boardScenes`, read its private scene, sharing scene and current same-generation live records through a trusted migration/registration service. Merge elements using existing version/nonce/deletion semantics; there is no comparable global revision across the two legacy documents. Choose the valid sharing scene for persisted app-state when the board has a live share registration, otherwise the private scene; union file descriptors only after checking immutable IDs/locators. Preserve both legacy source payloads as recovery inputs. Record source revisions/content digests and reject/retry cutover if either source changed while staging.

Activate `sceneId`/format markers in the authoritative metadata together with the first canonical head using a bounded final transaction. Once activated, embedded scenes are legacy recovery data only. Explicit rules/client-version gates reject old embedded-scene writes to migrated boards; the canonical path is the only publisher. Do not rely solely on hiding the old frontend. Old tabs should refresh; edits refused by the gate must remain recoverable locally.

Ownership collisions or conflicting same-ID asset locators stop that board's migration for recovery; do not silently choose another owner or delete its source data. Registration/cutover is idempotent, checks parent tombstones, and does not change sharing grants, access revisions or mint additional RTDB policy events for drawing commits. Retire legacy scene fields only after rollout verification and a defined recovery window.

1. Implement canonical scene registration and the publication contract above; define codec/load results and tune budgets behind the storage seam.
2. Implement/reuse size checks, stable packing, immutable staging, revision merging and assembled loading. Keep a legacy embedded-scene reader. Migrate on an authorized successful commit; preserve old data until verification succeeds.
3. Update workspace sync/hydration, shared saves, publishing/registration, server compaction, exports and live presentation together. Add permissions for new paths without broadening board access.
4. Ship with complete-load editing and progress/error states. Do not introduce spatial loading or user-visible history in the same change.
5. Roll out with compatible clients/functions/rules. Older clients can still write embedded scenes, so define a format/minimum-client gate before switching authority; never let an old save overwrite the new head. Backfill is resumable and environment-specific.

Required behavioural checks:

- One-chunk and multi-chunk save/reload; chunk growth/split; oversized record; byte-size calculation with Unicode; stable z-order, bindings and tombstones.
- Two tabs editing different elements in the same/different chunks, same-element conflicts and simultaneous splits; no erased unrelated changes.
- Interrupted staging, head conflict, lost acknowledgement, repeated commit and failed cleanup; old committed scene remains readable and pending edits survive. Verify committed receipts remain stable after later head commits.
- Offline edits/reload/reconnect; permission revocation, parent deletion/restore, viewers and presentation roles; chunk paths cannot bypass authorization.
- Forge head/revision/history writes, candidate actor/counts/generation, missing pages, cross-board chunks and stale asset locators; no head advance. Revoke grants/delete parents between validation and publication; reject. Validate anonymous link-editor saves and denied viewer/presentation staging.
- Migrate divergent private/share scenes, simultaneous legacy edits and owner collisions; cutover preserves source recovery data and rejects post-cutover embedded-scene writes without losing queued local edits.
- Solo→collab→solo, last-tab crash, late join/reconnect during compaction, browser/server concurrent checkpoints; retain edits newer than the committed boundary.
- Scene fidelity for app state, image descriptors, future semantic fields, exports, previews and presentations; listings avoid uncontrolled scene hydration.
- Future restore: old-generation RTDB/offline changes cannot silently resurrect content; history/chunk/asset references survive cleanup.

Measure cold-load time, total bytes, dirty-chunk bytes, reads/writes per save, transaction retries and orphan growth. Implementation and runtime tests are not performed by this documentation change.

## Testing strategy and release gates

This section specifies tests to implement with chunk persistence. It is not a report of completed tests. Prioritise observable data integrity and recovery over tests that merely mirror packing code. Each failure must identify the scenario, fixture, actor, commit ID, generation and last observed head.

### Harness, fixtures and independent evidence

Extend the existing [regression runner](../../tests/run-regression-tests.mjs), [Puppeteer collaboration suite](../../tests/e2e-collab-suite.mjs), [chaos suite](../../tests/collab-chaos-live.test.mjs), [network suite](../../tests/network-lifecycle.test.mjs) and [board behaviour suite](../../tests/board-behavior-contract.test.mjs). Use `puppeteer-core`, the repo's Chrome configuration and isolated Auth/Firestore/RTDB/Functions/Storage demo emulators. Proposed focused suites are `board-chunks-e2e.test.mjs` and `board-chunks-chaos.test.mjs`; register them in the runner's allowlist before claiming its filter can run them. Do not replace current image, sharing, presentation or undo coverage.

Use three independent layers of evidence:

1. **UI/editor:** real toolbar/mouse/keyboard actions, persisted scene through the existing test-only `window.__excalidrawAPI`, save/loading/error states and screenshots where visual fidelity matters. Test APIs may seed fixtures and inspect state; they must not manually broadcast or commit the edits whose actual user flow is under test.
2. **Transport/commit:** browser network/CDP traces plus structured application/server commit diagnostics. Record candidates, stages, callable result/error, conflicts, leases and receipts. Never infer success solely from HTTP status or the save label.
3. **Independent persistence:** an Admin test verifier reads the canonical head, immutable manifests/chunks and outstanding RTDB records. A fresh isolated browser context loads the board with no shared IndexedDB/Firestore cache. Admin checks inspect persistence, but never stand in for an ordinary user's authorization test.

Fixture families:

| Fixture | Required contents/purpose |
| --- | --- |
| Empty and ordinary one-chunk boards | Blank save, first draw, normal text/shapes, unchanged reopen; prove the common path works without special conflict exemptions. |
| Chunk boundaries | Safely below threshold, just below/at/above the selected encoded-size threshold, and enough data to split twice. Include Unicode/emoji, long IDs and field names; do not estimate using character count. |
| Large scenes | At least 3 and 20 real-budget chunks, an aggregate scene greater than 1 MiB, and enough references to exercise paged manifests. Reduced test budgets can accelerate race tests, but cannot replace real-limit coverage. |
| Cross-chunk relationships | Bound arrow endpoints, bound text, groups, frames, overlapping shapes with explicit stacking order and deleted members. Give each important object a stable fixture ID and expected fields. |
| Mixed payload | Freehand points, text, immutable image descriptors/bytes, app state, tombstones and a round-tripped versioned semantic fixture. Semantic fixture coverage does not claim UML tools are implemented. |
| Identity/cache variants | Owner, anonymous link editor, invited verified editor, unverified invite, viewer, presentation, stranger; cold context, warm context, two same-user tabs and separate-user contexts. |
| Legacy/divergent boards | Private-only, shared-only supported legacy case, differing private/share elements/app state, matching and conflicting asset IDs, deleted parent and colliding ownership. |

Maintain an independent reference scene. Assert live and deleted IDs separately, exact geometry/text/style/version/nonce, binding/group/frame references, stacking order, persisted app state and file IDs. For deterministic conflict fixtures, compute the expected winner directly from the documented version/nonce rule, not by calling the production merge helper. Canonical digests exclude only explicitly ephemeral fields such as cursors; do not omit persisted fields to make comparisons pass.

For each acknowledged revision assert: all referenced chunks/pages exist, digests/sizes match, no element appears twice, immutable payloads remain unchanged, the head and receipt agree, and every referenced asset is authorized/available. After convergence, each active client and a cold reader must equal the expected persisted scene. Screenshots complement these assertions; element count alone cannot detect a wrong arrow, lost text edit or changed stacking order.

### Normal flow and Puppeteer E2E matrix

| ID | Actions | Assertions |
| --- | --- | --- |
| N01 | Create a private board, draw one rectangle, type text, drag/resize, save and reopen. | Stable board/element IDs, correct geometry/text, local pending→cloud committed states, one canonical authority and complete head/receipt. Cold reader matches. |
| N02 | Open a saved board and do nothing; pan/zoom, inspect settings and close. | No drawing commit or new immutable payload solely from hydration/navigation. Only deliberately persisted setting changes may save; ephemeral viewport behaviour follows the existing product contract. |
| N03 | Create a large board crossing the first and subsequent split thresholds; edit old and newly added shapes. | Old content stays present; chunks remain bounded; no append-duplicate elements; unaffected chunk references are reused. |
| N04 | Modify one small element in a many-chunk board. | Its dirty chunk is replaced, unchanged chunks remain byte-identical/referenced, receipt is correct. A split or coupled binding change may legitimately dirty more than one chunk. |
| N05 | Grow/shrink text and freehand data around a split boundary, then undo/redo. | Valid packing, stable object IDs, no churn across every chunk, correct text/points and deletion semantics after reload. |
| N06 | Group/ungroup, bind arrows/text, move a frame, change z-order and delete a connected member across chunks. | Relationships and stacking survive save/reload; no dangling references introduced by assembly; user-visible undo restores the intended content. |
| N07 | Insert an image, move it repeatedly, delete/undo it and reopen. | Correct pixels/file ID/locator; movement does not re-upload immutable bytes; deleted assets remain recoverable under ADR 003. |
| N08 | Delete all elements and save; reload several times. | A valid committed empty scene, not a missing-scene fallback; no resurrection from legacy/local/RTDB snapshots and no flash of deleted content. |
| N09 | Change an app setting that is persisted; duplicate/export the board. | Complete state round trip; export equals assembled scene; duplicate has a new board authority and valid asset access, with no foreign-board chunk references. |
| N10 | Share/unshare, change inherited grants, copy a link, rename and open presentation. | Permissions/metadata behave as before. Share/Copy do not publish drawing revisions; presentation loads the same authorized live head and preserves notes rules. |
| N11 | Cold-open a large board while individual chunk reads finish out of order. | Loading progress counts unique completed work, stays bounded, and editing waits for full assembly. No mixed revision, duplicates or intermediate autosaves. |
| N12 | Warm-open the same revision; then reopen after one remote dirty chunk. | Correct cached content, bounded refresh work, current authorization and no false pending save from hydration. Separate cached UI readiness from verified cloud freshness. |
| N13 | Edit, immediately switch boards/account or navigate back; release the old delayed read/save. | No cross-board rendering or acknowledgement; old work remains tied to the old board/user. Logout does not upload one account's draft as another. |
| N14 | Trigger a large MCP/bulk/auto-layout-style edit while a previous save is pending. | One complete logical result when the operation is designed atomic; a previous save ACK never marks later edits committed. Normal UI editing remains usable. |
| N15 | List many boards, opening only one. | Listing reads metadata rather than downloading every scene; explicit offline prefetch is separately measured and does not masquerade as accidental hydration. |
| N16 | Commit with a deliberately oversized record or unsupported schema. | A recoverable error and retained local draft; no silent omission and no partial head publication. Existing RTDB payload rejection is surfaced rather than treated as a successful collaborative edit. |

### Network-call assertions

Attach listeners before navigation for request, response, failure and page errors; use CDP for request IDs, transferred bytes and WebSocket creation/frame/close diagnostics. Redact tokens, cookies and asset bytes from saved traces. Preserve document paths, byte counts, timing and commit IDs. Firebase transports may multiplex documents in WebChannel streams or retry them, so **one HTTP request is not one document read/write**. Correlate application diagnostics and Admin state with network traces instead of guessing billing from URL count.

Required assertions in fault-free, isolated test windows:

- A solo private-board save stages only changed payload chunks and bounded manifest/candidate data. `commitBoardScene` carries board/candidate references, not the full scene. No browser write targets the canonical head, committed revision or history.
- A normal candidate produces one logical receipt; transport retries may issue multiple attempts. Repeating its ID never creates another head revision. Newer edits produce a distinct candidate after the configured debounce/queue rules; do not require one save per mouse movement.
- A no-op open makes zero logical scene commits. Copy Link makes zero scene/access mutations. Access changes call the policy API, not the scene publisher. Drawing commits do not change `accessRevision` or invoke policy mirroring.
- Private solo persistence sends no RTDB scene/presence traffic. Do not fail a shared-solo test merely for its expected active-session lobby; separately assert that it has no active scene stream until collaboration starts.
- Image-only movement sends no asset upload; no permanent download token/URL is exposed. Reading required image bytes may make authorized gateway calls.
- Cold loading fetches the selected head's manifest/pages and required chunks, not every upload or historical revision. Warm-load budgets allow SDK cache differences but detect full-board refetch loops.
- Record HTTP failures **and callable error bodies/result states**, including permission/conflict errors. A successful transport response is not proof that the candidate committed.
- Retry traffic is bounded by configured backoff/caps. After the board becomes idle, no repeated candidate creation, acknowledgement loops, listener leaks or unbounded orphan growth occurs.

Add direct denied-write probes using the ordinary client SDK for head/revision/history updates, foreign-board chunks, actor spoofing and viewer staging. These are security scenarios, not Admin writes. Compare the head before/after every denial.

### Collaboration: joining, editing and dropping out

Use three isolated browser contexts A/B/C and stable actor/object IDs. Same-user two-tab coverage is separate. Wait for actual session/scene convergence before the next phase; collaborator avatars alone do not prove edits reached the server.

**Required sequential dropout script:**

1. A edits a solo board and commits revision R. B joins; both create different shapes and observe each other. C joins during a chunk split and makes another edit.
2. C disconnects/closes while A/B remain. A/B continue drawing, including editing an element created by C. Assert C's server-acknowledged edits survive and no live room is prematurely compacted/cleared.
3. B disconnects/closes. A transitions from collaboration to solo, edits immediately around the transition, then commits. Assert no missing/duplicate elements, stale snapshot rollback or stuck transition/read-only state.
4. A closes. Wait for the actual final checkpoint/receipt or fallback completion, then reopen from D with an empty browser cache. Assert the complete expected union of acknowledged edits, correct tombstones and no stale RTDB overlay.
5. Repeat with drop order A→B→C, B→C→A, owner leaving first, guests remaining, explicit close, hard browser kill and isolated network loss. The owner is not assumed to be the last checkpoint writer.

| ID | Variation | Required result |
| --- | --- | --- |
| C01 | Two editors change different elements in the same chunk; repeat in different chunks and on a one-chunk board. | Both changes survive in all clients and the cold committed scene. |
| C02 | Two editors change the same element with controlled versions/nonces. | Documented element-level winner converges; do not expect field-by-field merges the current algorithm does not provide. |
| C03 | Delete versus delayed move; undo versus another user's edit. | Tombstones prevent stale resurrection, valid newer undo follows version rules, and scoped undo does not revert another user's unrelated action. |
| C04 | Rapidly alternate 1↔2↔3 sessions; join during staging, publication, downgrade and final grace period. | Correct lobby/scene activation, durable base and generation; no room wipe of a reconnecting user's newer edits. |
| C05 | Spectator/viewer/presentation joins or exits while two editors draw. | No unauthorized scene commits or editor-presence writes; read-only users do not accidentally change the persistence boundary. |
| C06 | One editor partitions, edits locally, then rejoins after peers checkpoint. | Bounded retry, expected element merge, no old-head rollback; queued edits remain local until successfully delivered/committed. |
| C07 | All editors disappear at once; interrupt fallback processing and allow its retry. | Acknowledged RTDB changes remain recoverable; one valid logical checkpoint, no premature cleanup. Unsent browser-only edits are not falsely claimed recovered. |
| C08 | Browser commit and abandoned-room compaction race on the same head. | One wins the expected-head check; loser merges/retries; no unrelated edits lost and no duplicate receipt for a candidate. |

For RTDB edits distinguish **observed locally**, **server-acknowledged**, and **included in a Firestore checkpoint**. A fresh reader can reconstruct checkpoint plus pending acknowledged records; require equality to Firestore alone only after the final checkpoint completes. Before removing live records, assert the checkpoint covers those exact versions and preserve newer replacements.

### Chaos testing: prove the fault, then prove recovery

Use Puppeteer [HTTP network throttling](https://pptr.dev/api/puppeteer.page.emulatenetworkconditions) and [offline mode](https://pptr.dev/api/puppeteer.page.setofflinemode) where applicable. HTTP throttling does **not** affect WebSockets; RTDB latency/loss/disconnect tests need a verified test proxy/socket-control layer or a transport fault adapter. Setting `navigator.onLine` or dispatching an offline event is a lifecycle test, not proof of a real network partition. Confirm the intended requests/frames were actually delayed or blocked.

Fault profiles are reproducible test inputs, not performance guarantees: e.g. 400 ms latency with 100 KiB/s upload, 2 s latency with 20 KiB/s upload, variable delay/jitter, short online/offline bursts, a minute-long partition and one participant affected while others remain healthy. Include HTTP-only, RTDB-only and complete partitions.

| ID | Fault injection | Integrity/recovery assertions |
| --- | --- | --- |
| F01 | Slow a multi-chunk upload; keep drawing while earlier candidates save. | Canvas/local saves stay usable; save state is honest; earlier ACK cannot clear later pending edits; final state converges. |
| F02 | Fail a selected chunk or manifest page once, then repeatedly. | Head stays on the last complete revision; retries are bounded; errors retain local content. Recovery uploads missing work without replacing immutable chunks. |
| F03 | Go offline before staging, halfway through staging, before callable publication, and immediately after publication. | Respect each boundary: no partial head, local draft survives; ambiguous success resolves using the candidate receipt rather than duplicate publication. |
| F04 | Commit succeeds server-side, but drop only its response; also delay R's ACK until R+1 exists. | Repeated commit returns R's receipt; R+1 remains head; old ACK never regresses canvas or falsely acknowledges later local edits. |
| F05 | Restart the function worker/emulator after validation and before/after head transaction. | Retry either safely publishes once or returns its receipt; active lease/pins prevent GC races. A process crash cannot expose a partial board. |
| F06 | Cold-start/timeout the callable while Firestore staging and RTDB remain healthy. | Pending state remains truthful, drawing continues locally, timeout retry is idempotent, and saved RTDB edits are not pruned. |
| F07 | Drop network after local edit, reload the same profile, then reconnect. | If the app shell is available, local draft is restored and later synced. Do not promise offline cold navigation when no app-shell cache exists; distinguish shell failure from board persistence failure. |
| F08 | RTDB disconnected while Firestore/functions work; then reverse the partition. | No false collaboration/saved claims; declared available paths work, pending changes survive and reconnect converges. Verify transport ACKs, not just avatars. |
| F09 | Revoke editor access/delete parent during a slow upload or between validation and publication. | No head advance by the now-unauthorized candidate; retries become blocked rather than an infinite permission loop. Local bytes are retained without renewed remote access. |
| F10 | Expire candidate/lease or run GC while a commit waits; resume afterward. | Current/retained/pinned chunks survive. Expired work produces a recoverable restage result; no missing references become authoritative. |
| F11 | Corrupt/delete a fixture chunk using Admin while a reader loads; inject unsupported format. | Client retains last usable scene, shows explicit recovery error, disables incomplete-scene editing and never autosaves a truncated board. |
| F12 | CPU-throttle/freeze a tab; background it, resume after head changes; change device clock wildly. | No stale hydration or huge retry/lease errors; server time controls expiry, generation and receipts. Late work is scoped to the right board/user. |
| F13 | Kill the browser before local durability, after local durability, after RTDB ACK and after cloud receipt. | Compare against the guaranteed boundary at each point. Only persisted/acknowledged edits are required to survive; never mask loss of acknowledged work as an expected crash. |

A content-correctness failure is never waived as “flaky network.” Also assert bounded request/CPU activity during the failure, recovery without duplicate user actions, and a fresh-context reopen after transport heals.

### Deterministic races and timing boundaries

Add **test-only** pause/release barriers at: local draft write, final chunk upload, candidate validation, lease acquisition, pre-head transaction, post-head/pre-response, hydration completion, collab downgrade and pre-RTDB cleanup. Compile/enable barriers only in isolated test builds; they must not be available as public production request parameters. Prefer these barriers to arbitrary sleeps. A controlled test clock can accelerate grace/lease/backoff unit tests; keep at least one real-timer browser/trigger case.

Run both orderings of each race, logging the barrier schedule:

| Race | Expected invariant |
| --- | --- |
| Two writers validate against R and publish simultaneously. | Exactly one initial head transition; the other gets conflict, merges and succeeds later without losing either acknowledged edit. |
| Both writers split the same nearly full chunk. | No duplicate/missing IDs or dangling manifest references; obsolete candidates remain unreferenced. |
| Reader loads R while R+1 publishes; deliver chunk responses in reverse order. | Reader completes R or switches coherently to R+1, never a hybrid. |
| Board A load resolves after navigation to B; account A save ACK arrives after login as B. | No cross-board/account state mutation or erroneous save indication. |
| Save debounce fires at pointer-up while a second editor joins. | Final drag position is included; transition guards do not swallow the last edit. |
| Last collaborator exits just before/at/after grace-period expiry; reconnect just before cleanup. | Presence recheck plus exact-record cleanup preserves live/newer changes. Test boundaries around the configured period, not only distant times. |
| A record is replaced after compactor reads it but before removal. | Conditional cleanup keeps the replacement, even if its element ID is the same. |
| Candidate lease expires while one worker stalls; another worker retries. | Stale worker cannot publish/cleanup using a superseded lease; only one receipt is authoritative. |
| GC examines an orphan as a validator pins it or a reader needs a superseded revision. | Lease/pin/read-grace protocol prevents dangling references; eventual orphan cleanup still occurs. |
| Delete-all, undo, remote move and delayed solo save overlap. | Correct documented version winner; no fallback to a nonempty legacy scene simply because the committed scene is empty. |
| Restore advances generation while an old tab/compactor reconnects. | Old-generation writes are rejected/quarantined, not auto-merged into restored content. Required when restore is implemented; reserve tests/interfaces now. |
| Access mutation or migration cutover interleaves with publication. | Authorization and source-head rechecks are transactional; old client writes cannot become a second scene authority. |

Avoid `networkidle` as the only readiness gate: persistent SDK connections may never become idle. Use bounded eventual assertions on head/receipt/scene identity and commit state; include the last observation in timeout reports. Do not rerun a failing scenario automatically until it passes and discard the first failure.

### Security, migration and future-feature regression

- Run each chunk/candidate/head read/write as owner, valid editor, anonymous link editor, viewer, presentation, stranger and unverified invite. Test direct grants, project inheritance and overrides; wrong owner/project binding; pending policy; missing/deleted private parent; expired candidate; spoofed actor/generation; cross-board references; forged receipt and duplicate page/element IDs. Denied actions leave the head unchanged.
- Revoke permission after validation but before transaction, and after a reader obtained the manifest. Subsequent reads must fail under current ACL; previously downloaded bytes cannot be erased. Keep server role resolution and client rule decisions consistent.
- Migrate divergent legacy copies while an old client edits; kill migration before/after cutover and retry. Verify merged elements, chosen app state, source recovery payloads, grants and assets. Post-cutover embedded writes are denied while local edits remain recoverable.
- Confirm immutable payloads cannot be overwritten, receipt retries cannot change content, current/retained chunks cannot be collected and no client can rewrite/delete history. Test maximum manifest paging and rejection of malformed/cyclic or cross-board page references if a hierarchy is used.
- When versioning ships, retain R, edit/delete its elements/assets, preview R, restore R into a new generation and compare the complete scene. Run restore with active editors, pending offline edits and compaction. Named versions/history must not be silently altered by ordinary save/GC.
- Round-trip future semantic payloads through client saves, server compaction, duplicate/export and historical restore. Make schema compatibility explicit; do not treat unknown structured-diagram state as disposable because Excalidraw can still render its projection.

### Soak, performance and evidence required to ship

Use a reproducible seeded operation generator for long sessions: creates, edits, deletes, undo, split growth, joins/leaves, partitions, reloads and reconnects. Keep an operation ledger identifying which edits reached local durability, RTDB ACK and cloud receipt. Compare to the independent reference model at stable checkpoints; same-element conflict outcomes follow the documented rule, not a universal “all edits survive” assumption. Save the seed, schedule and first failing prefix so the run can be replayed/minimised.

Suggested initial soak: 3–5 editors on a 20-chunk board for 30 minutes, rotating partitions and sequential dropouts; separately repeat cold/warm open/close cycles. Increase dimensions from measured bottlenecks, rather than making every CI run a stress test. Verify bounded pending queues, listener/socket count after closure, heap growth, candidate/orphan growth, head conflict rate and retries. A stable scene with runaway writes still fails.

Report p50/p95 cold-ready, warm-ready, commit ACK, reconnect convergence and collab→solo durability times; bytes/chunks read, dirty-chunk bytes written, callable attempts, backend validation reads and conflict retries. Set explicit budgets during implementation from a baseline on the same fixtures/environment. Emulator times are not production latency claims; separately run a small approved development-cloud suite for real quotas, SDK/rules, triggers and cold-start behaviour.

Release gates:

1. Meaningful codec/merge/commit tests and emulator authorization/publication tests pass, including ambiguous ACK and stale-head cases.
2. Normal one-/multi-chunk Puppeteer flows and all deterministic data-integrity races pass; existing sharing/presentation/image/undo regressions remain green.
3. Poor-network/offline and sequential/all-at-once dropout recovery passes with independent cold-read verification; no acknowledged edit loss or partial authoritative head.
4. Seeded soak shows bounded resource/cost behaviour. Development-cloud verification covers the real-limit gaps emulators cannot establish. No production chaos injection.
5. On failure, retain sanitized network/WebSocket traces, console/page errors, operation/barrier ledger, before/after heads and manifests, draft/receipt/lease snapshots, scene diffs, seed, screenshots and build/config identifiers in the test artifact directory. Clean up only test-owned resources; retain failed evidence for diagnosis.

For documentation-only changes, verify local links/Markdown consistency. Runtime gates above become mandatory when implementing this ADR; they have not been executed by writing this section.

## Initial implementation notes

The implementation uses `functions/src/scene-codec.ts` as a pure shared codec, `features/scenes/scene-service.ts` for browser persistence, and `functions/src/board-scenes.ts` for trusted bootstrap/publication. New solo edits stage directly in Firestore and call `commitBoardScene` with board/candidate IDs; existing RTDB live collaboration still checkpoints through the same canonical publication protocol. Local storage retains assembled scenes and independently tracks local revisions, cloud head IDs and generations.

Initial conservative bounds are 512 KiB per encoded chunk including a 4 KiB envelope reserve, 100 references per manifest page, 512 total references, six pages and 64 MiB of total encoded chunk documents per candidate. These are implementation limits to measure and tune, not a claim that maximum-size validation or production latency has been benchmarked. A single unpartitionable record exceeding the chunk budget produces a recoverable error while retaining the local draft.

Bootstrap reserves immutable ownership before staging payload bytes, so colliding board IDs cannot expose a losing owner's orphan chunks. A reserved head with no revision is incomplete and must resume trusted bootstrap before editing. Read-authorized viewers can request bootstrap from trusted legacy sources; they cannot submit content or commit edits. Existing standalone shares are supported after verifying their authoritative sharing policy.

Legacy embedded scenes remain immutable recovery copies. Metadata writes merge to preserve exact divergent original sources; this means migrated legacy metadata reads still transfer their old embedded payload until a separate archival migration removes it safely. Fresh boards never embed scenes in metadata. Incomplete metadata-only local placeholders are marked and cannot be edited/exported as empty boards.

No garbage collection ships in this first implementation: superseded revisions and staged orphans are retained. Add retention, orphan quotas and cleanup before broad deployment; collection must protect receipts, active validation leases, retained versions and readers. Index exemptions for chunk payload and manifest references are included in `firestore.indexes.json`. Configuration and code changes here do not constitute deployment.

Shared pending drafts carry their generation. Unknown legacy drafts can replay only into generation 1; generation changes require explicit recovery. Version browsing/restoration and generation-scoped live rooms are future features, not implemented by reserving the generation field. Revision immutability makes them possible without changing this storage layout.

Verification results and remaining release gates are recorded in [the implementation log](../handoffs/chunked-board-implementation-log.md). The testing section remains the release guide; a passing focused emulator suite does not establish cloud quotas, maximum-size performance or the full soak matrix.

Focused local implementation verification is complete: the core Puppeteer suite exits successfully with 16 checks, including a scene above 1 MiB, staged publication, local/cloud races, offline/slow-network/lost-response recovery, viewer migration/access recovery, collaboration dropouts and real abandoned-room fallback/cleanup. Independent backend integrity and RTDB cleanup suites, affected sharing/export/image/presentation/deleted-project regressions, workspace typecheck and production build also pass. See the log for exact artifacts, failed-run corrections and commands.

This does not close the remaining release gates: no 30-minute resource soak, 64 MiB maximum-size benchmark, real-cloud quota/cold-start validation, full transport-fault matrix or severe device-clock-skew test was run. Orphan retention is currently unbounded and requires quotas/cleanup before broad rollout. One global loading overlay keeps a centered animated spinner mounted and describes the expected action: “Loading board…” or “Loading boards…”. Board downloads show round(completed chunks / total chunks × 100) once the manifest is known, without exposing storage terminology; full assembly completes before editing. Internal chunk progress remains available for instrumentation; partial progressive rendering and viewport loading remain future work.
