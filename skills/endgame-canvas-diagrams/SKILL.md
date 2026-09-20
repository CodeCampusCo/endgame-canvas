---
name: endgame-canvas-diagrams
description: >-
  Draw clear, easy-to-read diagrams on the endgame-canvas tldraw board via its MCP tools
  (create_graph, create_shape, create_arrow, create_frame, read_frame, export_image). Use this
  whenever the user asks to draw, diagram, sketch, visualize, or lay out something ON THE CANVAS
  — a flowchart, architecture diagram, org chart, dependency graph, sequence, state machine, or
  "draw X on the board / canvas" — even if they don't say the word "diagram". It encodes the
  readability rules (reading-order layout, minimal edge crossings, one accent colour, restraint,
  bound arrows) and the see-your-own-work verification loop that keep canvas diagrams legible.
  Do NOT use it for chart/graph data-viz (bar/line/pie — that's the dataviz skill), for HTML/SVG
  or Mermaid/draw.io/Excalidraw output, or for Figma/Miro — those render elsewhere, not on this
  MCP canvas.
---

# Drawing readable diagrams on endgame-canvas

The endgame-canvas MCP draws on a live tldraw board that a human is watching. A diagram is
"good" here when a person can glance at it and follow the flow without effort. The enemy of that
is clutter: crossed arrows, boxes that overlap, tiny text, and rainbow colour with no meaning.
This skill is the discipline that avoids those.

**The browser is the source of truth** — you draw by issuing commands, then you *read the canvas
back* to see what you actually made. You cannot skip that read: your mental model of the layout
is a guess until `read_frame` shows you the pixels.

## First: should this be a diagram at all?

Before reaching for a tool, ask: **would a reader learn more from this picture than from a
well-written paragraph or a three-column table?** If no, don't draw — say the thing instead. A
diagram nobody needed costs the reader more attention than the sentence it replaced.

Specifically, don't draw:

- **a list of things** — that's bullets or a table,
- **a before/after comparison** — that's a two-column table,
- **one box with a label** — that's a sentence,
- **quantities** (how much, how many, over time) — that's the dataviz skill, a different medium.

Diagrams earn their place when the *relationships* are the content: what flows into what, what
depends on what, what contains what, what happens in which order.

## Then: plan out loud before you draw

Say in one short message what you're about to draw — the shape of it, roughly how many nodes,
and anything you're cutting to stay in budget. The human can redirect you in a sentence; once
pixels exist, redirecting costs a redraw. Skip the pause only when the request already pins the
content exactly.

Decide these three things in the plan:

1. **What kind of graph?** Flow / dependency / hierarchy → `tree` layout. A flat set of peers
   with no strong flow → `grid`. If it's not a node-and-edge graph at all (a freeform sketch, a
   legend, a timeline), you'll hand-place shapes instead.
2. **Reading direction.** `tree` lays out top-down in layers, so put causes and inputs at the
   top, effects and outputs at the bottom. The reader's eye should travel *with* the arrows.
3. **What comes out.** See the budget below. Deciding what to cut is the design work; adding
   everything you know is not.

### The complexity budget

Per diagram (one frame), hard limits:

| Limit | Value |
|---|---|
| Nodes | 9 |
| Arrows | 12 |
| Accent-coloured shapes | 2 |
| Node label length | ~14 characters (see below) |

Target density is about 4/10 — complete enough to be technically true, sparse enough that nobody
needs a guide to read it. Over budget is not a reason to shrink the boxes; it's a signal that
this is two diagrams. Split into an **overview frame** plus a **detail frame** and let
`zoom_to_frame` move between them.

### The remove test

Run this before you draw, not after:

- Can I **remove** a node? Would a reader still understand?
- Can I **merge** two nodes? Two things that always travel together are one thing.
- Can I **remove** an arrow? If the relationship is obvious from the layout, the line is noise.
- Can I **remove** a label? If shape or position already says it, the words are redundant.

Deletion is the highest-quality move available to you. A diagram of 6 things someone understands
beats one of 15 they don't.

## Prefer `create_graph` — it does the hard part for you

For any node-and-edge diagram, reach for `create_graph` before hand-placing shapes. In one atomic
call it lays out the nodes, creates each shape, binds an arrow for every edge, and (with `frame`)
wraps the whole thing in a named frame.

```
create_graph({
  nodes: [ {key:"a", text:"Client"}, {key:"b", text:"API"}, {key:"c", text:"DB"} ],
  edges: [ {from:"a", to:"b", text:"request"}, {from:"b", to:"c", text:"query"} ],
  layout: "tree",
  frame: "Request flow"
})
```

**What the `tree` layout does for you, so you don't fight it:**

- Nodes are placed in layers by longest path, top-down.
- A node nothing points at drops to **one layer above its earliest consumer** rather than sitting
  at the top. So a source that feeds something deep in the graph lands *beside* it, not stranded
  at layer 0 with a long edge slicing across everything.
- Each layer is ordered by the mean position of its neighbours (barycentre), swept both
  directions, which uncrosses edges automatically.
- Parents are centred over the children they point at; leaves are centred under their parents.
- Node `key`s must be unique, and an edge from a node to itself is refused — tldraw draws a
  self-arrow as nothing at all and strands its label. For a state machine's self-transition, say
  it in the node's own label or in a `create_note` beside the diagram.
- The `frame` is re-fitted to what actually got drawn, so a node tldraw grew to fit an oversized
  label sits inside it rather than being clipped at its edge. Two limits worth knowing: the
  *rows* are still spaced for an ungrown node, so a grown one reaches into the row beneath it and
  comes back as an `overlap` alongside the `text-overflow`; and an arrow's own bounds do not
  include its label, so neither the re-fit nor the `clipped` check can see one. **Keep edge
  labels to a word or two** — a long one can spill past the frame and be clipped with nothing
  reporting it. Read the picture back if an edge label is doing real work.

**Because of that ordering pass, re-ordering `nodes[]` is no longer the lever it once was** — the
layout re-sorts each layer regardless, and `nodes[]` order only breaks ties between nodes with no
neighbours to be pulled toward. If a drawing still has crossings, the cause is the *graph*, not
the input order: you have a genuinely tangled dependency, and the fix is to cut an edge, merge
two nodes, or split into two frames.

Hand-place with `create_shape` only when the layout genuinely isn't a graph — a legend, a title
block, a freeform annotation. `create_shape` takes `type`/`x`/`y`/`text` only and gives you a
200×100 box; resize with `update_shape`. Align to the same rhythm the auto-layout uses (node
200×100, gaps 80 horizontal / 120 vertical) so the spacing reads as intentional. Never connect
two boxes with `create_line` — use `create_arrow` (or graph edges) so the arrow is *bound* and
follows the shapes when either moves.

## The readability rules

- **One frame per diagram.** Give `create_graph` a `frame` name. A named frame is the unit the
  human and you both refer to ("what's in *Request flow*?"), and it's what `read_frame`,
  `zoom_to_frame`, and `export_image` operate on. A diagram without a frame is hard to talk about
  and hard to export cleanly.
- **Labels ≤ ~14 characters.** Measured on the standard 200×100 node: 14 characters fit on one
  line, 15 wrap to two. The real ceiling is *width*, not character count, so all-caps or
  wide-letter text wraps sooner. A node label is a name, not a sentence — push detail into a
  sticky `create_note` beside the diagram, not into the box. Treat this as a guide for
  choosing names, not a rule that outranks accuracy: **if the right word wraps, use the right
  word.** A wrapped label is acceptable output, not a defect — arranging a diagram so it reads
  well by eye is the human's job, and they fix it by dragging in seconds. Never reword to fit.
- **One accent, on the 1–2 things to look at first.** Shapes take the agent's attribution colour
  by default (set via `CANVAS_AGENT`). Leave the whole diagram in that one colour, then give a
  *different* treatment to only the entry point, the answer, or the one node in trouble. If you
  are tempted to accent four things, you haven't decided yet what is focal. Colour is a
  spotlight; if everything is coloured, nothing is highlighted. Don't colour by category unless
  the category *is* the point.
- **Consistent shape vocabulary.** Pick a small set and hold to it — e.g. rectangle =
  process/service, `diamond` = decision, `cloud`/`ellipse` = external system, `hexagon` = data
  store. Mixed-meaning shapes make the reader re-learn the diagram halfway through. If the
  vocabulary isn't obvious, add a one-line legend as a `create_note` *beside* the frame, never
  floating inside the diagram area where it collides with nodes.
- **Let the layout breathe.** Don't fight the even spacing. If two clusters are unrelated, put
  them in separate frames rather than squeezing them together.

### Fixing a layout without doing arithmetic

`create_graph` places nodes for you, but hand-placed shapes and after-the-fact repairs used to
mean computing coordinates. They don't any more — say the relationship instead:

- **`place_shape({id, relativeTo, side, gap})`** — "put this to the right of that, 40px apart."
  `side` is `right`/`left`/`above`/`below`; `align` (`center` by default) lines the two up on the
  other axis. The shape named in `relativeTo` does not move. A *bound* arrow cannot be placed —
  it goes where the shapes it connects put it — so move those instead.
- **`nudge_shapes({ids, dx, dy})`** — shift a whole group by one offset. `list_frames` reports each
  frame's `shapeIds`, so "move everything in *Request flow* down 50" is two calls, not one per
  shape. Nudging a frame's children does **not** take them out of the frame the way dragging
  would: pushed past the edge they stay children and get clipped away to nothing. `read_frame`
  reports that as a `clipped` issue — move the frame itself if you meant to move the whole
  diagram.
- **`align_shapes` / `distribute_shapes` / `stack_shapes` / `pack_shapes`** — tldraw's own layout
  operations. `align_shapes` is the one that earns its keep here: boxes that are
  nearly-but-not-exactly aligned are what let an arrow slip diagonally through an unrelated node.
  Hand them a frame's `shapeIds` as they come: they arrange the *shapes* and skip any **bound**
  arrows in the list, which follow their endpoints anyway. (An arrow left loose is an ordinary
  shape and is laid out with the rest.) They need two shapes to work with — three for
  `distribute_shapes` — and say so rather than quietly doing nothing.
- **`flip_shapes`** — mirrors whatever ids you give it, arrows included, and the arrowheads
  re-route to the correct ends.

Every one takes explicit `ids` — there is no "whole frame" shorthand, because the ids are one
cheap `list_frames` away and an ambiguous target is worse than an extra call. Each lands as a
single undo step, so the human takes a whole rearrangement back with one ⌘Z.

### The emphasis you actually have

`update_shape({id, color, fill, size})` is the whole toolkit — there is no border-style or line-weight
control exposed. Verified on the dark canvas theme:

| `fill` | Looks like | Use for |
|---|---|---|
| `none` | outline only, transparent | every ordinary node — the default |
| `solid` | muted desaturated tint of the colour | quiet grouping, a secondary tier |
| `fill` | fully saturated block | **the 1–2 focal nodes, and nothing else** |
| `pattern` | diagonal hatching | a genuinely third state (deprecated, planned, out of scope) |
| `semi` | near-invisible on the dark theme | skip it |

`color` takes one of tldraw's 13 fixed names — `black`, `grey`, `light-violet`, `violet`, `blue`,
`light-blue`, `yellow`, `orange`, `green`, `light-green`, `light-red`, `red`, `white`. There are
no arbitrary hex colours and no brand palette; don't plan a design that needs one.

Node names render in sans and arrow labels in small grey mono automatically. Font family and
weight are fixed — pick good words instead. Text `size` (`s`/`m`/`l`/`xl`) *is* settable on
`create_shape` and `update_shape`, but on a geo box it drives the outline weight too (2 / 3.5 / 5 /
10 px), so a bigger label arrives with a heavier border. In a diagram every node is a peer: leave
it at `m`.

## Verify what you drew — don't trust the plan

After drawing, **`read_frame(<frame name>)`** to get the cropped image plus the shapes, their
arrow bindings, and the defects that were computed for you.

### What the tools hand you — no looking required

`read_frame` reports `issues`, and `create_graph` reports them the moment it draws. The field is
absent when there is nothing wrong, so its presence is itself the signal.

| `kind` | What happened | The fix |
|---|---|---|
| `text-overflow` | The label did not fit, so tldraw grew the box by `grewBy` px. It is now taller than the layout assumed and may be touching whatever is below it. | Shorten the label, or `update_shape({id, w, h})` to give it more room — either way the label is re-measured against the new size and the issue clears once it fits. A grown box measures `h + grewBy`, which is the `h` `read_frame` hands you. Watch what a *narrower* box costs: the label re-wraps into a taller column, so `grewBy` goes **up**. A label that merely *wrapped* is **not** reported: that is acceptable output, not a defect. Sticky notes are never reported either — growing to fit is what they are for. |
| `overlap` | Two boxes share pixels — `id` and `with`. | Move one: `place_shape`, `nudge_shapes`, or `update_shape`. |
| `unbound-arrow` | An arrow is bound at only one end (`missing` says which). It looks connected and comes adrift the moment that shape moves. | `delete_shape` it and redo with `create_arrow({fromId, toId})`. |
| `clipped` | A child of the frame sits entirely outside it. It is still a child — so it is in the shape list and is **not** a stray — but a frame clips its children, so it renders nowhere: not on screen, not in the image, not in an export. | Move it back inside with `nudge_shapes` or `update_shape({id, x, y})`, or lift it out of the frame with `update_shape({id, parent: 'page'})` to make it visible where it is. |

Each shape is reported once per kind, so a pile of boxes is one complaint rather than one per
pair. Fix, then read again — anything hidden behind the first fix surfaces on the next pass, so a
badly tangled frame can take several rounds to come back clean. If the same issue survives a fix,
the fix was the wrong one; change the approach rather than repeating it.

**`strays` is reported alongside them**, and it is not about the drawing but about the frame. tldraw drops a shape from a frame the moment it is dragged past the edge and never takes
it back on its own — not when the frame is resized to cover it again, not when the shape is moved
back inside. `read_frame` and `export_image` report those shapes as `strays`; the field is absent
when there are none. They are missing from the image, the shape list, and any frame export, while
the diagram still looks complete on screen, so an export made in that state is quietly short. Put
each one back with `update_shape({id, parent: '<frame name>'})`, which is the only thing that
undoes the drop.

### What only your eye can do

The image is there for the judgements arithmetic cannot make:

- arrows crossing each other (cut an edge, merge two nodes, or split the frame),
- composition — one heavy corner, a stranded node, a frame that is mostly empty,
- reading order — does the eye travel *with* the arrows, or against them?

Fix with `update_shape` / `delete_shape` / the arrange tools above, then read again. Two or three
quick read-fix passes is normal and is exactly how a good diagram gets made here — the same
see-it-then-correct loop a human uses. Only stop when the frame reads cleanly at a glance.

**Test drawings go on their own page.** `create_page` then `switch_page` before you experiment —
the human's current page is their workspace, and probe shapes landing in the middle of it are
both rude and risky to clean up afterwards. Note `switch_page` takes `name` (a page name or a
`page:...` id), not `id`; passing the wrong key throws and your draw silently lands on whatever
page was already open, so check the switch succeeded first.

## Finish

- `zoom_to_frame(<name>)` to point the human's shared view at the finished diagram.
- `export_image` (PNG or SVG, scoped to the frame) only when the user wants a file to drop into a
  doc — it's the one thing that lands on disk. Don't export unprompted.

## Things that don't work here — don't spend a cycle rediscovering them

- **Orthogonal / right-angle connectors.** tldraw arrows support `kind: 'elbow'`, but elbow
  routing has no obstacle avoidance and no way to choose a route, so an elbow between two nodes
  that aren't aligned will happily run straight through a box in between and drop its label on
  top of that box's text. Tried and reverted. The curved default is better here; keep connected
  nodes close and the curve stays short.
- **Dashed borders.** `dash` is not exposed by any tool, so treatments that depend on a dashed
  outline (optional, async, trust boundary) can't be expressed. Use the `fill` table above
  instead. Border *weight* is reachable through `size`, but it drags the label size along with it.
- **Brand colours or custom fonts.** The palette and the four font families are fixed and global;
  changing them would repaint the human's own strokes too.

## Quick reference — the tools this skill leans on

| Need | Tool |
|---|---|
| Whole diagram in one call (layout + arrows + frame) | `create_graph` |
| Extend an existing diagram by one node | `create_connected` |
| A single non-graph shape | `create_shape` (type/x/y/text/size) |
| Recolour / move / resize / relabel | `update_shape` (x/y/w/h/text/color/fill/size) |
| Put a shape beside another one | `place_shape` (side + gap, no coordinates) |
| Move a whole group | `nudge_shapes` (dx/dy) |
| Tidy a set of shapes | `align_shapes`, `distribute_shapes`, `stack_shapes`, `pack_shapes`, `flip_shapes` |
| The ids of everything in a frame | `list_frames` → `shapeIds` |
| Put a stray shape back into its frame | `update_shape({parent})` — a frame name, or `'page'` to lift it out |
| Bound arrow between two shapes | `create_arrow` |
| Annotation / legend | `create_note` |
| **See what you actually drew** | `read_frame` (crop + shapes + bindings + `issues`) |
| Read freehand / whole board | `read_canvas`, `get_snapshot` |
| Scratch space for experiments | `create_page`, `switch_page` |
| Point the human's view | `zoom_to_frame`, `select` |
| Export to file | `export_image` |
