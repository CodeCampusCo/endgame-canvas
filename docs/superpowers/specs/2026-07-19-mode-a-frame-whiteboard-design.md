# Mode A — Frame Whiteboard Tool Set (2026-07-19)

Design for the next tool set after the read spike passed. Builds on the spike core
(`docs/superpowers/specs/2026-07-19-endgame-canvas-spike-impl-design.md`): the browser
tldraw editor is the source of truth, the relay routes `requestId`-correlated messages, and
`src/server.ts` dispatches tools through a handler map. This doc adds the vocabulary that
makes **Mode A — the human + one agent interactive whiteboard** actually usable.

## Goal & interaction model

Mode A is a human and one agent working the same canvas. MCP is pull-based: the agent reads
on demand when the human speaks in chat, not via live events. The chosen pointing mechanism
is **named frames**: the human demarcates a work area with a frame and names it; the agent
reads "what's in frame X" (a cropped raster + the structured shapes inside + how they
connect), then responds by drawing / editing inside that frame and focusing the camera on it.

**The named frame is the shared reference unit between human and agent.** This replaces
"read the whole canvas each turn" with a scoped, addressable region, and gives the human a
tactile way to say *here* without passing coordinates.

## Architecture — unchanged core, extended vocabulary

No topology change. Every new tool is:
1. a handler entry in `createDispatcher`'s map in `src/server.ts` (+ a `TOOL_DEFS` entry), and
2. a `case` in the browser's `runTool` dispatch in `browser/src/main.tsx` that runs on the
   live `editor`.

The dispatch-map refactor already in place means **adding a tool = one map entry + one
browser case + unit tests for the handler** — no branching to touch. Frames are a tldraw
`frame` shape (`props.name`); shapes created inside a frame's bounds auto-parent to it.

## Tool set — four phases (frame-first vertical slice)

Each phase is a shippable increment. Phase 1 makes the frame interaction real; later phases
thicken draw / edit / navigate.

### Phase 1 — Frame read loop (the core interaction)

| tool | params | returns |
|---|---|---|
| `create_frame` | `name, x, y, w, h` | `{ id }` |
| `list_frames` | — | `[{ id, name, x, y, w, h, shapeCount }]` — the map / table of contents |
| `read_frame` | `name` (or `id`) | `{ image, shapes: [...], bindings: [...] }` |

`read_frame` is the enriched read Mode A needs — it returns **both**:
- `image` — a PNG cropped to the frame (raster, so the agent can read freehand inside it),
- `shapes` — the structured shapes whose parent is the frame (`id, type, x, y, w, h, text`),
- `bindings` — for each arrow inside the frame, `{ arrowId, start: shapeId?, end: shapeId? }`
  so the agent knows *what connects to what* (the structural gap the spike test exposed).

Frame lookup is by `name`; names may collide → return the first match and include its `id`,
or error `ambiguous frame name` if the caller must disambiguate (decided at implementation).

### Phase 2 — Draw into frames

| tool | params | returns |
|---|---|---|
| `create_arrow` | `fromId, toId` (optional `text`) | `{ id }` |
| `create_note` | `x, y, text` | `{ id }` |

`create_arrow` binds the arrow to both shapes (moving a shape drags the arrow) — the wall the
spike test hit. `create_note` is a sticky for annotation. `create_shape` (rectangle / ellipse
/ text) already exists; shapes created inside a frame's bounds auto-parent.

### Phase 3 — Edit / annotate existing shapes

| tool | params | returns |
|---|---|---|
| `update_shape` | `id, { x?, y?, w?, h?, text?, color?, fill? }` | `{ id }` |
| `delete_shape` | `ids: string[]` | `{ deleted: number }` |

Lets the agent tidy or highlight the human's shapes (move, resize, relabel, recolour) and
remove clutter.

### Phase 4 — Navigate / point back

| tool | params | returns |
|---|---|---|
| `zoom_to_frame` | `name` | `{ ok: true }` |
| `select` | `ids: string[]` | `{ selected: number }` |

`zoom_to_frame` moves the camera so the human sees where the agent is working; `select`
highlights shapes to point back at the human — the agent's way of saying *these ones*.

## tldraw API grounding (verified via docs; exact helpers confirmed at implementation)

- **Frame:** `editor.createShape({ type: 'frame', x, y, props: { w, h, name, color } })`.
- **Shapes inside a frame:** filter `editor.getCurrentPageShapes()` by `parentId === frameId`
  (or `editor.getSortedChildIdsForParent(frameId)`).
- **Arrow bound to two shapes:** create the arrow, then
  `editor.createBinding({ type: 'arrow', fromId: arrowId, toId: shapeId, props: { terminal: 'start' | 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false, isExact: false } })` for each end.
- **Read an arrow's bindings:** `getArrowBindings(editor, arrowShape)` (import from `tldraw`)
  → `{ start?, end? }` each with `toId` (the bound shape). Also `editor.getBindingsFromShape` /
  `getBindingsToShape` for shape-centric queries.
- **Note:** `editor.createShape({ type: 'note', x, y, props: { richText: toRichText(text) } })`.
- **Update / delete / select / camera:** `editor.updateShape({ id, type, props })`,
  `editor.deleteShapes(ids)`, `editor.select(...ids)`, `editor.zoomToBounds(bounds)` /
  `editor.zoomToFit()`. Colour/fill live in `props` (`color`, `fill`) on geo/note shapes.

## Testing

- **Handler unit tests** (the pattern added for the dispatch refactor): each tool's handler
  is tested with a fake `call`, asserting it forwards the right args and shapes the MCP
  result — e.g. `read_frame` returns image + shapes + bindings, `create_arrow` forwards
  `fromId`/`toId`, `delete_shape` returns a count. No browser needed.
- **Browser `runTool`** is verified at runtime (probe + MCP) per phase, since the editor calls
  run on real DOM — the same manual-verification path the spike used.

## Scope / deferred

Focus Mode A's frame loop. **Deferred until it works end-to-end:** export to file (family E),
multi-page (F), composite flowchart / auto-layout (G), and Mode B orchestration (turn-token,
HTTP transport, per-agent attribution colours). Freehand-heavy geo extensions (triangle,
diamond, …) are added only if a real diagram needs them (YAGNI).

## Per-phase development plans

Tracked as **GitHub issues** (one per phase) on `CodeCampusCo/endgame-canvas`, not committed
files — the repo's `docs/superpowers/plans/` is gitignored by project policy. Each issue
carries the phase's goal, tool signatures, acceptance criteria, and dependencies, and links
back to this design.
