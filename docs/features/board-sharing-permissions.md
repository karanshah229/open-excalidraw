# Board sharing permissions

Confirmed 2026-10-03: Restricted means owner + individually invited people. It removes inherited project access, but retains board invitations. Project editors can manage the project; only the owner can change individual board sharing or delete an individual board.

## Working model

New boards use project access. While inheriting, project and direct board grants combine; the highest role wins. Any explicit change to board general access or invitations switches that board to board-specific access. Project settings and other boards stay unchanged. Project invitations are never copied into board invitations.

The sharing dialog shows inherited people as “Via project”; these grants are read-only here. Direct board invitations remain editable. General access shows the effective public policy. An explicit board edit preserves the displayed general access unless the user changes it. This snapshots the public access shown in the dialog, but never the project invite list.

“Use project access” restores inheritance and retains direct board grants. Those direct grants can provide broader access than the project. Restricting the project does not revoke direct board invitations or public board links. A board-specific override stays independent through subsequent project changes.

## Complete role matrix

For the person opening the board, calculate P as the highest project grant (project general access + that person's project invitation), and B as the highest direct board grant (board general access + that person's board invitation). None means Restricted/no matching invitation, Viewer means view-only, and Editor means edit. Within either policy, Editor beats Viewer; Viewer beats None.

| Project role P | Direct board role B | Uses project access | Board-specific access |
| -------------- | ------------------- | ------------------- | --------------------- |
| None           | None                | None                | None                  |
| None           | Viewer              | Viewer              | Viewer                |
| None           | Editor              | Editor              | Editor                |
| Viewer         | None                | Viewer              | None                  |
| Viewer         | Viewer              | Viewer              | Viewer                |
| Viewer         | Editor              | Editor              | Editor                |
| Editor         | None                | Editor              | None                  |
| Editor         | Viewer              | Editor              | Viewer                |
| Editor         | Editor              | Editor              | Editor                |

This table covers every combination of general access, invitation roles, and inheritance. The companion [CSV](board-sharing-permissions.csv) expands all **162 combinations**: three possible grants for each of the four sources, multiplied by the two access modes. Invitation columns describe this particular person's matching invitation; unrelated invitees never grant them access.

## Actions and effects

| Action                                       | Board result                                                                         | Project / other boards           |
| -------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------- |
| Choose Restricted on a board                 | Stops inheritance; keeps direct invitees; removes public access                      | Unchanged                        |
| Choose Anyone with link / change public role | Stops inheritance; retains board invitees                                            | Unchanged                        |
| Add/change/remove a board invite             | Stops inheritance; preserves displayed public policy; changes only the direct invite | Unchanged                        |
| Use project access                           | Combines current project grants and existing board grants                            | Unchanged                        |
| Change project general access / invitation   | Immediately affects inheriting boards; overrides remain independent                  | Changes the project policy       |
| Archive                                      | Hides from the current user's default homepage                                       | No access change for anyone      |
| Delete project                               | All contained board access is denied, including direct links                         | Soft delete; ownership unchanged |

## Gates before the matrix

The owner always has owner access to an active project/board. Email invitations require a verified matching signed-in email. Signed-out users can use public grants only. Deleted projects/boards deny access; policy updates temporarily gate writes while Firestore, Realtime Database, and Storage projections converge. Realtime subscriptions recover without a refresh after valid policy transitions. A Restricted board with no direct invitees is owner-only private; a Restricted board with invitees is restricted shared.

## Validation

Puppeteer drives real Firebase Auth, Firestore, Functions, Realtime Database and Storage against isolated demo emulators. Tests check inherited roles, direct grants, custom overrides, invite removal, Restricted retaining invitees, restoring inheritance, live viewer/editor/public transitions, denied metadata/assets/writes, and failed policy saves. The CSV is an exhaustive specification, not a claim of 162 independent end-to-end cases.
