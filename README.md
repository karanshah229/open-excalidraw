# OpenExcalidraw

An editable Excalidraw canvas with a local MCP bridge. It is designed for Pi, Claude Code, Codex, OpenCode, agy, and any other MCP client that can launch a stdio server.

## Workspace

- `apps/whiteboard` — Vite, React, and Excalidraw.
- `packages/mcp` — stdio MCP server plus the local browser WebSocket bridge.
- `packages/storage` — storage seam and the browser IndexedDB adapter.
- `docs/decisions` — durable architecture decisions.

## Run it

```bash
pnpm install
pnpm build
pnpm dev
```

Open `http://127.0.0.1:5173/`. The canvas retries its local bridge connection every second, so it can be opened before or after your agent client launches the MCP server.

The whiteboard and MCP process are separate by design: the web app keeps the editable scene open; your agent client owns the stdio MCP process. A single `pnpm dev:all` command is available for raw-protocol development, but it is not the normal way to attach Pi or another MCP client.

## Configure an agent

After `pnpm build`, point the agent's MCP configuration at this executable:

```json
{
  "mcpServers": {
    "open-excalidraw": {
      "command": "node",
      "args": ["/Users/karan/projects/Personal_projects/agentic-whiteboard/packages/mcp/dist/index.js"]
    }
  }
}
```

Start the whiteboard, then use the configured agent normally. The agent starts its own MCP child process; that child opens the local bridge at `ws://127.0.0.1:8787` and connects to the open canvas.

## Live-write contract

`add_elements`, `update_elements`, and `delete_elements` do not claim success merely because JSON was generated. Each request is sent to the browser adapter and succeeds only after the adapter returns the updated Excalidraw scene with the matching operation ID. `expectedRevision` protects callers from overwriting a scene changed by someone else.

Read `get_schema` before writing, `get_canvas` before editing existing items, and `get_selection` when acting on the current selection. `validate_dag` detects cycles among bound Excalidraw arrows.

## Local persistence

The web app stores projects and board documents in IndexedDB through `@agentic-whiteboard/storage`. The current adapter creates one local project and an initial board, autosaves canvas changes after a short idle period, and migrates any former localStorage scene into that board. The UI does not depend on IndexedDB directly, leaving SQLite for Tauri, platform storage for React Native, and cloud providers as future adapters. See [ADR 002](docs/decisions/002-storage-seam-and-local-indexeddb.md).
