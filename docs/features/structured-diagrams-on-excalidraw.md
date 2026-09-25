# Structured diagrams on Excalidraw

## Summary

Add structured-diagram tools to the existing Excalidraw board so a user can create, edit, rearrange, and export swim-lane, ER, sequence, and object-model diagrams without leaving the whiteboard. Excalidraw remains the canvas, selection, drawing, collaboration, and export engine; this feature owns the semantic model, diagram-specific inspector, layout, and projection of that model into Excalidraw elements.

The first release is local-first and works with the current `WorkspaceStore`. It must preserve ordinary Excalidraw content and never reinterpret arbitrary shapes as structured diagrams.

## Goals

- Create a diagram from a type-specific starter template or an empty canvas.
- Create and edit the semantic entities for swim lanes, ER diagrams, sequence diagrams, and object models.
- Keep generated shapes editable with normal Excalidraw controls and retain their semantic meaning.
- Re-layout only the selected structured diagram, without moving unrelated canvas content.
- Let freehand notes, sketches, and imported library items coexist with generated diagrams.
- Make structured diagrams available to MCP clients through an explicit schema rather than forcing clients to manipulate raw Excalidraw shapes.

## Non-goals

- Full BPMN, UML, or Crow's Foot standards compliance in the first release.
- Parsing source code or natural language into a diagram.
- Automatic two-way inference from arbitrary Excalidraw elements.
- Real-time multi-user merge semantics; the existing board sync decision remains in force.
- A new canvas or renderer that replaces Excalidraw.

## User experience

The editor toolbar gets a **Structured diagram** menu. Choosing a type inserts a new diagram at the visible viewport center and opens the Diagram panel. The panel lists the diagram's entities and relationships, exposes type-specific fields, and has **Add**, **Delete**, and **Auto-layout** actions.

Normal canvas edits are allowed. Selecting an element belonging to a managed diagram opens the corresponding item in the panel. A user can move nodes manually; connector endpoints continue to follow their nodes. **Auto-layout** is an intentional command, not an effect of every edit, so it does not erase hand-tuned placement.

If a user deletes a generated element or makes an unsupported structural edit, the panel shows a non-blocking “diagram needs repair” state. The user can restore the generated projection from the model or detach the item. Detaching makes the current shapes ordinary Excalidraw elements and removes them from future diagram layout.

## Diagram definitions

| Type         | Managed items                                              | First-release conventions                                                                                                  |
| ------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Swim lane    | pool, lane, activity, decision, event, flow                | Horizontal or vertical lanes; activities and decisions live in exactly one lane; flows may cross lanes.                    |
| ER           | entity, attribute, relationship                            | Entity cards list attributes; attributes may be PK/FK/required; relationship ends have cardinality and optionality labels. |
| Sequence     | participant, activation, message, note                     | Participants run left-to-right; lifelines are vertical dashed lines; messages have a direction and ordering.               |
| Object model | class/object, field, association, inheritance, composition | Class cards contain fields and optional methods; associations label ends and distinguish inheritance/composition.          |

Each type has a narrow typed schema. Use a common `DiagramNode`/`DiagramEdge` foundation only for identity, geometry, labels, and style; do not flatten type-specific concepts into arbitrary string metadata.

## Architecture

### Source of truth and projection

Each board document contains two complementary layers:

```text
BoardDocument
├── scene                         # all Excalidraw elements, including freehand content
└── structuredDiagrams[]          # semantic source of truth for managed diagrams
    ├── nodes / edges / type data
    ├── layout preferences
    └── elementMap                # semantic ID -> generated Excalidraw element IDs
```

`structuredDiagrams` is the source of truth for managed content. A `DiagramProjector` translates one diagram into rectangles, text, lines, arrows, and groups that Excalidraw can render and select. It uses stable generated element IDs where possible and marks every generated element with `customData`:

```ts
type DiagramElementTag = {
  diagramId: string
  semanticId: string
  role: 'node' | 'label' | 'edge' | 'lane' | 'lifeline' | 'header'
  projectionVersion: 1
}
```

Do not place the whole model in `appState`: the current editor deliberately persists only a small whitelist of Excalidraw application state. Instead, add a versioned `structuredDiagrams?: StructuredDiagram[]` field to `BoardDocument`, migrate old `formatVersion: 1` documents with an empty array, and make the storage adapter round-trip it unchanged.

### Edit paths

1. **Panel edit:** validate a typed command, update the semantic model, project only the changed diagram, then save the board.
2. **Canvas geometry edit:** observe moved/resized managed node elements and write their bounds back to the model. Update connected edges without changing the model's names or relationships.
3. **Canvas structural edit:** detect deletion, duplication, or missing tags through the element map. Mark the diagram dirty and offer repair or detach rather than guessing intent.
4. **Freehand edit:** leave it entirely in `scene`; it never touches structured state.

This split keeps Excalidraw's excellent direct manipulation while avoiding fragile reverse-engineering of arbitrary shapes.

### Modules

```text
apps/whiteboard/src/features/structured-diagrams/
├── model/        schemas, commands, validation, migrations
├── layout/       pure per-type layout functions
├── projection/   semantic model <-> Excalidraw elements and reconciliation
├── ui/           toolbar, diagram panel, inspectors, templates
└── integration/  board-editor change handling and MCP adapters
```

Keep the model and layout packages free of React and Excalidraw imports. The projector is the only boundary that understands Excalidraw element shapes. That boundary makes a future SVG/PDF renderer or a Tauri/native surface feasible without reimplementing the diagram rules.

## Data model and commands

Use stable UUIDs for diagrams, semantic items, and their generated elements. Commands are the mutation API; UI code and MCP tools must not edit a `StructuredDiagram` object in place.

```ts
type StructuredDiagram = {
  id: string
  kind: 'swimlane' | 'er' | 'sequence' | 'object-model'
  name: string
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  layout: { direction: 'horizontal' | 'vertical'; mode: 'auto' | 'manual' }
  elementMap: Record<string, string[]>
  revision: number
}

type DiagramCommand =
  | { type: 'add-node'; diagramId: string; node: DiagramNode }
  | { type: 'update-node'; diagramId: string; nodeId: string; patch: unknown }
  | { type: 'remove-node'; diagramId: string; nodeId: string }
  | { type: 'connect'; diagramId: string; edge: DiagramEdge }
  | { type: 'update-edge'; diagramId: string; edgeId: string; patch: unknown }
  | { type: 'remove-edge'; diagramId: string; edgeId: string }
  | { type: 'layout'; diagramId: string }
  | { type: 'detach'; diagramId: string; semanticId: string }
```

Validate commands at the boundary with a schema library already suitable for the project or a small handwritten validator. Examples: a swim-lane activity requires an existing lane; a sequence message requires two participants; an ER relationship has valid cardinalities; an inheritance edge cannot form a cycle.

## Layout and rendering

Use deterministic, pure layout functions: equal inputs and options must yield equal geometry. This allows reliable undo/redo, tests, MCP output, and future server-side rendering.

- **Swim lanes:** size lanes from their labels and contained items; place flow nodes in rank order; route cross-lane flows using orthogonal elbow arrows.
- **ER and object model:** start with a layered directed layout. Reserve card height from wrapped field text and route relationship arrows after card placement.
- **Sequence:** calculate participant columns from label widths and message order; derive lifeline and activation geometry rather than storing it as independent user data.

Begin with a lightweight internal layout implementation. Introduce ELK.js only if nested swim lanes, edge routing, and large-diagram layout exceed the implementation's quality or performance budget; isolate it behind `DiagramLayoutEngine` so the choice is reversible.

Render using native Excalidraw primitives and bound arrows. Group the primitives that make up a semantic node for selection; retain individual `customData` tags for reconciliation. Do not rely on an external Excalidraw library asset for an editable structured diagram: library assets are useful visual stencils but do not retain the required semantic relationships.

## Integration details

The current `BoardEditor` saves a filtered `scene.appState` and receives MCP operations as raw element adds, updates, and deletes. Extend this path as follows:

1. Load `structuredDiagrams` with the document and project their elements before the initial scene is shown.
2. Add a structured-diagram reducer that applies a validated command, regenerates affected elements, and writes the scene and model in one `saveBoard` call.
3. In Excalidraw `onChange`, reconcile geometry changes for tagged node elements before scheduling the normal save. Preserve untagged changes untouched.
4. When accepting raw MCP element mutations, run reconciliation after the operation and return warnings for managed-element deletions instead of silently corrupting the model.
5. Add semantic MCP operations: `list_diagrams`, `get_diagram`, `create_diagram`, `apply_diagram_commands`, and `layout_diagram`. Keep the existing raw canvas operations for freehand work.

The semantic operations accept `expectedRevision` and return the diagram revision plus resulting element IDs. This mirrors the existing live-write contract and prevents one client from unknowingly overwriting a newer model.

## Delivery plan

1. **Foundation:** version `BoardDocument`, introduce model/command validation, projection tags, and one persistence/reconciliation test fixture.
2. **Swim lanes:** templates, panel CRUD, manual movement, auto-layout, repair/detach, and export verification.
3. **ER and object model:** shared card and relationship projection plus type-specific validation and layout tests.
4. **Sequence:** participant/message editor, derived lifelines/activations, ordering controls, and layout tests.
5. **MCP and polish:** semantic tools, keyboard shortcuts, accessible panel controls, import/export metadata behavior, and telemetry/error reporting where a cloud adapter exists.

Ship each diagram type behind a feature flag until migration, undo/redo, and repair flows are verified on real boards.

## Acceptance criteria

- A user can create each of the four diagram types from a toolbar template and save/reopen it with no semantic or visual loss.
- Editing a field, message, lane, or relationship in the panel updates only that diagram's generated elements.
- Moving a managed node on the canvas persists its position; auto-layout changes it only after an explicit user action.
- Freehand Excalidraw elements remain editable and survive structured-diagram operations unchanged.
- Deleting a generated element results in an actionable repair/detach state, never an unhandled exception or silent model corruption.
- `BoardDocument` v1 boards load successfully with no structured diagrams, and the migration is idempotent.
- Semantic MCP commands reject invalid references and stale revisions; raw MCP canvas operations retain their current behavior for untagged elements.
- Unit tests cover validation and deterministic layout; integration tests cover projection, save/reload, move/reconcile, deletion/repair, and interaction with untagged canvas elements.

## Open decisions

- Whether managed diagrams should be lockable to prohibit direct canvas structural edits, or always allow repairable edits.
- Which ER notation (Crow's Foot, Chen, or configurable) and UML notation depth are required for the target users.
- Whether generated diagram text should use Excalidraw's text editing directly or route through the inspector for strict model validation.
- The maximum supported diagram size and the performance threshold that justifies adding ELK.js.
- How semantic diagram changes merge once collaborative editing is introduced.
