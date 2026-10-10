# Large-board storage: approaches and public evidence

Research date: 2026-10-10. Architecture proposals below are judgments; vendor implementations are attributed only where primary sources disclose them.

## Recommendation

Use compressed, immutable **Cloud Storage snapshots + durable incremental changes**, retaining Firestore for metadata, permissions, and the committed snapshot pointer. This fits the app's existing RTDB element updates and compaction better than introducing spatially partial scenes. Add partial loading separately when measured board-opening or rendering costs justify it.

Firestore's limit is **1 MiB per document**, not per board or subcollection. Child documents do not count toward their parent's limit. [Quotas](https://firebase.google.com/docs/firestore/quotas), [size calculations](https://firebase.google.com/docs/firestore/storage-size)

## Alternatives

| Approach | Advantages | Costs / limitations |
| --- | --- | --- |
| Spatial tiles + viewport loading | Transfer and hold only visible regions; improves genuinely huge canvases. | Large/cross-tile shapes, arrows, bindings, groups, z-order, moving objects, selection, search and exports need coordinated loading. A dense tile can still exceed 1 MiB. More editor work than a storage-only fix. |
| Whole scene in Cloud Storage | Simple format, no Firestore scene-size ceiling; cheap snapshots and straightforward export/history. | Whole-board download/parse and upload costs grow with board size. Concurrent writers need revision checks or a single authority. Storage alone supplies no element synchronization. |
| One Firestore document per element | Natural record model; only changed elements written; per-element subscriptions and independent edits. | Thousands of document reads on open and listener/write costs during editing. Ordering, deletes and bulk edits need coordination; an unusually large freehand element still needs splitting/offloading. [Billing](https://firebase.google.com/docs/firestore/pricing) |
| Byte-budget Firestore chunks | Keeps Firebase workflow; fewer reads than per-element docs; independent chunks remove board-level ceiling. | Repartitioning and manifests add complexity; dirty chunk rewrites amplify writes. Use serialized-byte budgets with headroom, not fixed element counts; immutable generations prevent mixed old/new scenes. |
| Snapshot + change journal | Small edit payloads; large compressed snapshots; efficient recovery and potential history. Strong industry precedent. | Requires reliable checkpoint publication, idempotent replay, deletion/tombstone handling and compaction. App's current element-state deltas are not automatically a historical operation journal. |
| Record database + WebSocket room service | Fine-grained durable edits, controlled ordering/merging; can later support partial loading and richer queries. | Largest infrastructure/migration burden: room routing, reconnect, offline handling, authorization and operating the sync service. tldraw offers a concrete example. |

Compression inside the existing Firestore scene is a stopgap: it increases typical capacity but retains the same hard ceiling. OT/CRDT describes **merging/synchronization**, not the storage-size solution; it can accompany records, chunks or snapshots.

## What other applications publicly document

| Application | Verified pattern and applicability |
| --- | --- |
| Figma | Its 2022 engineering article describes active state in memory, WebSocket updates, compressed S3 checkpoints and a DynamoDB journal with sequence numbers. Recovery reads the checkpoint and replays newer changes. This supports the snapshot + journal pattern; it is historical documentation rather than a claim about every current service. [Reliability](https://www.figma.com/blog/making-multiplayer-more-reliable/) |
| Figma partial loading | Its 2024 article documents loading pages and their read/write dependencies on demand. This is logical partitioning, not evidence that Figma stores boards as geographic tiles. Editable partial loading requires dependency handling. [Dynamic page loading](https://www.figma.com/blog/speeding-up-file-load-times-one-page-at-a-time/) |
| Google Docs | Google's 2010 engineering posts describe chronological document changes and operational transformation. They establish incremental collaboration but do not disclose today's storage/chunking topology. [Engineering explanation](https://drive.googleblog.com/2010/09/whats-different-about-new-google-docs_21.html) |
| Word for the web | WOPI partner documentation says Microsoft manages concurrent changes/merges internally, while periodically saving the updated document to the storage host; Word calls PutFile every 30 seconds when edited. Therefore full-file persistence can coexist with fast live editing. This external interface does not reveal Microsoft's internal storage architecture. [Coauthoring](https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/online/scenarios/coauth) |
| tldraw | Current sync documentation recommends SQLite persistence for document records behind WebSocket rooms; large binary assets use object storage. Older R2 room-snapshot examples should not be mistaken for its current persistence recommendation. [Sync](https://tldraw.dev/docs/sync) |
| Excalidraw open source | The public app saves an encrypted whole collaboration scene in a Firestore document and separately uploads binary files to Storage. This does not demonstrate a large-board persistence solution or disclose Excalidraw+ internals. [Source](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/data/firebase.ts) |
| Excalidraw+ | June 2026 changelog reports migration away from Firebase Realtime, but does not disclose scene storage/partitioning. Its precise backend cannot be responsibly inferred from the open-source app. [Changelog](https://plus.excalidraw.com/changelog) |
| Miro | Reviewed official sources expose item APIs, not backend storage topology. Miro's help documents a 100,000-object cap and recommends fewer than 5,000 for performance: removing the persistence cap alone does not eliminate browser/rendering constraints. [Board performance](https://help.miro.com/hc/en-us/articles/360013588560-Board-performance-and-loading-issues) |

## Latency and correctness implications

Object storage latency primarily affects **cold open and checkpoints** if edits update locally and sync small deltas independently. Region locality, compression, IndexedDB caching and background snapshotting can reduce its impact; benchmark representative boards before claiming a concrete latency improvement.

Publish a new immutable snapshot first, then transactionally advance the Firestore pointer and the checkpoint boundary. Never discard deltas until that pointer commit succeeds; retain/replay changes arriving during upload. Cloud Storage and Firestore do not share one cross-service transaction. Generation preconditions can protect object writes, but do not replace board revision coordination. [Cloud Storage preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions)

Migration must cover every scene-bearing workflow: board open/save, collaboration compaction, shared boards, version history, exports, restore and deletion. Existing Storage assets should remain separate from scene payloads.
