# ADR 007: Safely maintain scene chunks, deletions and retained versions

- Status: Accepted — Phases 0–3 passed; Phase 4 automatic history lifecycle policy remains open; Phase 5 passed emulator and synthetic dev verification; Phase 6 explicit owner restore implementation and emulator/Puppeteer verification complete
- Date: 2026-10-20
- Related: [ADR 006](006-chunked-firestore-board-persistence.md), [ADR 003](003-image-access-and-soft-delete.md), [ADR 005](005-live-presentation-sharing.md)

## Context

ADR 006 removes the single-document board size limit using immutable chunks and an atomically published revision manifest. Ordinary saves preserve chunk membership and reuse unchanged chunks. Deleted elements remain full `isDeleted` tombstones, so stale clients cannot resurrect them through element-level merging. Superseded revisions and abandoned uploads currently accumulate; no collector or permanent tombstone cleanup ships in ADR 006.

Deleting visible content therefore need not reduce current chunk count or total stored bytes. Repacking alone cannot reclaim the payload inside full tombstones. These are three distinct problems:

1. **Repacking:** change physical layout without changing logical content.
2. **Tombstone compaction/removal:** reduce deletion metadata without resurrecting old content or losing offline drafts.
3. **Garbage collection (GC):** delete physical objects no longer needed by any protected operation or revision.

The user requires safe collaboration, offline recovery and future board versioning. Presence, elapsed time, and the current head alone cannot prove that data is unused. An offline browser may reconnect after any fixed retention window.

### Existing implementation and required seams

| Code | Reuse / required extension |
| --- | --- |
| `functions/src/scene-codec.ts` | `packScene` retains membership. Add an explicit deterministic repack mode; do not change ordinary save behaviour. Codec currently serializes full elements, including tombstones. |
| `functions/src/board-scenes.ts` | `commitSceneCandidate` validates chunks under an upload lease and publishes with expected-head/generation checks. Maintenance fencing now covers lease acquisition, staging and publication. `readBoardScenePage`/`readBoardSceneChunks` serve bounded payload reads only through an active pin; trusted bootstrap and `checkpointScene` also participate. |
| `apps/whiteboard/src/features/scenes/scene-service.ts` | Browser loads committed manifests/chunks through protocol-versioned pin-bound callables, stages uploads through fenced callables, merges elements and retries ambiguous commits. A browser cache is not a durable retention root. |
| `packages/storage/src/index.ts`, workspace/sharing draft paths and `routes/board-editor.tsx` | Preserve generation-bound drafts, conflict quarantine and local/cloud revision distinction. Audit every retry and hydration path for generation changes. |
| `features/collaboration/use-collaboration.ts`, `functions/src/index.ts`, `database.rules.json` | Fence room admission, deltas and late checkpoints across generation changes. Existing abandoned-room checks accept a legacy room without generation only for generation 1; that is not a complete reset protocol. |
| `firestore.rules` | Direct client writes and reads of scene payload collections are denied. Authorized clients may read head metadata; server-owned pin/maintenance metadata protects callable payload reads. Current chunk schema is immutable and lacks a reliable standalone creation timestamp. |
| Exports, live presentation, duplication and future history preview/restore | All multi-document readers need pins; all durable references and writers need the same maintenance protocol. |

Paths above are repository-relative. Extend the shared persistence module rather than duplicating deletion logic in UI routes or scheduled functions. No new RTDB dependency is introduced for solo editing.

## Decision

Use a server-owned maintenance module with separate operations for collection, repacking and generation reset. Keep each operation resumable, bounded and idempotent. Use tracing/job IDs and dry-run reports. Clients may request permitted actions but cannot choose arbitrary deletion paths or publish a clean snapshot that bypasses validation.

### Non-negotiable invariants

1. A committed or retained revision always resolves to complete, digest-valid chunks and authorized asset descriptors.
2. Immutable payloads are never edited in place. A layout change publishes a new revision.
3. Every writer, root mutation and reader-pin acquisition participates in fencing, including trusted Admin SDK writers. Security rules do not constrain Admin SDK code.
4. Physical deletion requires a fresh proof of unreachability under the maintenance fence, not just a mark from an earlier scan.
5. Stale generations never merge automatically into the current generation. Drafts survive failures, sign-out and reconnect without crossing account/board ownership.
6. Maintenance failures preserve the last complete head. Retry never acknowledges unrelated pending local edits or deletes newer RTDB records.
7. Unknown schema/format, incomplete manifests, missing ownership evidence or unenumerable roots fail closed: skip destructive work and alert.
8. History retention and current-scene cleanup are independent. Cleaning today's scene cannot rewrite yesterday's retained version.

## Data and coordination model

These are proposed fields/collections, not existing contracts. Keep naming consistent when implemented and record any intentional deviation here.

| Record under `boardScenes/{boardId}` | Purpose |
| --- | --- |
| Server-owned maintenance control | `admission: open/closed`, monotonically increasing `epoch`, worker token/lease, job ID, phase, cursor and policy version. May be a separate document to avoid drawing metadata listeners firing on every heartbeat. |
| `readerPins/{pinId}` | Authorized user, explicit revision IDs, generation, purpose, server-issued expiry and bounded lifetime. Immutable target set; renewal cannot add roots. |
| Existing `uploads/{commitId}` | Durable upload ownership, expiry and validation lease; extend with explicit base revision and maintenance epoch where needed. Protect staged bytes before a complete upload manifest exists. |
| `versions/{versionId}` / retention records | Server-owned retained revision root, kind (named/automatic), policy and expiry if applicable. No in-place edits to revision payload. |
| `maintenanceJobs/{jobId}` and paginated quarantine entries | Candidate object IDs, type, observed provenance, quarantine time, reason and outcomes. Never put an unbounded ID list on the board head. |
| Compact deletion records in scene format v2 | Element ID, deletion version/nonce and necessary conflict metadata; size-bounded, hash-verified records in the manifest, not one growing head map. |

An upload needs trusted creation/expiry evidence before its chunks can be collected. For legacy chunks, derive provenance only from a valid upload or bootstrap record. Missing provenance means preserve and report; do not guess age from chunk ID, digest or client element timestamps. Adding metadata must respect current schema allowlists, codec budgets and bootstrap chunks that do not originate in browser uploads.

### Protected root set

- Current head, including incomplete bootstrap reservations until resolved by a separate recovery policy.
- Every explicitly retained automatic or named version, including older generations.
- Active reader pins for board loads, exports, presentation, duplicate/copy, history preview and restore.
- Unexpired uploads: protect their base revision and all chunks owned by that upload, even if pages are incomplete. References to reused chunks must be limited to the protected base or other explicitly pinned revisions.
- Active validation/checkpoint/maintenance jobs with durable leases and declared input/output roots. Protect a lease-valid upload even if its normal staging expiry has elapsed; validator deadlines remain bounded.
- Temporary recovery/rollback roots created before destructive generation resets.

Parent revision pointers are lineage, **not implicit retention edges**; otherwise every ancestor lives forever. This distinction must be enforced in the collector and documented in history readers. A commit receipt proves publication, not indefinite payload retention. Keep receipt metadata through the retry window independently; replay may return the receipt even after its old payload expires, and must never regress the current head.

**Initial retention policy:** preserve all committed historical revisions; collect only proven abandoned staging/orphans. Superseded revisions become eligible only in a later phase after an explicit retention policy and history expiry behaviour exist. Named versions have no automatic expiry. Do not invent a destructive retention default during implementation.

### Reader contract

Acquire a server-authorized pin and resolve its revision atomically with respect to maintenance admission. Pin acquisition fails/retries while admission is closed. Clients must not read payload collections directly: current rules deny reads of revisions, pages, versions, uploads and chunks; protocol-versioned page/chunk callables validate actor access, the live pin, exact revision/page references and payload digests. Keep response batches bounded. Renew only an unexpired pin for its original targets; an expired pin requires fresh acquisition and revalidation. Recheck access on every callable and renewal; possession of a pin never grants access.

Release after assembly/export completes. Crashed readers expire naturally. If a suspended tab outlives its pin, stop using partial results, reacquire and restart; for the current board reload the latest head, for an expired historical version show an explicit unavailable result. Keep the local draft. Do not expose a partially assembled editor. A graceful retry is supported; unbounded retention for suspended readers is not.

Pins have server-controlled TTL, renewal cadence and limits per actor/board, configured and tested before enforcement. A suggested starting point is a 5-minute lease renewed after at most 1 minute, with small bounded root sets. Validate against slow loads and exports. TTL may reap expired pin metadata; it must never directly delete chunks.

## Safe garbage-collection protocol

### Admission and fencing

Use one **board-scoped admission gate** for the first implementation. This deliberately trades brief publication delays for a simpler proof of safety; editing and local journaling continue. A gate covers new staging writes, validator acquisition, final publication, pin acquisition, retained-version changes and bootstrap/reset transitions. Existing readers may finish; valid pins may renew without changing their targets.

Closing admission and allocating an epoch/token is transactional. A destructive batch transaction must read the current control record, prove ownership of that epoch/token and a valid worker lease, then delete only its approved bounded objects. Revalidate lease/time on transaction retries. Takeover or cancellation changes the epoch/token so stale workers cannot delete or publish. Use server-controlled time, never browser clocks.

**Worker expiry does not automatically reopen admission.** The control stays closed until a recovery worker resumes, or atomically cancels/fences the job and reopens. Otherwise an expired worker could delete from an obsolete root census after new readers/writers enter. Alert and invoke recovery promptly; a crashed worker must not leave cloud saves blocked indefinitely.

All root-mutating transactions read the control; direct client upload/page/chunk creation rules reject closed admission. Existing validators that started before closure cannot publish or stage revisions unless their current token is admissible. Drain or abort them safely; their pinned inputs and unfinished outputs remain protected. Reopening and canceling/replacing the worker are fenced transactions too.

### Mark, quarantine, recheck, delete

1. Outside the gate, scan eligible old objects and create a paginated quarantine proposal. No physical deletion occurs. Use durable upload/job timestamps and policy eligibility. Exclude recent, unknown and malformed objects.
2. After the configured quarantine delay, close admission for a bounded board batch and establish a fresh root census. Paginate all roots and retain a durable proof/cursor tied to this epoch. If enumeration is incomplete, ownership changes, a manifest cannot be validated, or the time/size budget is exceeded, delete nothing and reopen/retry with a safer bounded plan.
3. Mark from the protected roots, traversing manifests, all pages, chunks and asset references. Include current pins and still-live upload/job protection. Quarantine is only a proposal; objects that became reachable are removed from the proposal.
4. Under the same closed epoch, delete bounded unreachable objects in transactions that check the fence. Delete expired manifest pages/metadata only when their revision is eligible too. Resume safely after partial completion; deleting an already missing object is success.
5. Reopen admission, record counts/bytes and let clients retry with jitter. Recompute reachability under a new epoch for the next batch; do not reuse a previous census after reopening.

Start with orphan-only batches and preserve every committed revision. A full board census that cannot fit within the measured pause budget is a reason to defer, not to delete using a stale scan. A future per-revision retirement protocol can improve concurrency under a separate design review.

Suggested conservative rollout values: quarantine at least 48 hours for ordinary boards, batch at most 100 documents and target admission pauses under 2 seconds, all configurable. The development synthetic canary may explicitly bypass the waiting interval only when its generated board is marked `sceneMaintenanceCanary`; it still runs the same fresh fenced census, upload/chunk ownership checks, transactional delete and independent post-delete oracle. This exception is dev-only and never applies to ordinary boards. The delay is a rollout cushion, not a safety proof: upload leases, pins, fencing and fresh reachability remain mandatory regardless of age. If the implementation cannot meet a target, shrink/defer work. Honor database transaction limits and rule access-call limits verified for the deployed SDK; do not hard-code an assumed maximum transaction size.

Do not automatically delete external image bytes in this phase. Coordinate any future asset collector with ADR 003 and every asset consumer/retained version. Never infer asset unreachability from current live elements alone. Deleting a parent Firestore document does not constitute recursive collection; explicitly enumerate eligible subcollections.

## Chunk repacking

1. Pin committed revision R and generation G. Compute deterministic records using the existing UTF-8 byte budget/reserve. Preserve all logical fields, tombstones, bindings, ordering, files and unknown supported scene state.
2. Pack without previous membership into fresh immutable chunks; reuse identical eligible chunks when safe. Stage as a protected maintenance upload. Preflight total candidate bytes/chunks and temporary storage overhead.
3. Publish through shared validation only if `(headRevisionId, generation) == (R, G)`. Do not resolve a repack conflict by replacing a newer scene or merging an old layout snapshot; abandon and reschedule from the new head.
4. Keep generation unchanged. Protect R through pins/history policy. GC eventually collects obsolete layout data if eligible.

Do not assume globally optimal bin packing. The goal is meaningful savings under deterministic bounded work. Initial trigger suggestion: at least two chunks saved and at least 25% fewer chunks, with a per-board cooldown. Measure byte savings too. Ordinary edits keep stable membership; new elements need not fill every old hole. Never repack on each Delete keypress or on every head notification.

During collaboration repacking may retry on ordinary saves; it never takes RTDB as a separate content authority. Active rooms are allowed for layout-only repacks. Maintain undo and selection because element identities/content do not change. Use `reason: maintenance` metadata so layout revisions need not clutter future user-visible automatic history.

## Compact deletion records

Introduce a versioned scene representation only after GC and layout-only repacking are proven. Format v1 readers must not encounter format v2 payloads; deploy compatible readers/writers and enforce minimum capability before writing v2. Cache keys and receipts include the relevant format/generation. Unknown formats preserve drafts and report upgrade-required.

Undo is scoped to the in-memory editor session for one board and one tab. Navigating away from that board, closing/reloading the tab, switching boards, or losing network connectivity ends that session's undo capability; undo history is not persisted across sessions. Clear the editor's undo stack when the board session ends or the browser/RTDB connection drops. Compaction may proceed only after a durable admission fence prevents new joins/writes and all existing sessions for that board have closed or been safely fenced out. Presence absence by itself is not sufficient. A tab returning after compaction must load the latest head and clear stale local undo history before accepting edits; preserve pending offline work for explicit recovery rather than replaying a stale undo into the live board. The server still records first-observed deletion time for canonical metadata and audit, but it is not an undo-retention timer. Out-of-order saves must not reset this clock or compact a later resurrection. Do not compact an ID that is currently live under the canonical conflict comparison. This is distinct from committed-history expiry: automatic history expiry and deletion remain disabled until separately reviewed.

For compacted tombstones store ID, version, nonce and any additional fields required by the existing comparator. The existing higher-version/lower-nonce comparison is the compatibility baseline; do not replace it with timestamps or blanket deletion-wins semantics. Current-generation intentional undo/recreation may win only under the established version rules. If an update wins, remove its compact deletion record atomically with publishing the live element. IDs are never reused accidentally.

The deletion ledger is part of the immutable, hashed internal scene revision. Merge it in browser, callable validation, trusted checkpoints, RTDB overlays and cold hydration. It counts toward scene/chunk limits and loads before accepting edits. The `.excalidraw` format is a point-in-time canvas snapshot, not a board backup: it intentionally excludes deletion-ledger metadata, board history and recovery state. Import applies that snapshot as an explicit canvas replacement while the destination board's server-owned ledger remains authoritative. Do not feed compact ledger records or stripped, invalid elements to Excalidraw; add an explicit adapter or retain a compatible representation after testing the library contract.

Metadata cannot recover deleted geometry/text for undo. Once a board session ends, its undo stack is gone; compacted content is recoverable only through retained board history, not ordinary Undo. Initially skip compaction during an active collaboration room and defer boards with uncertain session state. A later expansion requires dedicated collab/undo tests; one client's absence is not proof that all undo histories have ended.

## Permanent tombstone removal and generation reset

This is a semantic change, unlike repacking. Retain compact deletion records indefinitely within a generation. Reclaim them only by publishing a clean snapshot in generation G+1, with all earlier writers fenced. A fixed age or zero presence is insufficient.

1. Pin the current revision and create a retained pre-reset recovery version. Check storage headroom; do not remove the recovery root to make the operation fit.
2. Prepare a validated clean snapshot without full/compact deleted elements, preserving live elements, their bindings, scene semantics and required files. Broken references must follow explicit existing editor semantics, not arbitrary pruning. Copy chunk metadata/payload into G+1-compatible records: current readers require chunk generation equality.
3. Close admission for a reset using a monotonic operation token. Initially defer if a collaboration room is active. Establish a durable transition state that prevents new room joins and old-room writes/checkpoints, not just a presence query.
4. Fence the old RTDB room generation and reconcile its acknowledged deltas into the final source snapshot, or prove it is already drained. Abort/defer if that cannot be proven. Firestore and RTDB have no joint transaction: keep admission closed during the transition, persist each step, and make retries recoverable.
5. Atomically compare expected head/G, publish the validated G+1 head and operation receipt, then activate the G+1 room policy and reopen admission. If the expected source changed, restart preparation. Never reopen a state where old-room data can enter the new generation.
6. Late triggers and reconnects carrying G are rejected/quarantined. Clean clients reload; clients with pending local edits retain their old draft and enter explicit recovery. Acknowledge only the edits proven committed before the cutover.

Choose a durable transition state machine such as `prepared → fenced → published → activated` plus token-fenced cancellation before publication. Crash recovery completes or safely cancels the recorded phase; after publication it must finish activation rather than roll the head back. Initial resets may briefly pause collab admission; they must not silently discard acknowledged RTDB edits. UI acknowledgment of RTDB acceptance alone must not be mislabeled durable Firestore publication.

Recovery initially offers **save/export the stale draft as a separate board**. Do not automatically merge all its elements into G+1, change the draft's generation field to force acceptance, or recover only the visible canvas while dropping semantic state/assets. Preserve source identity, access checks and asset-copy rules. Automatic selective recovery needs a durable operation log/base diff and a separate conflict design.

An offline draft has no server retention pin. It remains recoverable locally but cannot require unlimited retention of arbitrary remote assets; document missing-asset handling and preserve descriptors/local bytes when present. No promise of unlimited offline asset availability is implied.

## Future board versioning

- Register named/automatic versions as explicit protected roots before exposing them in UI. Pin before listing/detail preview races can reach an eligible revision; expired entries must report unavailable rather than dereference freed chunks.
- Phase 4 implementation registers owner-created named roots for the current committed revision, lists them to authorized readers, and loads exact revisions under a separate expiring `history-preview` reader pin. Preview does not overlay RTDB. Until retention and recovery-window policy is reviewed, named roots cannot be deleted and no committed revision is eligible for collection.
- Named versions remain until explicit authorized deletion. Automatic history needs a reviewed retention policy before pruning is enabled. Track any recovery holds separately.
- Preview/export loads the exact historical revision and format under a reader pin. It must not overlay today's RTDB deltas or repair the historical payload in place.
- Restore validates access/assets/schema and creates a new head in a **new monotonically increasing generation**, using the reset state machine. It does not rewind the generation or reuse old generation-tagged chunk documents blindly.
- Retain a pre-restore recovery root. Existing named versions remain unchanged; GC removes only unreferenced data after retention and reader protection expire.
- Duplication into a new board must honor asset ownership rules. Future UML/semantic state and unknown supported fields participate in hashes, repacking, recovery and historical round trips.

## Implementation phases and exit gates

| Phase | Deliverables | Required exit gate |
| --- | --- | --- |
| 0 — Inventory and observability | Enumerate every reader, writer, upload/bootstrap shape, RTDB ingress and asset reference. Add reachable/stored-byte metrics, dry-run planner, protocol capability/version metadata and a bounded maintenance module interface. | Classified fixture corpus; dry-run never deletes; missing provenance/unsupported data reported. No existing runtime changed. |
| 1 — Protection before deletion | Admission epoch/token, worker recovery, reader pins, upload/base protection, version roots, rules and Admin SDK fencing; clients preserve drafts and retry maintenance busy responses. | Integration tests prove every writer/reader participates. Legacy clients cannot bypass the protocol; destructive flag remains off until minimum-client enforcement is demonstrated. |
| 2 — Orphan GC | Quarantine, fresh fenced census, transactional batches, crash recovery, receipt metadata policy, audit artifacts and kill switch. Preserve all committed revisions/assets. | **Passed 2026-10-21:** emulator race/chaos tests and three development synthetic canaries agree with independent reachability oracles; bounded pause measured; only generated orphan chunks deleted. No 48-hour production canary is required for this zero-user product. The configured 48-hour ordinary-object quarantine is a separate safety delay; synthetic dev canaries have a marker-gated fast path. |
| 3 — Layout-only repacking | Deterministic repack, savings threshold/cooldown, protected staging and expected-head publication. | **Passed 2026-10-21:** backend tests cover both repack/checkpoint race orders, semantic equality, savings, cooldown, unauthorized request and no-op loop prevention; Puppeteer invokes the owner callable over Functions emulator, verifies unchanged records, then cold-loads all elements after 22-to-4 chunk repack. Broader scene E2E passes. |
| 4 — History retention | Explicit retained-root registration, automatic retention policy, named-version lifecycle and exact historical readers. UI may ship separately. | In progress: named roots and exact historical reads are implemented and emulator-tested; automatic expiry/deletion stays disabled. Full gate requires a reviewed retention and recovery-window policy before any committed revision becomes eligible. |
| 5 — Compact tombstones | Format/protocol rollout, deletion ledger, conflict comparator compatibility, tab-and-board-session-scoped undo and integration across internal scene merge paths. Undo ends on tab/board exit or disconnect. After the last session ends, the abandoned-room worker may compact full tombstones only inside the closed RTDB admission fence. Reconnect first pauses edits, reloads the latest canonical head and invalidates stale undo; RTDB presence and deltas carry a server-minted connection epoch whose token is invalidated on disconnect. | **Passed 2026-10-21:** old-client rejection, server-authored deletion metadata, session-end undo invalidation, higher-version resurrection, stale offline merge and internal scene round trips pass. Emulator Puppeteer uses two tabs to draw/delete, undo, disconnect, compact after final presence drop, load the compacted board and reject stale epochs. A live synthetic dev RTDB-trigger test also passed: current head has compact metadata while the immutable prior revision keeps the full tombstone. `SCENE_TOMBSTONE_COMPACTION_ENABLED` is enabled only in Firebase dev project `open-excalidraw-dev-2`; default and production remain off. `.excalidraw` remains point-in-time canvas interchange, and automatic history expiry remains disabled. |
| 6 — Generation cleanup and restore | Durable RTDB/Firestore transition state machine, minimum client capability, validated G+1 snapshots, pre-reset history and stale-draft save/export-as-new-board UX. | **Passed 2026-10-21 for explicit owner-triggered restore:** owner-only prepare/fence/publish/activate callables create a protected pre-restore version, defer while sessions or deltas remain, fence both stores, publish a validated clean immutable G+1 snapshot, and reopen both stores in a crash-recoverable order. Collaboration tokens, presence and active sessions are generation-bound; rules reject old-generation writes/reconnect tokens. The transition unit suite covers monotonic/token-fenced recovery; emulator tests cover session/delta deferral, tampered source, idempotent publish/activate and recovery after Firestore reopened but RTDB remained fenced. Puppeteer creates and edits a board, invokes the real client restore service, then verifies the G+1 head, open gates and restored canvas on cold load. Stale drafts remain local and offer save-as-new-board/download actions. The browser suite does not yet click those two recovery buttons directly. Automatic reset workers, automatic history expiry/deletion and production deployment remain disabled and require separate decisions. |

Each phase is independently reviewable and feature flagged. Do not combine a first GC rollout with scene format changes or generation resets. At minimum expose separate flags for destructive GC, committed-history expiry, repacking, ledger writes and generation resets. Production deployment is a separate authorized action; this ADR does not deploy anything.

### Instructions for the implementing agent

- Start by adding a completed/pending checklist to the implementation handoff, tied to the phase gates above. Mark a phase complete only with command outcomes and saved test evidence, not because its code exists.
- Audit every generation/format default, including implicit generation 1 in client commit callers, draft migrations and legacy RTDB room handling. Carry the actual loaded generation end to end; never repair a rejected write by substituting the newest generation without reloading and resolving its draft.
- Specify one shared busy/retry result (for example `unavailable` with maintenance reason and bounded retry delay), a generation-conflict result and an expired-history result. Callers must distinguish them from authorization failure, corruption and unsupported format. Do not retry all failures indefinitely.
- Extend Firestore/RTDB rule tests alongside every schema/admission change. Minimum-client enforcement must rely on required protocol fields and server/rule validation; a client-provided capability boolean alone is not proof that an old write is safe.
- Keep the collector disabled when adding new root types or readers until their protection is integrated. Missing coverage is a release blocker, not an acceptable temporary orphan risk.

## Edge cases and prescribed outcomes

| Case | Outcome |
| --- | --- |
| Upload dies before any/all pages exist | Preserve until upload expiry and lease end; derive owned chunks from trusted upload identity, then quarantine. Never treat missing pages as an empty committed scene. |
| Validator crashes after writing revision but before head/receipt | Protect active lease/output; after expiry an unpublished revision is an orphan, unless another root retained it. Retry receipt/head checks before restaging. |
| Root/version/pin appears during quarantine | Fresh census preserves it. Root admission is closed during destructive census/batches. |
| Worker A stalls and B takes over | B advances epoch/token. A's next transaction fails; it cannot delete using an old cursor/proof. |
| Gate lease expires | Gate remains closed; recovery owns reopening. Client retries are bounded and local journal remains writable. |
| Pin expires while tab is suspended | No expired-pin renewal. Reacquire/restart; never continue assembly based on deleted partial input. |
| Board/project deleted or access revoked mid-job | Reauthorize public operations, stop publishing and honor deletion/recovery policy; do not resurrect metadata. Collector uses verified ownership and explicit deleted-board policy, not access failure as proof of garbage. |
| Corrupt page/digest, missing chunk, unknown schema | Stop destructive work, retain evidence, surface recovery; do not infer the unreadable chunk's outgoing asset references are empty. |
| Late RTDB write / last-user dropout / new join | Layout-only repack uses head CAS; generation reset uses durable room fencing and checkpoints. Presence and existing RTDB compaction lock alone are not sufficient. |
| High-version live edit competes with compact deletion | Apply existing comparator exactly; do not make compact tombstones permanently defeat valid undo. |
| All elements deleted | Preserve required header/appState and deletion ledger until a safe reset. Empty visible canvas does not imply zero chunks or no historical assets. |
| Storage quota/oversized record during repack/reset | Abort before head publication, retain old scene/draft, report capacity; stage growth and temporary duplication count toward limits. |
| Named version removed during export | Existing unexpired export pin protects payload. New requests follow current authorization/retention outcome. |
| History/receipt pruned then old request replayed | Enforce documented idempotency window; never recreate an old head. Expired request requires restaging/recovery against current generation. |

## Detailed testing plan

### Harness, isolation and evidence

Extend the existing emulator/Puppeteer suites; destructive tests must refuse non-demo project IDs and missing emulator configuration. Use separate browser contexts for Alice/Bob/Carol, persistent profiles for restart/offline cases, and an independent Admin SDK verifier that does **not** reuse the collector's reachability implementation.

Use injected server clock, deterministic barriers and controllable worker tokens for backend ordering; browser network throttling is complementary, not a substitute. Wait for concrete UI/network/receipt conditions with deadlines, not sleeps as assertions. Test direct Firestore SDK operations as an authenticated legacy/adversarial client, not only fixtures that bypass rules through Admin SDK.

Record seed, job/epoch, head/generation, roots, leases, candidate decisions, acknowledged edit IDs, before/after object counts and byte totals. Capture sanitized request outcomes, console/page errors and screenshots on E2E failure. Never log auth tokens, credentials or user scene content. Verify actual process exit codes; dry-run screenshots are not evidence that deletion is safe.

Existing commands (run serially where emulator ports conflict):

```sh
pnpm check
pnpm lint
pnpm build
pnpm test:scenes
pnpm test:scenes:backend
pnpm test:e2e:scenes
pnpm test:e2e:scenes:five-chunks
```

Dedicated maintenance planner, dry-run, GC/oracle/chaos, backend and Puppeteer tests are wired into `package.json` and the regression runner. Existing tests alone do not establish the guarantees in this ADR.

### Unit and property tests

- Repack 1, 5 and many chunks with Unicode, nearly-full records, large custom data, freehand points, z-order, groups, frames, bindings, files and structured UML-like fixtures. Assert byte budgets, unique IDs, deterministic digests and semantic equality before/after; compare scene records, not chunk order alone.
- Delete zero/some/all elements; verify full tombstones and compact ledger semantics. Count both live and deleted records. Test repeated delete, intentional undo, equal-version nonce ties, malformed IDs and large deletion ledgers.
- Generate merge permutations across live/full-deleted/compact-deleted forms and compare against the existing comparator. Assert idempotence and convergence for supported inputs; test tie behaviour explicitly rather than assuming arbitrary conflicting ties converge.
- Independently model the object graph: shared chunks across revisions, multiple generations, all root types, incomplete uploads, missing provenance and unknown formats. Collector never deletes a reachable node. Test eligible orphan reclamation too; an implementation that never deletes is not sufficient.
- Exercise retention boundary times, skewed browser clocks, lease expiry/renewal, pagination boundaries, retry limits and resumed cursors. Test exactly-before/at/after expiry using the authoritative clock.

### Backend integration and security tests

Use barriers around census, validation, final publish, gate acquisition and each delete batch. Execute both orders for every race:

| ID | Interleaving / assertion |
| --- | --- |
| M01 | Save publishes before gate closes vs after closure: new head protected or save retries; no dangling references. |
| M02 | GC proposal precedes reader/version pin: pin wins before closure and protects data, or acquisition waits/retries. |
| M03 | Validator starts before closure, finishes during GC: protected lease/output and fenced publication; no reuse of deleted chunks. |
| M04 | Upload/page/chunk creation during closed admission, expiry, or old generation: direct SDK request denied; authorized restage works afterward. |
| M05 | Two workers, expired lease, takeover and delayed transaction retry: only current token can delete/reopen/publish. |
| M06 | Kill worker after each quarantine/census/delete step: restart completes idempotently; old head and protected history always load. |
| M07 | Delete one page/chunk fails transiently: cursor/checkpoint reflects actual outcome; retries do not skip undeleted objects or delete protected replacements. |
| M08 | Expired upload has active validation lease vs no lease; incomplete pages and reused base chunks: correct protection and eventual reclamation. |
| M09 | Receipt response lost, replay after repack/GC, later head already exists: exact acknowledgement or documented expiry, never head regression. |
| M10 | Revoked editor, viewer, anonymous link user, wrong owner/project and deleted parent: no unauthorized pins/version roots/maintenance mutation; authorized viewer can pin a readable revision only. |
| M11 | Malformed/missing manifest or legacy provenance: destructive skip with diagnostic; no partial mark treated as complete. |
| M12 | Retention expiry vs named-version creation/export/restore: root wins before gate or operation retries/unavailable; never a partial retained version. |
| M13 | Inject a trusted Admin checkpoint/bootstrap/version writer during GC: it obeys the same fence despite bypassing rules. |
| M14 | Bootstrapping board, purged upload metadata with remaining chunks, duplicate scheduler events and board-ID ownership collision: preserve unknowns and do not collect another owner's data. |

Assert writes denied by rules as well as forbidden maintenance metadata reads/writes. Test pin quotas, maximum targets/TTL and no target-set expansion on renewal. Ensure auth expiry/App Check failure leaves local data intact and does not grant maintenance privileges.

### Puppeteer normal-flow and network assertions

1. Create a board through UI; add editable blocks/text and sufficient data for multiple chunks. Verify visible content, exact durable head and sync status. Exercise native Delete, undo, file import, reload, export and duplicate rather than fixture-only mutations. `.excalidraw` import/export asserts the canvas content at that point in time; it does not assert board history, server deletion clocks or recovery metadata.
2. Open the five-chunk fixture and record actual chunk count/bytes. Trigger the owner-authorized `repackBoardScene` callable. For layout-only savings use a deliberately fragmented fixture; deleting elements alone does not remove full tombstone payload. After ledger compaction, test a separate large-deletion fixture. Assert logical equality, expected count/byte reduction and correct cold load in a fresh context.
   - Phase 5 emulator E2E must use two real browser tabs to activate lazy collaboration, draw and delete through Excalidraw, verify undo while the originating tab remains open, commit the full tombstone, close all sessions, and observe automatic abandoned-room compaction. Assert the new head omits the full deleted element, the immutable historical revision still contains it, a fresh tab renders the compacted board, and replayed old-epoch presence/deltas are denied. Keep the feature flag off by default; the test runner opts in only for its isolated demo project.
   - The trusted maintenance checkpoint must not be blocked by the per-user interactive reader-pin quota: maintenance holds the closed board fence, reads a pinned exact revision, and releases its own pin. Its new immutable head preserves all prior reader roots, so this exception does not authorize history or chunk deletion.
3. Attach network listeners before navigation: record Firestore SDK request paths/outcomes and callable attempts/receipts (SDK requests may multiplex). Assert only manifest-referenced chunks are loaded logically, no collection-wide scan from the browser, no unrelated chunks rewritten, and bounded retries. Use SDK instrumentation/backend verification for per-document assertions when wire traffic is multiplexed.
4. During maintenance assert local editing/journaling continues and cloud save resumes after reopening. Never display 'saved to cloud' for merely queued edits. Check one global action-based loader, bounded loading percentage (no chunk terminology), eventual dismissal and editor readiness before input.
5. Reload/restart with persisted IndexedDB after a lost response. Assert latest acknowledged content, retained pending newer edits, no duplicate element/import resurrection and no endless save/head-notification loop.
6. Named history preview/export remains exact while current board changes; restore increments generation and retains both original history and pre-restore recovery state. Viewers cannot restore or bypass current access by using a known historical ID.

### Collaboration, dropouts and offline matrix

- Alice moves X while Bob edits Y during repack; both acknowledged edits survive in UI, RTDB and a fresh cloud-only load. Repeat same-element edit/delete with known version/nonce winners.
- Three users drop out one by one, reconnect, crash or close tabs. Race abandoned-room checkpoint, repack and GC. Verify final cloud union, exact checkpoint cleanup and survival of newer same-ID RTDB records.
- Partition one collaborator while others delete and compact. Reconnect within G: compact deletion records preserve normal conflict outcomes. Reconnect after G+1: old deltas/checkpoints are fenced and local draft recovery is offered without resurrection.
- Keep solo user offline across deletion, GC and reset; test process restart, multiple tabs, sign-out/sign-in as another account and expired access. Recovery remains scoped to the original identity and never auto-uploads to the wrong board.
- Begin reset at the same instant as room join/late delta. Crash between RTDB fencing, final drain, Firestore publication and room activation, in each phase. Recover using operation token; no old room merges into G+1 and no acknowledged accepted delta silently disappears.
- Restore a historical version while collaborators are active: initial implementation defers/requests a controlled pause; it must not proceed based only on a transient empty-presence snapshot. Test race of a clean client vs one with pending edits on generation notification.
- Undo on the active board tab works. Navigating away, switching boards, closing/reloading ends that undo session. Compaction is blocked while a session remains active; after compaction, a returning/offline tab reloads the latest head and invalidates old undo before edits. Test stale higher-version edits and intentional valid resurrection separately.

### Chaos, scale and rollout acceptance

- Throttle bandwidth/latency, go offline mid-pin/mid-chunk/mid-upload, drop callable responses after successful commit, inject 429/5xx/permission errors and kill the worker/browser. Test duplicate delivery and out-of-order responses, not only request failures.
- Suspend a reader beyond pin TTL; allow GC to run, then resume. Assert restart/unavailable handling with no partial canvas and preserved local draft. Repeat export and history preview.
- Soak 3–5 editors on at least 20 chunks for 30 minutes, with repeated deletions, repacks, partitions and staggered dropouts. Track bounded retry queues, memory, pins, scheduler overlap, storage growth, admission pause duration and read/write amplification.
- Include a 5–10 MB fixture with large individual records and a many-small-elements fixture; verify each record fits the current chunk budget. The existing exact-five-chunk test is approximately 1.9 MB and is not evidence of a 5 MB test. Add separately named cases for size and chunk count.
- Run repeated GC cycles: eligible garbage eventually disappears, reachable bytes remain constant, and idle boards do not generate recurring layout revisions. Test policy version changes and minimum-client rollout, including a cached pre-maintenance production bundle.
- Before production: all invariants pass, dry-run vs independent oracle agrees, corrupt-data skips are observable, crash recovery reopens gates, legacy clients cannot bypass fences, and canary save/load latency meets the measured target. Enable destructive orphan GC only after this gate. Evaluate each later destructive feature separately.

## Rollout, rollback and operational limits

Deploy compatible readers, backend guards and security rules before enabling destructive workers. Old clients cannot safely be grandfathered into collection: require capability enforcement or leave deletion disabled. Test offline cached bundles and service-worker/browser caches, not just freshly built clients.

Metrics: live/deleted/ledger bytes, stored/reachable/quarantined/reclaimed bytes, chunk utilization, pins by purpose, active/stuck gates, worker epochs, failed fences, retries, ambiguous receipts, generation conflicts and recovery outcomes. Alert on prolonged closed admission, dangling-reference checks, unknown provenance growth and no-progress jobs. Avoid per-scene content in telemetry.

Kill switches stop new destructive batches, fence/cancel workers and explicitly reopen safe gates. Turning a scheduler off alone is insufficient when a worker is already running. Physical deletion is irreversible unless a verified backup/retained root exists; rollback cannot resurrect collected payload. After format or generation rollout, never roll back to a writer that ignores ledger semantics or generation fencing. Prefer disabling maintenance while keeping compatible readers/writers.

## Alternatives considered

| Alternative | Why not selected |
| --- | --- |
| Delete tombstones/chunks after N days | Time does not prove unreachability or that offline clients have advanced. |
| Repack on every edit/delete | Rewrites stable chunks, increases contention/cost and still retains deletion payload. |
| Stop at a simple head-only mark-and-sweep | Breaks uploads, active readers, retained history and concurrent publication. |
| Require every device to acknowledge deletion | Cannot finish for permanently offline/lost devices without an expiry/recovery policy. |
| Move solo persistence to RTDB | Unnecessary transport/connection change; does not solve offline resurrection or history reachability. |
| Per-chunk reference counts immediately | Distributed increments/decrements, incomplete uploads and crash repair add complexity. Explicit roots and a fenced census provide a simpler initial proof. |
| Always keep every revision/tombstone | Safe baseline but unbounded storage and growing load costs; retain until each destructive phase is proven. |

## Consequences and implementation questions

This adds coordination reads, reader-pin traffic and short publication delays. Offline drafts may require explicit recovery after a generation reset. Retained versions consume storage independently of current-board size. These costs are accepted to prevent resurrection and silent data loss.

Resolved: no mandatory RTDB for solo mode; no in-place chunk edits; no automatic merging across generations; no age-only deletion; no asset GC in the initial rollout; no committed-history expiry without a reviewed retention policy.

Tuning remains open: automatic history duration, pin TTL/quota, quarantine delay, batch/pause budget and repack threshold. The user selected tab-and-board-session-scoped undo; there is no fixed full-tombstone undo duration. The compaction session fence and stale-tab recovery behavior have been tested; the feature is enabled in dev only, and remains off by default and in production. Generation reset during active collaboration must first fence and drain the old room; do not treat presence absence as proof that RTDB deltas are drained.

Phase 6 explicit restore is implemented and verified in emulators. The owner-only prepare, fence, publish and activate callables protect the selected historical revision and a pre-restore recovery root; defer while sessions or uncheckpointed RTDB deltas remain; publish a clean immutable G+1 head with both stores gated; and reopen admission in a crash-recoverable order. Collaboration tokens and RTDB rules bind writes/reconnects to the loaded generation. Backend tests exercise deferral, tampered input, retry and partial-activation recovery; Puppeteer verifies the client restore flow and cold-loaded canvas. Stale-draft save/download recovery actions are implemented, although those buttons do not yet have dedicated browser assertions. This does not enable automatic resets, committed-history deletion, or production deployment.
