# Audit of ADR 007: conflicts and ambiguities

- Date: 2026-10-11
- Scope: every line of [ADR 007](../decisions/007-board-version-history-and-restore.md), including six diagrams, with the current save/notes/chunk-publication code checked where relevant.
- Initial result: one clear behavioral conflict and nine material ambiguities.
- Resolution status: all ten findings resolved in ADR 007 on 2026-10-11, following the user’s instruction to resolve them using implementation judgment. Runtime implementation and its validation remain future work.
- Line numbers and proposed resolutions below describe the original review, before the subsequent ADR update. They are historical findings, not outstanding questions. The resolution table links to the controlling contracts now in the ADR.

## Resolution record

| Finding | Resolution in ADR 007 |
| --- | --- |
| 1. Local-only ancestors | [Local outbox and Firebase publication](../decisions/007-board-version-history-and-restore.md#local-outbox-and-firebase-publication): cloud restore discards unacknowledged work; local-only restore retains committed target/ancestors and hides descendants. Claim uploads only eligible history. |
| 2. Imported branch cutoff | [Imported lineage and restore cutoffs](../decisions/007-board-version-history-and-restore.md#imported-lineage-and-restore-cutoffs): explicit parent/order and epoch admission; restore inherits only selected ancestry. Both L1 and V2 examples specify which branches disappear. |
| 3. Save boundary | [Logical save boundaries](../decisions/007-board-version-history-and-restore.md#logical-save-boundaries): 450 ms canvas, 600 ms notes, committed rename/explicit flush; recovery journals are separate. Every successful changed logical commit is retained. |
| 4. Receipts/reconciliation | [Publication receipts and reconciliation](../decisions/007-board-version-history-and-restore.md#publication-receipts-and-reconciliation): stable capture versus head identities, exact/divergent/no-op/conflict outcomes, original expiry, and separate history/head acknowledgements. |
| 5. Expiry while restoring | [Expiry during an acquired restore](../decisions/007-board-version-history-and-restore.md#expiry-during-an-acquired-restore): unexpired acquisition; operation-scoped exception until fixed deadline; no authorization inheritance or indefinite renewal. |
| 6. Aborted restore/fence | [Retained work after a failed restore](../decisions/007-board-version-history-and-restore.md#retained-work-after-a-failed-restore): keep drafts, resolve receipts, reauthorize/rebase onto released fence with fresh head/staging attempts. Successful generation replacement still discards. |
| 7. Field conflicts | [Per-field mutation and conflict contract](../decisions/007-board-version-history-and-restore.md#per-field-mutation-and-conflict-contract): explicit patches/bases, scene LWW, name/per-slide note compare-and-set, typed conflicts and explicit retry decisions. |
| 8. Stable reads | [Immutable content read contexts](../decisions/007-board-version-history-and-restore.md#immutable-content-read-contexts): fixed manifest context survives ordinary saves, but restore/revocation invalidates it; bounded in-flight expiry exception is separate from physical pins. |
| 9. Imported chunk reuse | [History-only chunk import contract](../decisions/007-board-version-history-and-restore.md#history-only-chunk-import-contract): dedicated validation of same-board/generation authorized sources and candidate bytes, transactional resource reservation, no change to normal reuse authorization. |
| 10. Storage full | [Retain safely for 30 days](../decisions/007-board-version-history-and-restore.md#7-retain-safely-for-30-days): entire atomic logical save fails; edits stay pending with truthful failure status, no partial successful save or silent trimming. |

Acceptance-test requirements were extended for these contracts. The ADR also clarifies expired Current display, imported timeline ordering, and ambiguous upload acknowledgement at local expiry. Remaining engineering details concern concrete storage/worker/rule implementation, measured budgets, migration, and rollout; they do not supersede these resolutions.

## 1. Local-only restore conflicts with retaining active ancestors

**Priority:** high. **Type:** behavioral conflict. **ADR lines:** 48, 195, 239, 294.

The ADR says to delete all old-generation unsynced historical versions after restore, keep eligible ancestors, and allow signed-out local-only restore. On a never-synced local board, every historical version is unsynced. Restoring local V2 from V1 -> V2 -> V3 therefore deletes V1/V2 as well as V3, although the branch example says V1/V2 remain eligible ancestors.

**Proposed resolution:** distinguish cloud-board invalidation from local-only branching. A cloud restore discards unacknowledged old-generation work as agreed. A local-only restore retains eligible ancestors/target, hides descendants, and creates a new local branch. This needs an explicit product decision rather than silently applying an exception.

## 2. Imported local versions have no complete branch-cutoff rule

**Priority:** high. **Type:** incomplete data model/behavior. **ADR lines:** 120, 150, 197, 231, 235, 239.

Cloud versions have ordered head changes; offline-import entries may omit `contentSequence` and are expressly not global historical states. They are nevertheless selectable restore targets. The schema does not specify a local-parent chain or a cutoff order for them.

Example: L1/L2 were edited offline from cloud V1, while collaborators produced V2/V3. L1/L2 upload later without becoming the head. If the user restores L1, which of V2/V3/L2 remain active? `sourceBaseVersionId` alone cannot identify local ordering or establish a shared global position. Upload time must not decide this.

**Proposed resolution:** define local snapshot lineage/order explicitly. A possible rule is to fork from the source-base cloud prefix plus the selected local-parent prefix, excluding the abandoned current descendants. Specify it with this example and repeated restores before finalizing the branch schema or allowing imported targets.

## 3. “Every successful save” does not identify the capture boundary

**Priority:** high. **Type:** ambiguous version granularity. **ADR lines:** 41, 207, 213, 330.

The current code has different persistence events: owned canvas saves are debounced at 450 ms; shared drafts are journaled immediately; note drafts are written as typing happens while cloud note sync waits 600 ms. Taking every successful low-level local write literally makes shared drawings and note typing much more granular than owned canvas history. The storage assumptions count successful scene saves but do not define whether recovery journal writes are versions.

**Proposed resolution:** define an explicit logical content-save event distinct from crash-recovery journaling, including the exact canvas/name/note triggers. If every draft write is intentionally a version, state that and size the system accordingly. A debounce choice should not silently override the user's every-successful-save requirement.

## 4. Local/canonical reconciliation and no-op commits lack a complete receipt contract

**Priority:** high. **Type:** ambiguous capture/deduplication. **ADR lines:** 109, 152, 209, 226-228, 231.

The ADR requires preserving local snapshots, associating them with potentially different reconciled cloud content, and avoiding duplicates. It does not say whether two distinct snapshots produce two cloud history entries, how they are linked, or what happens if a local save differs from its previous local state but reconciles to the already-current cloud state. The content commit can be a no-op while the local historical snapshot still requires preservation.

**Proposed resolution:** specify outcomes for identical publication, divergent canonical publication, and canonical no-op. Distinguish `localVersionId`, optional imported snapshot version ID, canonical version ID, and mutation receipt; compare content against the correct base. Deduplicate retries by identity rather than suppressing distinct historical snapshots solely because canonical content is unchanged.

## 5. Expired-target rejection needs an explicit restore-pin exception

**Priority:** high. **Type:** authorization/retention ambiguity. **ADR lines:** 257, 287, 292, 314, 380.

History operations reject expired versions, but a valid target pin is supposed to let an in-progress restore finish after expiry. The ADR does not make explicit whether final validation and target loading use that operation-scoped exception. Implementations could still reject a target that expires between acquisition and publication, despite the promise that the pin prevents this.

**Proposed resolution:** require an unexpired target when the operation acquires its pin; afterward authorize only that restore operation through a bounded valid pin, while rechecking role, active lineage, and fence. The pin cannot authorize a new restore or extend normal history visibility. Define renewal/expiry limits for recovery workers.

## 6. Failed restore changes the fence but has no queued-save recovery rule

**Priority:** high. **Type:** incomplete failure recovery. **ADR lines:** 34, 235, 288, 298, 302-304.

A restore increments the fence even if it aborts before changing generation. Drafts must remain, and stale-fence mutations must fail. The outbox schema does not include an expected fence, nor define how valid retained work resumes after that abort. Blindly replaying violates the fence; blindly discarding violates the failed-restore guarantee.

**Proposed resolution:** distinguish content generation from operation fence in every writer contract. After confirmed abort, reauthorize/rebase retained work onto the released fence. Resolve ambiguous receipts before restaging with fresh candidate IDs. Never adopt an old generation after successful replacement. Specify handling of operations frozen while the lock was active.

## 7. Complete snapshots need per-field conflict semantics for names and notes

**Priority:** high. **Type:** incomplete concurrency contract. **ADR lines:** 109, 154, 207, 225, 231.

“Preserve unrelated current content” states the invariant but not how a complete local tuple identifies what the user actually changed. A stale scene save with old name/notes must not overwrite a concurrent rename or note edit. Two writers changing the same name or same slide note also need a defined outcome. Element LWW does not define these outcomes.

**Proposed resolution:** carry explicit mutation intent and base identities for scene, name, and per-slide notes. Define compare-and-set/conflict behavior for same-field changes; preserve unrelated fields from the latest head. Specify how the existing note conflict UI and optimistic rename flow use these results.

## 8. Multi-chunk reads need a stable authorization/consistency context

**Priority:** high. **Type:** incomplete gateway contract. **ADR lines:** 201, 247, 257, 285, 314.

The gateway restricts current versus eligible historical reads, permits reader pins, and can force a fresh load after a head change. Without a defined read context, an actively edited large board may never finish loading as the head changes between chunk requests. Conversely, simply letting a pin retain authorization could bypass the rule forbidding new inactive-history reads after restore.

**Proposed resolution:** define a bounded scene-read lease for a specific immutable manifest. Ordinary saves within the same generation can permit completion of the acquired current-scene read while newer content loads afterward. Restore/branch invalidation and access revocation must terminate contexts as required; a physical retention pin alone is not an authorization grant. Specify behavior at history expiry and test sustained head churn.

## 9. History-only imports need a separate chunk-reuse validation protocol

**Priority:** medium/high. **Type:** gap between proposed behavior and existing publication code. **ADR lines:** 148, 221, 224, 231, 237, 320-344.

The current `commitSceneCandidate` allows reused chunks only from the expected committed scene base; other chunks must have been staged by the same candidate. L1 can be published as history without becoming the head, so L2 cannot automatically reuse L1's chunks through the existing candidate protocol. Without a new import contract, implementations may reject valid imports or copy nearly every offline snapshot, defeating the storage model.

**Proposed resolution:** define how the history-only callable validates and pins reusable chunks from authorized imported/local lineage without advancing the head. Enforce board/generation/digest/ownership constraints and deletion fencing. Do not loosen normal commit validation indiscriminately. Update estimates/tests if history imports initially require full copies.

## 10. Storage-full behavior does not settle whether content save succeeds

**Priority:** medium/high. **Type:** ambiguous failure policy. **ADR lines:** 207, 213, 316, 346.

Content, immutable history, and outbox are required to persist atomically. The storage-full section says to report failed version recording and not call the save fully history-protected, leaving open whether the current content may still be saved without a version. Those two policies produce different guarantees.

**Proposed resolution:** choose and document either atomic failure of the entire logical save (keep edits pending/in memory and report local-save failure), or an explicitly approved degraded content-only mode. The latter changes the every-successful-save guarantee. Never silently drop history or report durable success for data that only exists in memory.

## Details intentionally still open at initial review

Worker technology, exact note storage paths, numerical lease/read/upload budgets, resource-reservation implementation, UI grouping, and staged rollout are explicitly marked as engineering decisions in the ADR. Their absence is not itself a contradiction. However, exact contracts must be resolved before claiming the design is implementation-complete.

Other details to specify with those contracts: which persisted canvas settings belong to the board versus personal preferences; current-version display after its history expiry; timeline ordering for imported entries; acknowledgement state after an offline local expiry cutoff; local clock-skew handling; and current-scene/note/metadata cache refresh after restore. None should change the user's agreed permissions, 30-day cloud acceptance clock, immediate inactive-lineage exclusion, or destructive treatment of old cloud-generation unsynced work.

## Confirmed consistent points

- Complete versions reference immutable chunks rather than separate board IDs or diff replay.
- Branch membership and write generation serve different purposes.
- Inactive descendants are unavailable immediately, while their bytes may remain until safe cleanup under original expiry.
- Cloud retention starts on first successful server acceptance; retries do not extend it.
- Current content remains durable regardless of historical expiry.
- Version publication belongs in the content commit transaction, not an asynchronous after-save trigger.
- Modal display cannot synchronously reach an offline tab; server fences enforce the replacement on reconnect.
- Payload bytes already downloaded to a device cannot be remotely revoked.

## Original recommended resolution order (completed in the ADR)

First settle local-only restore scope, logical save boundaries, and imported-snapshot branch placement. Then define the publication/receipt, per-field concurrency, restore-pin/fence, and reader contracts. Finally validate imported chunk reuse and storage-full behavior with deterministic tests before finalizing migration and resource budgets.
