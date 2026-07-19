# endgame-canvas

A localhost [tldraw](https://tldraw.dev) canvas exposed over **MCP** — a shared visual medium
where agents (and, optionally, a human) draw and read a canvas to align understanding and
produce diagrams. The drawing faculty of the endgame dev-office.

> **Status: spike — kill criterion PASSED.** This repo proves one thing: an agent can read a
> human's *freehand* strokes off a live canvas. It did — reading a scribbled word, identifying
> which shape a freehand circle enclosed, and what a freehand arrow pointed at, all from a
> single `read_canvas` call. See [`docs/specs/2026-07-19-design.md`](docs/specs/2026-07-19-design.md)
> for the kill criterion and [`docs/superpowers/specs/2026-07-19-endgame-canvas-spike-impl-design.md`](docs/superpowers/specs/2026-07-19-endgame-canvas-spike-impl-design.md)
> for the as-built implementation design.

## The idea

The **browser tldraw editor is the source of truth**. The MCP server holds *no* canvas state —
every tool is a command the browser runs on the live `editor`, correlated by `requestId`. This
is the only topology where a human's freehand strokes are readable, because every read
round-trips to the live editor (a screenshot the model can actually see), rather than a
server-side shadow model that never sees what the human draws.

```
                        Terminal: bun run dev  (Vite serves the browser app)

Claude Code ──spawn──► bun src/server.ts ──(WS client, role=mcp)──┐
                        stdio MCP + WS client                     ▼
                                                          bun src/relay.ts   ── the durable hub
                                                          (Bun.serve WS :9910)
                                                                     ▲
Browser tab (localhost:5173) ──────────(WS client, role=browser)─────┘
   <Tldraw> = SOURCE OF TRUTH
```

- **relay** is a long-lived hub; the browser and every MCP server attach to it as WS clients.
- A request `{ requestId, tool, params }` is routed to the browser; the response
  `{ requestId, ok, result | error }` is routed back **to the calling client only — never
  broadcast**. `requestId` is the glue; it is what lets many agents share one canvas later
  (Mode B) without responses crossing wires.
- Two guards keep a tool call from hanging: no browser connected → immediate error; browser
  silent for 10 s (or the relay socket never opens) → `canvas timeout`.

## The three tools

| tool | what it does | editor call |
|---|---|---|
| `read_canvas` | render the whole canvas to a PNG (→ MCP image content) so the agent can read freehand | `editor.toImage(getCurrentPageShapes(), {format:'png', background:true})` → data URL |
| `get_snapshot` | list every shape: id, type, position, size, plain text | `getCurrentPageShapes()` + `getShapeUtil(s).getText(s)` |
| `create_shape` | draw a rectangle / ellipse / text back onto the canvas | `createShape({ id, type, x, y, props })` with `toRichText` |

Freehand pen strokes are stored as tldraw `draw` shapes (vector polylines) — legible only via
the **raster** path (`read_canvas`), not structurally. That is the whole reason `read_canvas`
exists; `get_snapshot` is for the clean shapes a party *places*.

## Stack

Bun (runtime / package manager / test — no build step for the server) · native `Bun.serve`
WebSocket relay (no `ws` dependency) · tldraw + React + Vite (browser app) ·
`@modelcontextprotocol/sdk` (stdio MCP).

## Getting started

```bash
bun install
```

Run the three pieces (relay and Vite are long-lived — leave them running):

```bash
bun run relay      # WS hub on ws://localhost:9910
bun run dev        # Vite dev server on http://localhost:5173
```

Open **http://localhost:5173/** in a browser and leave the tab open — the canvas connects to
the relay automatically (and auto-reconnects if the relay restarts).

Drive the canvas without MCP, to verify the loop:

```bash
bun scripts/probe.ts create   # draws a labelled rectangle on the canvas
bun scripts/probe.ts          # get_snapshot — lists the shapes
bun scripts/probe.ts read     # read_canvas — reports the PNG size
```

Register as an MCP server for an agent to use directly:

```bash
claude mcp add endgame-canvas -- bun /absolute/path/to/endgame-canvas/src/server.ts
# then restart so the three tools load
```

Run the tests:

```bash
bun test           # relay routing + MCP client (timeout, no-browser, unreachable)
```

## Project structure

```
src/                    Bun backend
  relay.ts              Bun.serve WS hub — role-aware, requestId routing, never broadcast
  server.ts             stdio MCP server + WS client to the relay; the three tools
  relay.test.ts  server.test.ts
browser/                Vite + React + tldraw frontend
  index.html
  src/main.tsx          <Tldraw persistenceKey> + onMount → WS client → runs tools on editor
scripts/
  probe.ts              drives the browser through the relay for manual verification
vite.config.ts          root: 'browser'
docs/                   design specs
```

## Deferred (do not build until it earns its place)

connect / flowchart / frame drawing, export-to-file, HTTP transport + turn-token, multi-agent
orchestration (Mode B), per-agent attribution colours, structured-read enrichment. The first
follow-up task is the relay socket-lifecycle pass (reject + evict pending calls on
browser/mcp disconnect) plus a server-side reconnect.
