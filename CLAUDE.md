# endgame-canvas

A localhost tldraw canvas exposed over MCP — a shared visual medium where agents (and,
optionally, a human) draw and read a canvas to align understanding and produce diagrams.
The drawing faculty of the endgame dev-office: one MCP core serving both a personal
whiteboard (human + one agent) and a team diagram board (many agents, PM-orchestrated).

## Status

**Spike.** Proving one thing: can an agent read a human's freehand off the canvas? See
`docs/specs/2026-07-19-design.md` for the design and kill criterion. Do not build beyond
the three spike tools (`read_canvas`, `get_snapshot`, `create_shape`) until the kill
criterion passes.

## Architecture rule

The **browser tldraw editor is the source of truth**. The MCP server holds no canvas
state — every tool is a command the browser runs on the live `editor`, correlated by
`requestId`. This is what makes reading human strokes possible; do not move canvas state
server-side. The WS relay routes each response to its caller only — never broadcast.

## Stack

Bun (runtime / package manager / test) · tldraw + React + Vite (browser app) ·
`@modelcontextprotocol/sdk` (stdio MCP) · native `Bun.serve` WebSocket relay. The MCP
server runs as `bun server.ts` — no build step.
