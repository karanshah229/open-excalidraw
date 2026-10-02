# Collaboration liveness patterns

Research date: 2026-10-01. This separates public evidence from inference; Google Docs and Excalidraw+ do not publish their production presence implementation.

## What Google Docs publicly establishes

Google does not document the connection, heartbeat, reconnection, or stale-presence protocol behind Google Docs. Its public Drive API exposes file changes and permission roles, not the editor's real-time session protocol. Therefore, claims that Google Docs uses a particular heartbeat interval, OT/CRDT implementation, or timeout would be speculation. [Drive API reference](https://developers.google.com/workspace/drive/api/reference/rest/v3), [Drive roles](https://developers.google.com/workspace/drive/api/guides/ref-roles)

The relevant product lesson is architectural, not an implementation detail: separate durable document state from ephemeral collaborator presence. Durable edits require an ordered/reconcilable operation or state protocol; presence is advisory UI state and must never determine whether an edit is retained.

## Excalidraw open-source reference implementation

The open-source app uses a Socket.IO collaboration server. On `join-room`, the server joins the socket to the room, enumerates server-known sockets, and broadcasts the resulting socket-id list. On `disconnecting`, it enumerates the remaining sockets and broadcasts the reduced list. Thus collaborator existence is driven by server transport membership, not a client-maintained database heartbeat. [Room server source](https://github.com/excalidraw/excalidraw-room/blob/master/src/index.ts), [client collaboration source](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/collab/Collab.tsx)

Socket.IO/Engine.IO supplies the liveness mechanism beneath that membership: the server sends ping, requires pong within its negotiated timeout, and closes the connection on failure. Socket.IO also offers automatic reconnection, but its base delivery guarantee does **not** replay events missed while a client was disconnected; a robust application must resynchronise durable scene state after reconnect. [Socket.IO transport and heartbeat](https://socket.io/docs/v4/how-it-works/), [Socket.IO delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/)

Excalidraw's client explicitly reconciles a received scene against local elements and applies remote changes with `captureUpdate: NEVER`, avoiding rebroadcast/history pollution. It has a fallback when the initial scene message is missing and separately throttles durable scene saves. Its pointer/idle traffic is for collaborator UI state, not durable liveness. [Collab client source](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/collab/Collab.tsx)

Excalidraw+ publicly advertises cloud saving and real-time collaboration, but no public technical material located in this research describes its presence/liveness implementation. It should not be presented as evidence for a particular protocol. [Excalidraw+ product comparison](https://plus.excalidraw.com/pricing)

## Recommended pattern for this app

Use RTDB's connection-scoped presence primitive:

1. Subscribe to `/.info/connected` for the local client's actual RTDB connection state.
2. On each `true` transition, first attach `onDisconnect(sessionRef).remove()`, await its acknowledgement, then write that **tab/session-specific** presence record. Ordering prevents a crash between write and disconnect registration from creating a ghost.
3. On reconnect, repeat the same registration and write. Other clients regard record existence as collaborator liveness; they do not age out an idle-but-connected tab from a client timestamp.
4. Keep a separate `lastDisconnectedAt` server timestamp only for audit/UI, not liveness. Make durable scene sync independently reconcile/seed state after reconnect, because presence cannot prove durable state delivery.
5. Treat presence as advisory: a disconnect can take until the service detects a lost transport, and a stale/duplicate record must not grant edit authority or alter the canonical board.

Firebase documents this exact multi-device pattern: one connection child per device/tab, `onDisconnect().remove()` registered before `set()`, and re-registration from `/.info/connected`; it also documents that `onDisconnect` is held and executed by the server after clean close, timeout, or crash. [RTDB web offline and presence docs](https://firebase.google.com/docs/database/web/offline-capabilities)

This eliminates the Firestore 15-second liveness write loop. It does not eliminate transport-level heartbeats: RTDB maintains its own connection health internally, analogous to Socket.IO's ping/pong. Application code should not duplicate it with billable Firestore writes.

## Verification cases

- Open two tabs for one user: both must create distinct records; closing one must leave the user present through the other.
- Kill a tab/process and cut network: remote presence must disappear only after RTDB detects the disconnected transport, never from inactivity.
- Drop and restore network: the reconnect path must re-arm `onDisconnect` before republishing presence.
- Deliver edits while one client is offline: on reconnect it must reconcile durable board state; presence alone cannot repair lost events.
