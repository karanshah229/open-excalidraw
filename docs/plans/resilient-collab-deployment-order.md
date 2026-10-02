# Resilient collaboration deployment order

1. Build and deploy Cloud Functions. The access-mirror trigger and compactor must exist before clients are constrained by the new rules.
2. Run `pnpm --filter @agentic-whiteboard/functions build` then `pnpm --filter @agentic-whiteboard/functions backfill:access` with production Firebase Admin credentials. Confirm every `boardShares/{boardId}` has an RTDB `boardAccess/{boardId}` record.
3. Deploy Firestore, RTDB, and Storage rules together.
4. Deploy the web client. Monitor permission-denied errors and compaction logs before enabling any broader rollout.

Never deploy the RTDB rules before completing step 2: absent access mirrors intentionally deny reads and writes.
