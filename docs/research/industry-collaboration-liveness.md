# Industry collaboration liveness: public patterns

Research date: 2026-10-01. This records public, primary-source evidence. Google Docs and Figma do not publish enough protocol detail to attribute a specific presence algorithm to them.

## The common architecture

| Concern            | Established pattern                                                              | Consequence for this board                                                             |
| ------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Transport liveness | The realtime transport owns connection detection (ping/pong, close, reconnect).  | Do not add a Firestore polling/heartbeat loop. RTDB owns equivalent connection health. |
| Presence           | Per-connection, ephemeral membership; one person in two tabs is two connections. | One RTDB child per tab/session, removed server-side on disconnect.                     |
| Document truth     | Ordered operations or durable snapshots are independent of membership.           | Presence must never decide whether an edit was saved or which scene wins.              |
| Reconnect          | Resync/reconcile from authoritative state; report lost/restored/failed state.    | Re-read/reconcile canonical scene after reconnect; surface unsynced/offline state.     |

## Evidence from mature collaboration systems

**Microsoft Fluid / Live Share.** Fluid Relay sequences operations at the service and broadcasts the sequenced stream, so clients converge from the operation sequence rather than from presence. Microsoft separately describes `LivePresence` / `LiveState` / `LiveEvent` as ephemeral and not written to the Fluid container; presence tracks each _connection_ and can take up to 20 seconds to report a disconnected user offline. Fluid's Audience API also treats a person in multiple tabs/devices as multiple connections and requires membership-change subscriptions, not an assumption of instantaneous membership. [Fluid Relay overview](https://learn.microsoft.com/en-us/azure/azure-fluid-relay/overview/overview), [Teams Live Share capabilities](https://learn.microsoft.com/en-us/microsoftteams/platform/apps-in-teams-meetings/teams-live-share-capabilities), [Fluid Audience](https://learn.microsoft.com/en-us/azure/azure-fluid-relay/how-tos/use-audience-in-fluid)

**Socket.IO / Excalidraw OSS.** Engine.IO sends server ping/client pong and closes the connection when the deadline is missed; Socket.IO layers automatic reconnect, ACKs, buffering, and optional recovery above that transport. Yet its default delivery is at-most-once: clients must explicitly persist/replay missed events or resynchronise after a disconnect. Excalidraw's room server drives membership from socket join/disconnect events, not a client database heartbeat. [Socket.IO transport liveness](https://socket.io/docs/v4/how-it-works/), [delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/), [Excalidraw room server](https://github.com/excalidraw/excalidraw-room/blob/master/src/index.ts)

**Liveblocks.** Liveblocks exposes connection states for lost/restored/failed UI and treats Presence separately from durable Storage. It warns that offline mutations are not persisted or synchronized until reconnection, and its reconnect path can retain local undo/redo state. That distinction is important: reconnecting a transport is not proof that durable state is safely reconciled. [Liveblocks client API](https://liveblocks.io/docs/api-reference/liveblocks-client), [reauthentication and state preservation](https://liveblocks.io/docs/guides/reauthenticate-without-reloading-the-page-or-losing-state)

**Yjs / Hocuspocus.** Yjs awareness is intentionally ephemeral: it is not stored in the document and is removed when a client goes offline. Hocuspocus implements awareness as a separate CRDT with no update history, exposes connection/sync/awareness lifecycle events, and offers bounded retry failure so applications can present an offline/retry UI. It batches outgoing updates to reduce write/message amplification. [Yjs awareness](https://docs.yjs.dev/getting-started/adding-awareness), [Hocuspocus awareness](https://tiptap.dev/docs/hocuspocus/guides/awareness), [provider reconnection and batching](https://tiptap.dev/docs/hocuspocus/provider/configuration)

## Applied decision

For this app, use RTDB `/.info/connected` plus `onDisconnect(sessionRef).remove()` as the connection-authoritative presence primitive. On every reconnect, register the disconnect action **before** publishing the tab-specific session record. Do not timestamp-expire an otherwise idle connected tab. A bounded ghost window is unavoidable: it is the server's transport failure-detection time, not an application correctness failure.

Keep the lobby/presence record ephemeral and non-authoritative. Durable element changes need their own idempotent reconciliation, canonical persistence, and retry/error UX. Expose at least `connecting`, `online`, `reconnecting`, `offline`, and `syncing/saved`; do not silently claim success during a transport failure.

## Failure tests implied by the evidence

- Two tabs for one account: distinct session records; closing either leaves the other present.
- Abrupt tab/process death and network loss: record eventually disappears by server detection; idle connected tab remains.
- Reconnect race: `onDisconnect` is re-armed before session publication, with no permanent ghost.
- Edits during a partition and missed realtime messages: reconnect performs canonical reconciliation; presence changes cannot overwrite board state.
- Offline/retry/error UI: authentication failure, permanent reconnect failure, and unsynced durable work are observable and actionable.
