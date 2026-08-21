# endgame-canvas

A localhost tldraw canvas exposed over MCP — a human and an agent draw and read the same canvas
from chat. README.md is the product overview; this file is the working guide for the codebase —
the invariants to preserve and the decisions behind them.

## Scope (a settled decision — don't silently reverse it)

**One human, one agent, one browser.** The full tool set is built (README lists it); the
remaining thing to know when working here is what was deliberately **cut**: multi-agent
orchestration ("Mode B" — write serialization / turn-token, HTTP transport for many MCP
clients). Don't re-add it without a reason, because the premise was wrong — writes are already
serialized (every call funnels through one relay into one browser, and every write tool is
synchronous, so they cannot interleave), and multi-browser would require a real multiplayer sync
backend this localhost tool does not want.

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
`runTool` (`browser/src/tools.ts`) + a handler unit test using a fake `call`. Browser-side
logic has no unit-test harness (except the pure layout in `graph.ts`, which does) — verify the
rest at runtime against the live canvas with a short script that imports
`createCanvasClient`/`createDispatcher` from `src/server.ts` and drives the editor over the
relay (a fresh connection, so no MCP-server restart needed).

The skill in `skills/endgame-canvas-diagrams/` documents facts derived from this code — node
size, how far a label fits before it wraps, which properties each tool exposes, what cannot be
set at all. Change a tool's surface or the layout and update it in the same commit; it has no
test to fail, so it goes stale silently. (It ships as a plugin — see README.)

The browser app (`browser/src/`) is split by concern: `graph.ts` — pure node/edge layout, no
tldraw or React imports; `tools.ts` — `runTool` and its editor helpers, including per-agent
attribution; `connect.ts` — the WS relay wiring; `main.tsx` — the Vite entry and React shell.

Prefer tldraw's built-ins over hand-rolled equivalents: `editor.run()` to make a multi-shape
tool one atomic transaction and one undo step, `getSortedChildIdsForParent` for frame children,
`getSvgString` for SVG export, `getPointInParentSpace` when converting page coordinates (read
tools report page space; shape `x`/`y` are parent-local).

## Stack

Bun (runtime / package manager / test) · tldraw + React + Vite (browser app) ·
`@modelcontextprotocol/sdk` (stdio MCP) · native `Bun.serve` WebSocket relay. **No build step.**
`bun test` runs the suite; `bun run start` brings up the live stack (relay + Vite). See README
for the run commands and MCP setup.
