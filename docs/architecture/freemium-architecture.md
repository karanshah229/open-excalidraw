# Freemium architecture

This describes the implemented workspace changes. Eight freemium callable Functions are deployed to dev for live validation, and the local app runs on port 15176 against real dev Firebase. The hosted application, restrictive rules and new background jobs remain undeployed; existing dev project-sharing rules/triggers were preserved for other worktrees. Production is unchanged. The complimentary list is configured in both dev and prod. Each environment has its own Firebase resources and configuration.

Dev additionally has the narrow own-session-grant read/deletion rule needed for live disconnect cleanup. Existing RTDB rule nodes were preserved; the remaining freemium rules are still pending rollout.

## System diagram

```mermaid
flowchart TB
  subgraph Browser[React application]
    Editor[Board editor and collaboration]
    Local[(IndexedDB<br/>Private boards and guest recovery)]
    API[Cloud API client<br/>Authenticated callable requests]
    UI[Plan dialog, usage meters<br/>Warnings and quota errors]
    Editor -->|Save locally| Local
    Editor --> API
    UI -->|Refresh usage or request Pro| API
    API -->|Usage, warnings, rejected operations| UI
  end

  subgraph Server[Firebase Cloud Functions]
    Calls[Board commits, image reservations<br/>Session admission, live deltas, deletion<br/>Usage summary and Pro requests]
    Policy[Check identity and board access<br/>Resolve owner plan and applicable limits]
    Atomic[Firestore transactions<br/>Quota allocation and retry deduplication]
    Calls -->|Protected mutations| Policy
    Calls -->|Commits and reservations| Atomic
    Policy -->|Limits and Free pool gate| Atomic
  end

  subgraph Firebase[Firebase data and security rules]
    Auth[Firebase Auth<br/>Current identity and verified email]
    Config[(Admin-only Firestore configuration<br/>Complimentary emails, manual Pro grants<br/>Free pool cap and pause switch)]
    FS[(Firestore<br/>Private and shared boards, history<br/>Owner usage, pooled saves, operation IDs<br/>Upload grants and Pro access requests)]
    Storage[(Cloud Storage<br/>Immutable image objects)]
    RTDB[(Realtime Database<br/>Session grants, access policy<br/>Live elements, cursors and presence)]
  end

  API --> Calls
  Auth -->|Validate caller and owner identity| Calls
  Auth -->|Verified owner email| Policy
  Config --> Policy
  Atomic -->|Board and ledger written atomically| FS
  Calls -->|Allocate session slots and write live deltas| RTDB
  Calls -->|Permanent object deletion| Storage
  API -->|Direct image upload with server grant<br/>Storage rules check path, size, MIME and uploader| Storage
  API <-->|Authorized reads and admitted presence/cursors<br/>RTDB rules check access and session grant| RTDB
  API -->|Authorized board and asset reads| FS
  API -->|Authorized image reads| Storage

  subgraph Background[Background functions]
    Objects[Object finalized / deleted<br/>Confirm uploads and refund bytes]
    Recovery[Empty-room compactor<br/>Persist scene and recovery snapshot]
    Cleanup[Hourly cleanup<br/>Expired reservations, old operation IDs<br/>History retention]
    Mirror[Sharing access mirror<br/>Only when access policy changes]
  end

  Storage --> Objects --> FS
  RTDB -->|Last presence leaves, then grace period| Recovery --> FS
  FS -->|Sharing policy changes| Mirror --> RTDB
  Cleanup -->|Reconcile objects and reservations| Storage
  Cleanup -->|Refund and prune retained records| FS
```

The Functions layer is authoritative for board ownership, entitlements and quota allocation. Clients cannot directly write board scenes, usage counters, upload grants, admin configuration or live elements. Authorized board/image reads and project metadata writes remain direct SDK operations. Cursor and presence writes remain direct RTDB operations after session admission.

## Board save and alert flow

```mermaid
sequenceDiagram
  participant E as Editor
  participant L as IndexedDB
  participant C as Cloud API client
  participant F as commitCloudBoard
  participant P as Auth and policy
  participant D as Firestore transaction
  participant U as Alert and usage UI

  E->>L: Persist latest scene locally
  E->>C: Sync private or shared scene
  C->>F: ID token, board ID, operation ID, scene
  F->>P: Check access and resolve board owner's plan
  P-->>F: Limits, Free pool cap, pause state
  Note over F,D: Inventory existing usage once if needed
  F->>D: Read board, usage, pooled saves and prior operation
  Note over D: Validate revision and measured size<br/>Check quota growth and logical scene hash
  alt Accepted
    D->>D: Write board, usage ledger and operation record atomically
    D-->>F: Committed revision or duplicate acknowledgement
    F-->>C: Success
    C-->>E: Cloud acknowledgement
    Note over E,L: Clear only matching guest recovery acknowledgement
    C->>F: getAccountUsage
    F-->>U: Effective plan, allowances, current usage, UTC reset
    Note over U: Free warnings near 80%, critical at 95%<br/>Board count warns at 2 and is full at 3
  else Quota exceeded or Free cloud paused
    D-->>F: Reject transaction without writing the scene
    F-->>C: resource-exhausted with metric, limit and message
    C-->>U: Explain limit and show relevant plan/usage CTA
    C-->>E: Keep local changes and pending sync
    Note over E,L: Preserve retry delay and latest pending work<br/>Daily save/pool retry at next UTC day
  end
```

Authentication, access checks and the operator pause can reject before the transaction. Image uploads are completed and validated before a scene referencing them is accepted. Guest/shared activity is attributed to the board owner. A private and shared copy of the same logical scene counts once; both actual document copies and image objects contribute their retained bytes.

## Image reservation flow

```mermaid
sequenceDiagram
  participant C as Browser
  participant F as Cloud Functions
  participant D as Firestore
  participant R as Storage rules
  participant S as Cloud Storage
  participant B as Object triggers / hourly cleanup

  C->>F: reserveCloudAsset(board, image ID, bytes, MIME)
  F->>D: Transaction: check owner allowance, reserve bytes, create expiring grant
  D-->>F: Immutable object path and grant
  F-->>C: grantId, storagePath, already-uploaded flag
  C->>R: Upload object with quotaGrant metadata
  R->>D: Read grant and sharing policy when applicable
  R->>R: Validate uploader, exact path/size/MIME, expiry and reserved state
  R->>S: Permit matching new object only
  C->>F: confirmCloudAsset(grantId)
  F->>S: Read actual object metadata
  F->>D: Mark upload complete with object generation
  S-->>B: Object finalized or deleted event
  B->>D: Confirm or refund once using grant and generation
  Note over B,D: Hourly cleanup refunds expired unused reservations<br/>Existing objects are checked before refund
```

Reservations count immediately, preventing concurrent uploads from exceeding the owner's image allowance. Retries reuse immutable image IDs. Permanent board deletion revokes grants before removing objects, refunds remaining grants after successful object deletion, deletes live state and history, then releases the board slot. It also cleans up uploaded images when the board's initial cloud commit failed.

## Implementation map

| Responsibility                                                                             | Implementation                                                        |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Authenticated callable client, usage/quota events, size estimate and retry timing          | `apps/whiteboard/src/features/account/cloud-api.ts`                   |
| Usage queries, Free/Pro dialog, request CTA, warning dismissal and complimentary badge     | `apps/whiteboard/src/features/account/account-panel.tsx`              |
| Private local outbox, revision conflict reconciliation and five-second cloud write spacing | `apps/whiteboard/src/features/workspace/workspace-api.ts`             |
| Shared scene commits, session registration and disconnect cleanup                          | `apps/whiteboard/src/features/sharing/sharing-service.ts`             |
| Durable guest recovery cache with acknowledgement matching                                 | `apps/whiteboard/src/features/sharing/guest-recovery.ts`              |
| Upload reservation and immutable image transfer                                            | `apps/whiteboard/src/features/assets/scene-assets.ts`                 |
| Server-mediated live deltas, element warnings and admitted presence                        | `apps/whiteboard/src/features/collaboration/collaboration-service.ts` |
| Local save/recovery integration, quota retries and cloud-size display                      | `apps/whiteboard/src/routes/board-editor.tsx`                         |
| Plan limits, UTC periods and measured Firestore document size                              | `functions/src/usage-policy.ts`                                       |
| Entitlements, inventory, transactions, uploads, session admission, deletion and retention  | `functions/src/account-usage.ts`                                      |
| Access-policy mirror and abandoned-room recovery trigger                                   | `functions/src/index.ts`                                              |
| Direct-write prevention and upload/session authorization                                   | `firestore.rules`, `storage.rules`, `database.rules.json`             |

`requestProAccess` only records a verified user's request in Firestore. An administrator must grant access through `accountEntitlements/{uid}` or the complimentary email list; no checkout or payment processor is connected.

The Free pool is an application save allowance, not a Firebase billing meter or hard spending cap. Its default is 2,000 logical saves per UTC day; manually granted and complimentary Pro have separate pooled counters. Exact per-user download metering, payment integration, monetary budget automation and the economics agent remain deferred. Local editing, export and local MCP remain free.

See [limits, validation and deployment order](../plans/freemium-rollout.md).
