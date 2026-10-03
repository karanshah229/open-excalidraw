# Freemium usage, exemptions and alerts

Status: original product proposal, 2026-10-03. Implementation status, actual schema, tests and deployment requirements are recorded in [Freemium rollout](freemium-rollout.md). Prices: $6/month or $60/year per owner account. These are application quotas, not individual Firebase free-tier entitlements. Thresholds below are launch defaults to validate with observed usage. Nothing here enables billing, enforcement or production privileges yet.

## Product policy

Pool the hosted infrastructure budget, expose predictable owner-level limits, and attribute shared-board activity to its owner. Never charge a guest merely for accepting an invitation. Keep local editing, exports, the existing local MCP workflow and self-hosted software available without a subscription. Each self-hosting operator pays their own infrastructure costs; zero-cost Firebase hosting is not guaranteed.

Plan precedence: active verified-email complimentary entitlement, then active paid subscription, then hosted Free. Complimentary accounts receive permanent Pro without checkout, renewal or subscription charges. They bypass free-plan restrictions, remain metered for cost visibility, and retain platform safety limits and the Pro resource allowances below. They are not administrators automatically.

## Initial economics policy

The user authorized using conservative best-guess limits now and deferring the economics-monitoring agent. No new monitoring agent or recurring pricing automation is part of this implementation. Treat these values as versioned launch policy, configurable through an admin-only `adminConfig/freemiumPolicy` document when policy resolution ships. Do not change subscribed prices automatically; subsequent pricing changes require an explicit commercial rollout.

Prices remain **$6/month or $60/year**. Start with a **$10/month hosted-free subsidy target in production**, excluding paying and complimentary accounts; development gets a separate **$5/month operational target**. These are soft operational budgets, not guaranteed spending caps. Complimentary usage is accounted for separately as owner-approved consumption, not silently charged to the public-free budget. Do not automatically expand the free subsidy with subscription revenue at launch.

| Resource | Hosted Free | Hosted Pro and complimentary Pro |
| --- | --- | --- |
| Retained cloud board count | 3 | Unlimited count within retained document/storage allowances |
| Retained image asset bytes | 25 MiB | 1 GiB |
| Single cloud image | Smaller than 5 MiB | Smaller than 10 MiB |
| Retained current board document bytes, owner-wide | Bound by 3 boards, each at most 900 KiB | 100 MiB total across actual private/shared copies |
| Board document safety ceiling | 900 KiB | 900 KiB |
| Simultaneous live sessions per board | 3 | 10 |
| Successful logical scene commits per UTC day | 1,000 | 5,000 |
| Recovery history | Last 10 snapshots per board, at most 7 days old | Last 50 snapshots per board, at most 30 days old, and 250 MiB history total per owner |
| Controlled asset payload delivery per UTC month, once serving is implemented | 250 MiB | 2 GiB |
| Serialized collaboration element safety ceiling | Smaller than 256 KiB UTF-8 | Smaller than 256 KiB UTF-8 |

Warn at 80%, show critical at 95%, and reject quota-increasing operations beyond the allowance; retain the board-specific size thresholds already defined below. Pro's history pool is a retention ceiling: prune oldest eligible history after a new recovery snapshot is durable, not current scenes or pending recovery. Universal safety ceilings remain for every entitlement. Counts and bytes include actual duplicate private/shared copies. Advertise unlimited boards with published storage allowances, not unlimited infrastructure.

Set cost safeguards as well as resource quotas: coalesce durable cloud commits to at most one every 5 seconds per board in the background, skip unchanged scenes, and retain explicit flush on departure/transitions. This batching must preserve current live element collaboration and truthful pending-cloud status. Cap cursor updates at 10 per second and batch observational telemetry; do not write cursor counters to Firestore. Guest activity is attributed to the owner. These defaults must be validated against current collaboration behavior before shipping.

Aim for paid infrastructure to average **at most $1.50 per subscriber/month** before payment fees/support. This is an engineering target, not a measured forecast or a hard per-subscriber bill cap. Detect unusually costly accounts for manual investigation, never automatically invoice overages. RTDB/Firestore delivery and request overhead still need aggregate metrics and estimates; asset delivery allowances do not cap all Firebase egress. Pricing/allowance tuning is manual until the future economics agent is explicitly built.

## Proposed restrictions and free-user alerts

All limits are per board owner unless otherwise stated. MiB and KiB use binary units. At a quota, reject only operations that would exceed it; preserve local work and permit deletion, cleanup and export. Lowering an account's plan does not delete its data.

| Feature | Free allowance / safety ceiling | Warning | Critical / reached | Action |
| --- | --- | --- | --- | --- |
| Cloud boards | 3 retained cloud boards | After board 2 is created | At board 3 | Block a fourth cloud board; offer local creation, permanent cloud deletion or upgrade. Archiving/trash retains the slot until purged. |
| Retained image assets | 25 MiB total, including retained undo assets and private/shared duplicates | 20 MiB (80%) | 23.75 MiB (95%); quota at 25 MiB | Preflight the whole upload; reject uploads exceeding the remaining bytes. Only confirmed object deletion frees usage. |
| Single uploaded image | Smaller than 5 MiB | At 4 MiB | At or above 5 MiB | Offer compression, replacement or local-only storage. Upgrade may permit the existing smaller-than-10-MiB ceiling. |
| Saved Firestore board document | At most 900 KiB measured document size, all plans | 700 KiB | 850 KiB; reject above 900 KiB | Explain that cloud board capacity is nearly reached; offer splitting/export. Includes metadata, references and encoding; excludes external image bytes. Subscription cannot remove Firebase's 1 MiB hard ceiling. |
| Live collaboration | 3 simultaneous authenticated sessions per board, including owner and viewers | Explain capacity when the third session joins | Fourth session attempts to join | Reject the new live session, preserve existing sessions, offer a non-live snapshot or upgrade. Tabs consume separate sessions. |
| Cloud saves | 1,000 successful logical scene commits per UTC day, owner-wide | 800 | 950; quota at 1,000 | Local editing/autosave continues; queue only the latest pending scene per board for next period or upgrade. No quota charge for no-op, failed or duplicate commits. Internal database writes are separately metered as infrastructure usage. |
| Recovery history | Last 10 snapshots per board, at most 7 days old, whichever retains fewer | Persistent disclosure when history is used | Show each snapshot's expiry; no repeated quota toast | Prune older snapshots only after a replacement is durable. Do not advertise interactive restore until a restore UI exists. Preserve current board, local undo and pending recovery data. |
| Serialized collaboration element | Smaller than 256 KiB UTF-8, all plans | 200 KiB | 240 KiB; reject at 256 KiB | Replace current silent broadcast skip with a specific message; preserve locally. Align client/server byte counting and RTDB rules; current rules use character length. |
| Cloud asset downloads (phase 2) | 250 MiB of delivered asset payload per UTC calendar month | 200 MiB | 237.5 MiB; quota at 250 MiB | Requires authenticated, controlled serving. Reject new asset deliveries beyond quota; cached/local files remain usable. Include guest downloads against owner. This is not total Firebase bandwidth. |

All features not listed above retain full editor behavior. No free limit on local board count, projects/folders, invitations, core drawing tools, local exports or local MCP operations. Cloud board slots still apply across projects. AI provider usage stays user-supplied; no unlimited hosted AI credit promise.

Daily/monthly application quotas use UTC and display the reset in the user's timezone. Firebase daily free allowances reset on their own schedule; do not equate product periods to billing periods. Publish the Pro allowances above before checkout is enabled.

## Server-owned usage and entitlement data

- `accountEntitlements/{uid}`: effective plan, source (`complimentary`, `subscription`, `free`), policy version and timestamps. Clients can read only their own effective entitlement, never write it.
- `accountUsage/{uid}`: retained board count and asset bytes; current period counters. Clients read only their own compact summary. These records describe product usage, not a bill.
- `accountUsage/{uid}/assets/{assetKey}`: bucket/path, generation, retained bytes and status. Private/shared copies count separately unless they share the same actual object.
- `accountUsage/{uid}/periods/{periodKey}`: logical commits and controlled asset payload deliveries. Use server timestamps; operation IDs make retries idempotent. Pending reservations have expiration and reconciliation.
- `adminConfig/complimentaryUsers`: admin-only configuration document with `version`, an `emails` array of normalized verified-email addresses, and `updatedAt`. Firebase Console/IAM administrators or the Admin SDK manage entries; all ordinary client read/write access is denied. Never expose other family addresses. For this small family list, one document is simpler than a separate entry collection.
- Board ownership is authoritative and immutable through guest APIs. Ownership transfer must atomically check destination capacity and transfer usage before changing access.

Validate the Firebase ID token and verified email. Trim and lowercase email; do not strip plus tags or Gmail dots. Reject anonymous/unverified identities for exemptions. Resolve a grant only for its matching current verified email; re-evaluate on email changes, list removal and each protected mutation. Custom claims can help UI/rules but are cached and are not the authoritative entitlement record. [Firebase custom claims](https://firebase.google.com/docs/auth/admin/custom-claims)

The source of truth is now Firestore, not a local file. On 2026-10-03, `adminConfig/complimentaryUsers` was created and read back in both default databases: development (`open-excalidraw-dev-2`) and production (`open-excalidraw-b2ab4`). The existing production document was preserved when development was added. The user's requested owner email was added and verified in both lists on 2026-10-03 using an atomic append that preserves existing entries. Actual email addresses remain in Firebase rather than this repository. Deployed rules in both projects were read from the Firebase Rules API and verified to have no client allow rule for this collection. Client access is denied; no rules deployment was needed. The new server resolver reads these documents; it will become live when the compatible Functions/client/rules release is deployed.

Manage the list in [Firebase Console](https://console.firebase.google.com/project/open-excalidraw-b2ab4/firestore/data): open `adminConfig` → `complimentaryUsers`, edit the `emails` array, and update the audit timestamp. Removing an email revokes its complimentary entitlement on the next protected request after the new resolver is deployed; its subscription, if active, then determines the plan. The [development list](https://console.firebase.google.com/project/open-excalidraw-dev-2/firestore/data) already exists. Lists are separate per environment; add an email in both to grant access in both. Do not automatically copy private production emails into development.

Current document shape:

```json
{
  "version": 1,
  "emails": ["<verified email addresses managed in Firebase>"],
  "updatedAt": "Firestore timestamp"
}
```

## Enforcement and metering

1. Route cloud creation, scene commits and access-policy changes through authenticated server endpoints. In the same transaction, authorize owner/editor, check entitlement/capacity, write scene revisions and update product counters. Keep browser IndexedDB persistence and optimistic revision reconciliation. Firestore transactions are a supported basis for write-time aggregates. [Aggregation guidance](https://firebase.google.com/docs/firestore/solutions/aggregation)
2. Tighten Firestore rules to reject direct client bypass of gated mutations and counters; preserve authorized reads. Coordinate this with client rollout so older clients cannot silently fail. Count logical scene commits once even if private and shared copies both update; account for their actual operations separately. Coalesce saves, avoid no-op writes, and mirror access only when access policy changes.
3. Reserve upload bytes atomically before upload. Authorize a single immutable asset path/size with short-lived permission; Storage rules must validate that grant. Deduplicate retries, reconcile object finalize/delete events by generation, and refund expired unused reservations after checking for orphan uploads. Whole-upload failures leave existing cloud scenes intact. [Storage lifecycle events](https://firebase.google.com/docs/storage/extend-with-functions)
4. Admit sessions through a server-controlled RTDB transaction, including anonymous guests. Expiring grants and server cleanup/onDisconnect prevent crashed tabs from holding slots. RTDB rules require an admitted session for live reads/writes; an owner cannot be locked out permanently by stale guests. Do not use Firestore presence heartbeats.
5. Use scheduled retention and object garbage collection with live references, undo retention and in-flight reservations checked before deletion. Soft-deleted cloud boards retain slots/assets until permanently purged. Backfill current usage by inventory before enabling enforcement, with audit/report-only rollout and no silent deletion of existing over-limit accounts.
6. Serve assets through a controlled authenticated path in phase 2 if download quotas are to be enforceable. Reserve delivery bytes before streaming and reconcile delivery outcomes; prevent alternate direct-download URLs from bypassing quotas. Infrastructure bandwidth includes retries and overhead and will differ from product delivered-byte accounting. Native RTDB and Firestore listeners do not provide exact per-user billed traffic; estimates must never be labelled exact or hard-billed-user quotas. [RTDB billing](https://firebase.google.com/docs/database/usage/billing)

No Firestore write for every cursor movement or UI warning. Session payload estimates can be sampled and batched; they are observational and untrusted for enforcement. Retained bytes/commits come from server-confirmed operations. Reconciliation repairs drift without a full inventory scan on each login. Counters and reconciliation also cost money, so measure their amplification and contention.

## In-product communication

- Account usage screen: plan, cloud boards, retained image storage, daily saves, live capacity, reset times and complimentary badge. Add asset download quota when controlled serving ships.
- Board/sync dropdown: separate cloud document size, asset size and local/export size; never reuse the current embedded-image JSON file-size metric for Firestore quotas.
- One dismissible message when a warning threshold is crossed; deduplicate across tabs and remember dismissal per metric/period. Re-arm after usage falls below the warning band; no warning spam on each save.
- Persistent critical banner at 95% or the table's board-specific critical threshold. At quota, show the affected action's inline error and relevant recovery options. Do not mark work synced when it is only local; provide local backup export. Do not imply unsaved shared guest edits are durable unless they actually are.
- Example: “Cloud image storage: 20 of 25 MiB used. Remove unused images or upgrade.” At a daily save cap: “Cloud sync paused until [local reset time]. Changes are saved on this device.” Render that statement only after local persistence succeeds.
- Do not show free-quota upgrade prompts to complimentary users. Show platform-size/safety warnings and actual save failures to all plans.

## Shared project budget

Track free, paid and complimentary usage separately, but remember Firebase allowances apply to shared resources. Define an internal free-service budget with capacity reserved for paid users and background recovery. At 80% alert the operator, at 90% reduce free admissions/expensive background work, and at 95% pause new free cloud mutations or asset deliveries with explicit local fallback. These are conservative operational thresholds, not user-owned Firebase entitlements.

Use service-level usage metrics and delayed Cloud Billing data for aggregate validation. Operations, egress and deployment costs do not all fit one counter. Budget alerts are not spending caps, and continuing existing reads still incurs costs; strict zero-subsidy free use must remain local/self-hosted. Initial budget targets are $10/month for production public-free usage and $5/month for development as defined above; this planning update creates no cloud budget or notifications. Public-free attribution is an estimate, so the internal gate must include headroom and project-wide cost checks.

## Implementation sequence and validation

Infrastructure recheck, 2026-10-03: both development and production application image buckets now exist in Mumbai (`ASIA-SOUTH1`). Missing bucket provisioning is no longer a prerequisite. Confirm frontend bucket configuration, CORS and deployed Storage rules during implementation validation; do not assume the US-only new-bucket storage free allowance applies to Mumbai.

1. Entitlement policy and server-side Firebase allowlist resolution, verified-email validation, compact usage API. Populate supplied emails in `adminConfig/complimentaryUsers`; test exemptions without introducing checkout. Configuration, resolver and emulator tests are implemented; application deployment is pending.
2. Inventory/backfill and report-only counters; fix cloud document-size measurement and display passive warnings. Existing accounts retain access during measurement.
3. Gate creation/commits/uploads/sessions; atomically maintain counters; enable enforceable quotas after compatible client/rules deployment. Add retention/cleanup and global circuit breakers.
4. Account usage view and action-specific banners; exercise offline/reload/multiple-tab behavior and quota reset paths.
5. Subscription checkout and verified idempotent provider webhooks; expiry/cancellation/downgrade behavior and Pro allowances. Complimentary users never need a subscription. Treat upgrades as server-side entitlements, not redirect success flags.
6. Controlled asset serving/download quotas, measured cost reconciliation and tuning of free/Pro allowances.

Use emulator integration tests for concurrent quota allocation, duplicate commits/events, upload rollback, denied direct SDK writes, stale sessions, guest attribution, revocation/email changes, retained/deleted assets, counter backfill, and downgrade preservation. Test UI threshold transitions and local-save truthfulness. Run TypeScript/lint checks for changed code, then a small production smoke test with usage review. Environment mutations so far are creation of the admin-only complimentary lists in development and production and addition of the user-supplied owner email to both; no enforcement code or application deployment has occurred.
