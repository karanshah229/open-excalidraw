# Security audit — 2 October 2026

Audited commit: `134fba55e1f4c3c805b279802602ff181dea3eb9`.

**Yes, there are exploitable security weaknesses. No application fixes or deployments were made.** Changes from this audit are this report, an isolated emulator configuration, and reproduction scripts. No production data was read or modified during exploitation tests.

## Scope and evidence

Reviewed first-party runtime source in the web application, local storage package, MCP server, Cloud Functions, all three Firebase rulesets, generated backend entrypoints, and build/hosting/auth configuration. Inspected tests for security coverage and cloud access, scanned tracked files for private keys/service accounts/common credential patterns, and ran `pnpm audit`. This is not a claim that every dependency implementation or every test/UI styling line has been manually audited. Production rules, enabled authentication providers, IAM, bucket permissions, App Check enforcement, and deployment parity were not independently verified.

Evidence labels below distinguish actual local reproductions from source-traced attack paths. High means data exposure or broken authorization; medium means narrower/local attacks or availability/cost abuse. Conditional findings require the stated deployment condition. Public edit access is an intentional permission; vandalism by a permitted editor alone is not an authorization bypass.

Tests used:

- `tests/security-audit-repro.mjs`: Firebase Auth, Firestore, RTDB and Storage emulators; synthetic identities and boards; delayed events through the actual compiled mirror handler.
- `tests/security-mcp-repro.mjs`: actual MCP source over stdio, synthetic WebSocket adapters on port 18787.
- `tests/security-local-repro.mjs`: real IndexedDB in a fresh headless Chrome profile against Firebase-disabled Vite on port 15173. It exercises local account activation and logout paths, not real Google login or cloud copying.

Controls also passed: an unrelated identity could not read a restricted board; a viewer could not update a scene/name; a non-owner editor could not change the owner field. No demonstrated arbitrary read of all restricted cloud boards, direct theft of authentication tokens, or stored XSS was found.

## 1. High — link-only boards can be enumerated without their links

**Location:** `firestore.rules:18–19,31–36`.

`allow read` includes collection queries. An unauthenticated caller can query `boardShares` for `generalAccess == 'anyone_with_link'`. That returns board IDs, scenes, owner identity/email, and invited email/collaborator maps. Hiding the owner row in the UI does not hide these fields in API responses. Public-editor boards discovered this way can then be modified by the same caller.

**Reproduce:** seed two link boards and a restricted board; without signing in, run `getDocs(query(collection(db, 'boardShares'), where('generalAccess', '==', 'anyone_with_link')))`. Observe the link board IDs and owner email. Call `updateDoc` on the discovered editor board. Both operations succeeded locally; the restricted-board control was denied.

**Fix:** separate `get` from `list`; reject public enumeration. Allow only appropriately scoped owner/member workspace queries. Separate readable scene metadata from private sharing/owner-email records. Keep a high-entropy capability for link access, and require it on reads/writes. Simply hiding an endpoint or changing the Firebase API key does not fix rules.

Firebase documents the distinction between get/list and constraints on queries: [query security](https://firebase.google.com/docs/firestore/security/rules-query).

## 2. High — removing one of multiple editors leaves their write access active

**Location:** `apps/whiteboard/src/features/sharing/sharing-service.ts:153–156`; `apps/whiteboard/src/components/share-modal.tsx:228–253`; `firestore.rules:14–16`.

The UI deletes a collaborator key from a JavaScript object, then persists the sharing document with `setDoc(..., { merge: true })`. With other collaborators remaining, Firestore recursively merges that map and retains the omitted entry. The removed person loses the invitedEmails read grant but still satisfies the editor rule. The RTDB mirror also derives readers from the retained collaborators map. This is separate from the illegal-email-key issue below.

**Reproduce:** create a restricted board with editor A and viewer B. Remove A by writing `invitedEmails: [B]` and `collaborators: { [B]: ... }` with `{ merge: true }`. Inspect the persisted document: A remains in `collaborators`. A's read is denied, but their direct `updateDoc` of the board name/scene succeeds. Confirmed locally. This reproduction uses an unverified fixture identity, but the retained-grant problem equally applies to a verified removed editor.

**Fix:** replace the entire collaborators map with `updateDoc({ collaborators: nextMap, invitedEmails: nextEmails })`, or explicitly delete the email entry using a `FieldPath` plus `deleteField`. Perform the mutation atomically and synchronize revocation. Require invited/member status as well as an editor role so stale editor entries cannot independently authorize writes. Test removal with at least two collaborators.

## 3. High — ordinary invited emails break the RTDB mirror and leave stale access

**Location:** `functions/src/index.ts:22–42`; `functions/src/backfill-board-access.ts:15–26`; `database.rules.json`.

The mirror stores raw emails as map keys, e.g. `readersByEmail['friend@example.test']`. RTDB rejects periods in keys. Mirroring fails for ordinary invited emails; RTDB rules also use the unencoded email as a child path. A previously public policy can remain active even after the Firestore document is restricted. Share-modal errors are logged while optimistic settings remain visible, and Done closes even on failure.

**Reproduce:** start with RTDB `publicRead/publicWrite: true`; change Firestore to restricted with an invited email; attempt the same Admin SDK mirror write. It throws `invalid key`. An anonymous outsider's RTDB read and element write still succeed against the old ACL. Confirmed locally.

**Fix:** preferably resolve invitations into UID-based grants. If using email keys, define a collision-free encoding and use the same transformation in writers, backfill and rules. Implement revocation so a failed mirror cannot preserve old broad permissions. Show sharing failures and restore the actual committed UI state; repair existing mirrors after fixing the representation.

Firebase's [key restrictions](https://firebase.google.com/docs/database/web/structure-data) document the rejected characters.

## 4. High — delayed events can re-enable revoked room access

**Location:** `functions/src/index.ts:148–159,167–181`.

The trigger blindly writes the historical event's `after` policy. There is no access revision or monotonic compare. A delayed public-policy event can overwrite a newer restricted mirror, including a mirror successfully updated by the callable. An old event can also recreate access after deletion. Because every scene change triggers this function, even events originating before revocation can contain an obsolete broad policy.

**Reproduce:** make the current Firestore board restricted; invoke the actual mirror handler with the restricted event, then a historical public-editor event. RTDB becomes public writable while Firestore remains restricted. Confirmed locally by invoking the handler; the test does not force real Eventarc delivery ordering.

**Fix:** server-owned monotonic policy revisions; update RTDB with a transaction that rejects older revisions. Preserve revisioned deletion/revocation tombstones so old events cannot resurrect permissions. Route sharing changes through a server-owned operation and order revocation to fail closed. Fetching current Firestore data alone still needs protection against concurrent writes.

Firebase explicitly says [trigger ordering is not guaranteed](https://firebase.google.com/docs/firestore/extend-with-functions-2nd-gen#limitations).

## 5. High, same browser/device — logout and account switching expose cached private boards

**Location:** `packages/storage/src/index.ts:63,227–232,359–362`; `apps/whiteboard/src/features/workspace/workspace-api.ts:104–131,361–380`; `apps/whiteboard/src/routes/board-editor.tsx:462–473,553–589`.

All accounts share one IndexedDB database. Listing/loading does not filter ownership. Logout stops listeners but retains boards, pending sync work and the React Query workspace cache. The editor's restricted-board fallback treats an existing local document as evidence of ownership without comparing the current authenticated UID. Unsynced boards are also uploaded under the new active user's namespace without checking their project owner.

**Reproduce:** activate A, create a private project/board, deactivate A, then activate B in the same fresh browser profile. B's workspace lists A's board. After deactivation the local load still returns A's board, and the board route renders with no signed-in user. These local behaviors were reproduced with Firebase disabled. The cross-account cloud-copy path is source-traced, not separately live-tested.

**Fix:** partition local databases and query caches by authenticated UID; refuse local reads/writes/sync for another owner; isolate deliberately offline work separately. On auth change, cancel timers/in-flight work and use a session-generation guard, detach listeners and clear account UI caches. Enforce current UID ownership in the editor fallback. Decide explicitly how trusted-device persistence behaves on logout.

The independently persistent Firestore cache also needs attention: Firebase warns that [web persistence is not automatically cleared between sessions](https://firebase.google.com/docs/firestore/manage-data/enable-offline).

## 6. High, known-ID prerequisite — outsiders can claim a never-shared board's sharing document

**Location:** `firestore.rules:33`; `apps/whiteboard/src/routes/board-editor.tsx:483–490,1109–1121`.

Any signed-in user, including an anonymous account, may create `boardShares/<any ID>` as long as they put their own UID in ownerId. The rule does not prove that they own the corresponding private board. For a known ID of a never-shared private board, an outsider can claim the sharing namespace. The original owner's editor later merges its local private scene into this attacker-owned shared scene; a subsequent edit/save pushes that merged scene to the sharing document.

**Reproduce:** seed a private board in the owner's user namespace with no share document. As an outsider, create a public-editor share document for that same board ID, ownerId set to the outsider. The creation succeeds locally. Opening the board in the original owner's cached workspace and saving its scene is the source-traced exfiltration continuation; it was not run against a real user's board.

**Fix:** establish board ownership in a server-controlled global registry at board creation. Only the registered owner may create/manage its sharing policy. Before merging/uploading a local scene, verify that the cloud policy owner matches the local project's authenticated owner. UUID entropy reduces guessing but does not replace authorization for a leaked ID.

## 7. High — deleting a board does not revoke its shared copy

**Location:** `apps/whiteboard/src/features/workspace/workspace-api.ts:302–305`; `packages/storage/src/index.ts:365–378`; `firestore.rules:31–45`.

Delete only marks the local/private workspace document inactive. It does not delete or disable `boardShares`, the RTDB access mirror, history, deltas, or Storage objects. The shared-board load path accepts the surviving sharing document without checking the private board's active flag.

**Reproduce:** share a board, save its link, delete it through the workspace, then reopen that link in another browser. The sharing record and its authorization remain valid. This complete path is source-traced; the local delete behavior was exercised, but no live public-board deletion test was performed.

**Fix:** a server-side deletion operation must first revoke shared access, persist a revisioned tombstone, and clean up the board's shared content, history, RTDB data and Storage. Retries must be idempotent; stale mirror events must not resurrect it. Add a deletion/reopen test.

## 8. High, authentication-provider dependent — unverified emails satisfy invitation permissions

**Location:** `firestore.rules:7–16`; `storage.rules:9–21`; email branches throughout `database.rules.json`.

Email matching checks the claim's value without requiring `email_verified`. If password sign-up or another provider permitting unverified email claims is enabled, an attacker can register an invited email they do not control and obtain the invitation's rights. Offering only Google login in the UI does not restrict the underlying Firebase Auth APIs. Existing-account/provider behavior may prevent some impersonation cases; the prerequisite matters.

**Reproduce:** in the Auth emulator create an email/password user with the invited address and no verification. Their token reports `email_verified: false`; restricted-board reads and editor updates succeed. Confirmed in the emulator; production provider configuration is unverified.

**Fix:** require verified email claims wherever an email grant is used, or bind accepted invitations to verified UIDs on the server. Check enabled providers and account-linking settings. UID ownership checks are unaffected by this finding.

## 9. Medium — viewers can deny legitimate users editing and publish crashing presence values

**Location:** `database.rules.json` presence/activeSessions rules; `apps/whiteboard/src/features/collaboration/collaboration-service.ts:546–598`; `apps/whiteboard/src/features/collaboration/collaborator-bar.tsx:10–21`.

Every reader can create unlimited sessions with arbitrary early joinedAt values. The ten-editor cap ranks these records without checking their actual edit role. A single viewer can occupy all ten positions and turn legitimate editors, including the owner, into spectators. Attackers do not have to register onDisconnect cleanup, so forged sessions can persist. Presence validation checks required fields exist, but not displayName/color types; a non-string displayName reaches UI string methods.

**Reproduce:** as one viewer, write eleven session records with your real UID, different session IDs and joinedAt zero. All writes succeed. They sort ahead of normal users. Also write displayName as an object; the rule accepts it. Rule acceptance was reproduced; owner spectator behavior and the subsequent string-method exception are source-traced.

**Fix:** server-managed session admission/leases, per-UID caps and trustworthy admission timestamps. Count only admitted editors for editor capacity, with an explicit owner policy. Validate field types, lengths and allowed keys; parse incoming presence defensively. Rules enforce permissions regardless of any UI capacity display.

## 10. Medium — anonymous storage/database abuse bypasses client guardrails

**Location:** `storage.rules:18,24–31`; `firestore.rules:13,33`; `database.rules.json` element/presence validation; `functions/src/index.ts:167`.

Public-editor Firestore/Storage writes do not require authentication. Snapshots have no application size, MIME, filename or object-count restriction. Anonymous authenticated users can also create unlimited sharing documents for their own UID. RTDB permits arbitrary extra fields, inconsistent serialized JSON and nonnumeric versions. Client drag throttles and payload limits do not constrain direct API callers. Every board-share write triggers an Admin SDK ACL mirror; repeated presence deletes can invoke the 30-second compactor. These are amplification paths, not a claimed production billing incident.

**Reproduce:** without signing in, upload an 11 MiB binary object to a public-editor board's snapshots path. It succeeds despite the nearby assets-only 10 MiB limit. Write an RTDB record whose data ID disagrees with its outer ID, whose version is a string and whose extra field is 300 KB; it also succeeds. Confirmed locally without a load/flood test.

**Fix:** authenticated anonymous identities for public editing plus capability checks; appropriate App Check enforcement as an additional abuse signal; strict schemas and snapshot sizes/content types/paths; server-enforced per-user/board quotas and rate limits for expensive operations. Trigger mirrors only on sharing-policy changes and coalesce compaction work. Bound compaction input/output. App Check cannot substitute for authorization.

## 11. Medium, uploaded-object prerequisite — retained download tokens outlive board revocation

**Location:** `apps/whiteboard/src/features/collaboration/collaboration-service.ts:414–422`; sharing changes have no Storage token rotation.

`getDownloadURL` provides a bearer URL. Someone who obtained a URL while authorized can continue downloading the stored object after its board becomes restricted. The object authorization policy does not revoke an already issued token. The upload helper currently has no application call site, so this finding matters for objects uploaded through the SDK/API or when that helper is wired in; it is not evidence that current scenes are all leaked through Storage.

**Reproduce:** upload an emulator fixture, obtain its download URL, restrict the board, then fetch the retained URL without authentication. It returns HTTP 200. Confirmed locally.

**Fix:** prefer rule-checked SDK reads (`getBlob`/`getBytes`) or an authorized backend with short-lived URLs. Avoid issuing durable tokens for private assets; revoke existing tokens or remove objects when necessary. This controls future downloads; it cannot retract data an authorized viewer already saved.

Firebase describes [direct SDK downloads for finer-grained rule-based control](https://firebase.google.com/docs/storage/web/download-files#download_data_directly_from_the_sdk).

## 12. Medium, local MCP users — unpaired bridge clients can poison context and forge acknowledgements

**Location:** `packages/mcp/src/index.ts:39–70,548–589`; `apps/whiteboard/src/routes/board-editor.tsx:694–715`.

The WebSocket listener has no explicit loopback bind, Origin allowlist or pairing secret. Every socket becomes an adapter and may replace the global agent-visible scene or acknowledge any pending operation. Commands broadcast to all adapters without board/session routing: a share command without boardId is interpreted against each browser's current board. Disconnected scenes remain in server memory and readable through MCP. A remotely reachable port permits network peers to attack; hostile-webpage access depends on browser local-network protections.

**Reproduce:** start the source MCP server on port 18787. Connect one legitimate synthetic adapter and another with an unrelated Origin. The second sends a forged scene: `get_canvas` returns it. Issue a share command: both adapters receive it and the unpaired one can return a successful fake ACK. Close both; the last scene remains readable. All these protocol behaviors were reproduced. A WebSocket client cannot directly relay arbitrary operations to other browsers using this protocol; that stronger claim is not made.

**Fix:** explicitly bind loopback, validate Origin, require per-session pairing, and allow operations/ACKs only for the selected authenticated board adapter. Include board ID and session context in every operation; validate payload size/schema and expected board/revision. Clear scene/selection and fail pending requests when the selected session ends. Gate the browser bridge on current board authorization, including accessDenied/boardNotFound.

## Additional hardening, not demonstrated cloud data-theft exploits

- Vite's dev-only `/api/mcp/start` and `/api/mcp/stop` middleware has no explicit Origin/authentication check. Harden local process-control endpoints against cross-origin requests; these endpoints are absent from static Firebase Hosting. Source finding, not a browser CSRF exploit reproduced here.
- Firestore owners can persist malformed sharing metadata; compactor scene/element output is unbounded up to service limits, and its base scene is read before the transaction rather than recomputed from the transaction's current scene. Add schema/size validation and race-safe reconciliation. Arbitrary editors already have broad scene-edit authority, so malformed editor scenes alone are not reported as privilege escalation.
- Legacy Firestore `activeSessions` remains editor-writable even though runtime liveness uses RTDB. Remove unused access paths and reject spoofed session records if retained.
- No hosting CSP/frame policy is configured in this repository. Add suitable headers, especially around third-party embeds and generated SVG previews. The installed Excalidraw export code sanitizes link URLs; the raw-SVG sink alone is not proof of stored XSS.
- `pnpm audit` reported **15 advisory entries: 8 high, 5 moderate, 2 low**, including duplicate affected dependency versions. They are not 15 demonstrated application exploits. Affected dependency paths include Excalidraw → nanoid, Excalidraw → Mermaid parser → lodash-es, Mermaid → DOMPurify, and Firebase → Node gRPC/uuid paths. Review reachability and upgrade compatible dependencies; Node gRPC advisories are not proof of browser compromise. Examples: [nanoid](https://github.com/advisories/GHSA-2v37-7h3g-55p8), [lodash-es](https://github.com/advisories/GHSA-r5fr-rjxr-66jc), [gRPC](https://github.com/advisories/GHSA-m9gg-hp2v-232j).

## Re-run safely

Run from the repository root. These scripts intentionally assert the vulnerable behavior; a successful run means the reproduction succeeded, not that the app is secure. Convert them to negative regression expectations when fixing the issues.

```sh
firebase emulators:exec --project demo-whiteboard-security --only auth,firestore,database,storage --config security-audit.firebase.json 'node tests/security-audit-repro.mjs'
node tests/security-mcp-repro.mjs
```

The Firebase script imports the current `functions/lib/index.js`; rebuild Functions if its source is changed before retesting. Do not point these tests at a real project.

For the local IndexedDB test, start a separate Firebase-disabled Vite process:

```sh
VITE_FIREBASE_API_KEY= VITE_FIREBASE_AUTH_DOMAIN= VITE_FIREBASE_PROJECT_ID= VITE_FIREBASE_APP_ID= pnpm --filter @agentic-whiteboard/whiteboard dev --port 15173
```

In another terminal:

```sh
node tests/security-local-repro.mjs
```

## Fix order

1. Block link-board enumeration and split private sharing metadata from readable scene data.
2. Fix collaborator removal, illegal RTDB email keys and stale-event revocation together; repair persisted grants and mirrors.
3. Enforce board ownership at share creation, revoke shared copies on deletion, and partition account caches.
4. Verify Auth provider settings and enforce verified-email/UID membership.
5. Harden presence admission, snapshot/database abuse limits, object downloads and local bridge pairing/routing.
6. Add negative security regression tests and verify the deployed rules/functions/App Check/IAM match the reviewed configuration.
