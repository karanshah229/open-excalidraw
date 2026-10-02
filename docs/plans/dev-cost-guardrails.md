# Development-project cost guardrails

Target project: `open-excalidraw-dev-2`.

## Non-negotiable facts

- A Cloud Billing budget requires a linked billing account; it cannot be created while the project is Spark-only.
- Budget alerts report delayed estimated spend. They are not a Firestore spending cap.
- The application must not use Firestore for liveness. RTDB transport presence is the only supported liveness mechanism.

## Create immediately after billing is linked

Create one project-scoped budget with a user-approved monthly cap and send every alert to the verified owner email. Configure actual-spend thresholds at **25%, 50%, 75%, 90%, and 100%**, plus forecast thresholds at **75%, 90%, and 100%**.

Create these Cloud Monitoring policies:

| Priority | Policy                       | Trigger                                                         | Response                                             |
| -------- | ---------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| Page     | Any quota exceeded           | `serviceruntime.googleapis.com/quota/exceeded > 0` for 1 minute | Stop test runs; investigate immediately.             |
| Urgent   | Firestore write quota >= 80% | Usage/limit ratio for the daily write quota                     | Stop high-volume E2E and inspect write sources.      |
| Urgent   | Firestore write quota >= 95% | Same metric                                                     | Freeze nonessential test traffic.                    |
| Warning  | Cloud Functions errors       | Any error-rate spike sustained for 5 minutes                    | Disable affected test workflow; inspect logs.        |
| Warning  | RTDB denied writes           | Security-rule denial log metric above baseline                  | Stop deployment; fix authorization before retesting. |

## Safe rollout gates

1. Link billing, but do **not** deploy Functions, Storage rules, or Hosting yet.
2. Create the budget, notification channel, and Monitoring policies; verify a test notification arrives.
3. Deploy Firestore/RTDB rules, then Cloud Functions.
4. Run one two-browser smoke test and check the quota dashboard.
5. Run the full live suite only if the smoke test shows normal write volume.

## Cost containment in this repository

- No Firestore liveness heartbeat or stale-session writes.
- RTDB connection lifecycle uses server-side `onDisconnect`, eliminating timer-driven document writes.
- Dragging is batched; only final element mutations are durable collaboration writes.
- Tests must use the new dev project and always close their browser contexts.

## Required user decision

Choose the maximum monthly spend for this development project. A conservative starting cap is **US$10/month**; production should use a separately approved cap and notification channel.
