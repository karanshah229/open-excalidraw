# Sharing boards and projects

## Summary

Enable a project owner or editor to invite people to a project, share an individual board with people outside the project, and revoke that access. Project access applies to every board in the project; board sharing is an explicit exception for one board only.

The current browser adapter is local-only. This document defines the cloud feature and the contract a cloud `WorkspaceStore` adapter must enforce; it does not make IndexedDB boards shareable.

## Goals

- Share a project and all of its current and future boards.
- Share one board without exposing the rest of its project.
- Support `owner`, `editor`, and `viewer` roles.
- Make access changes immediate and auditable.
- Keep existing local work private until it is deliberately uploaded or shared.

## Non-goals

- Anonymous public links in the first release.
- Real-time cursor presence, comments, or granular element permissions.
- Transferring ownership, external-domain policy controls, or expiring links.

## Access model

| Scope      | Owner                                 | Editor                         | Viewer                  |
| ---------- | ------------------------------------- | ------------------------------ | ----------------------- |
| Project    | Manage members and all project boards | Create, edit, and share boards | View all project boards |
| Board-only | Not applicable                        | Edit the shared board          | View the shared board   |

Rules:

- A project role is inherited by every board in that project.
- A board-level grant can only add access; it cannot reduce a project member's access.
- The owner is always able to access and manage the project. At least one owner must remain.
- Editors may share a board but may not change project membership or grant `owner` access.
- Viewers cannot create, edit, delete, rename, or share content.
- Revoking a project grant removes its inherited board access. A separate board-level grant remains valid.

## User experience

Each project group and board editor has a **Share** control.

1. The user selects **Share project** or **Share board**.
2. They enter one or more email addresses and choose **Can edit** or **Can view**.
3. The dialog shows people with direct access, inherited access, and pending invitations.
4. Invitees receive a signed invitation URL. After authentication, acceptance opens the project or board.
5. Owners can change roles or remove direct members; the confirmation explains the resulting loss of access.

The workspace shows a people icon for shared content. A viewer sees read-only canvas controls and a clear “View only” state. A board shared outside its project displays “Shared board” rather than exposing the project name or project navigation.

## Data and API contract

Keep `ProjectMember` as the project-scoped grant. Add a board-scoped grant and invitation records in the cloud adapter:

```ts
type BoardMember = { boardId: string; principalId: string; role: 'editor' | 'viewer' }

type ShareInvitation = {
  id: string
  scope: { type: 'project'; projectId: string } | { type: 'board'; boardId: string }
  email: string
  role: 'editor' | 'viewer'
  invitedBy: string
  expiresAt: string
  acceptedAt?: string
}
```

Authorization is evaluated server-side for every read and mutation. The effective role for a board is the highest of owner, project membership, and board membership. Client-side role checks only tailor the interface; they are not a security boundary.

The cloud store should add operations equivalent to:

```ts
inviteToProject(projectId, email, role)
inviteToBoard(boardId, email, role)
listAccess(scope)
updateAccess(grantId, role)
revokeAccess(grantId)
acceptInvitation(token)
```

Every mutation must be atomic, record actor/time/scope/previous role/new role, and publish an access-change event so open clients refresh permissions promptly.

## Rollout and migration

1. Ship authenticated cloud projects and server-enforced project roles.
2. Add project invitations and read-only viewers.
3. Add board-only grants and invitations.
4. Add collaborative editing only after the synchronization and conflict-resolution model is defined.

Local projects remain owned by `local-user` and cannot be invited to. Sharing prompts the user to create or move the board into a cloud project, preserving the local board until the upload succeeds.

## Acceptance criteria

- An invited editor can edit only the intended project or board.
- An invited viewer can open the intended content but cannot mutate it through either UI or API.
- A project invitation grants access to newly created project boards.
- A board invitation never reveals sibling boards or project metadata.
- Revocation takes effect for subsequent requests immediately and open clients become read-only or lose access on refresh.
- Failed uploads, invitation delivery, and access changes leave existing access unchanged and present a recoverable error.

## Open decisions

- Whether editors may invite additional editors, or only viewers.
- Invitation expiration duration and resend behavior.
- Whether external sharing requires an allowlist or verified domain.
- The concurrency strategy for simultaneous board edits (for example CRDTs versus optimistic revisions).
