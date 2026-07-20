# endgame-canvas

A localhost tldraw canvas exposed over MCP — a shared visual medium where a human and an agent
draw and read the same canvas to align understanding and produce diagrams: a personal
whiteboard, driven from chat. See README.md for the product overview.

## Status

**Working tool set.** An agent can read a human's freehand off the live canvas, and the frame
whiteboard plus the full draw/export vocabulary are built: frames (create/list/read), bound
arrows, notes, edit/delete, camera + selection, extended geo shapes, lines and highlights,
image export to disk, multi-page, and composite flowcharts. Relay socket-lifecycle hardening
and per-agent attribution colours are in as well.

**Scope: one human, one agent, one browser.** Multi-agent orchestration ("Mode B" — write
serialization / turn-token, HTTP transport for many MCP clients) was explored and **cut**. Two
reasons worth remembering: writes are already serialized for free (every call funnels through
one relay into one browser, and every write tool is synchronous, so writes cannot interleave),
and multi-browser would require a real multiplayer sync backend, which this localhost tool
does not want.

## Architecture rule

The **browser tldraw editor is the source of truth**. The MCP server holds no canvas state —
every tool is a command the browser runs on the live `editor`, correlated by `requestId`. This
is what makes reading human strokes possible; do not move canvas state server-side. The one
sanctioned exception: `export_image`'s handler writes the exported file with `Bun.write` — an
output artifact, not canvas state.

The WS relay routes each response to its caller only — never broadcast. Exactly **one** browser
is supported: the newest connection wins, and the relay closes the superseded one with code
`4001`, which the browser treats as "stop reconnecting" (any other close code still retries).

## Adding a tool

One `TOOL_DEFS` entry + one handler in `createDispatcher` (`src/server.ts`) + one branch in
`runTool` (`browser/src/main.tsx`) + a handler unit test using a fake `call`. Browser-side
logic has no unit-test harness — verify it at runtime against the live canvas with a short
script that imports `createCanvasClient`/`createDispatcher` from `src/server.ts` and drives the
editor over the relay (a fresh connection, so no MCP-server restart needed).

Prefer tldraw's built-ins over hand-rolled equivalents: `editor.run()` to make a multi-shape
tool one atomic transaction and one undo step, `getSortedChildIdsForParent` for frame children,
`getSvgString` for SVG export, `getPointInParentSpace` when converting page coordinates (read
tools report page space; shape `x`/`y` are parent-local).

## Stack

Bun (runtime / package manager / test) · tldraw + React + Vite (browser app) ·
`@modelcontextprotocol/sdk` (stdio MCP) · native `Bun.serve` WebSocket relay. The MCP server
runs as `bun src/server.ts` — no build step. `bun run start` (`scripts/dev.ts`) launches the
relay + Vite together in one terminal, auto-freeing stale ports; `bun run relay` / `bun run dev`
still work individually for debugging.
