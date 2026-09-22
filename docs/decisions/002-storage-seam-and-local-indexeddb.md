# ADR 002: Use a workspace storage seam with IndexedDB as the first adapter

- Status: Accepted
- Date: 2026-09-22

## Context

OpenExcalidraw will have web React, Tauri React, and React Native clients. It will also grow from a single board into projects, access control, cloud synchronization, and shared diagrams. Browser-only localStorage cannot safely carry that product model or large Excalidraw documents.

## Decision

Define a `WorkspaceStore` module around product concepts: projects, boards, and board documents. The whiteboard app depends only on that interface. `IndexedDbWorkspaceStore` is the first adapter and persists a default local project plus its boards in the browser.

The project model includes an owner and role-bearing members (`owner`, `editor`, `viewer`). Local mode has one `local-user` owner; it does not claim to enforce multi-user access control. Cloud and SQLite adapters will implement the same interface, with their respective identity, authorization, migration, encryption, synchronization, and conflict-resolution implementations behind the seam.

## Alternatives Considered

### Direct IndexedDB calls from React

- Pros: fewer files initially.
- Cons: persistence mechanics would spread through the canvas and make non-browser clients costly.
- Rejected: it weakens locality and prevents a clean replacement path.

### localStorage snapshots

- Pros: trivial to implement.
- Cons: constrained capacity, synchronous writes, weak support for assets and multi-board data.
- Rejected: retained only as a one-time migration source for existing browser scenes.

### SQLite immediately

- Pros: aligned with desktop ambitions.
- Cons: unavailable in ordinary web React without a different runtime strategy.
- Rejected: IndexedDB is the correct local adapter for the web client; SQLite can become a Tauri adapter later.

## Consequences

- The application writes board documents through one storage seam and no longer treats localStorage as its source of truth.
- The current UI uses the default local project and board; project and board management UI can be added without changing the persistence contract.
- A cloud adapter will require an explicit conflict and authorization model before multi-user editing is enabled.
