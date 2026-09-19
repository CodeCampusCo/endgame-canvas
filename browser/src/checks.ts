// The diagram defects that are computable from structure, so the agent does not have to hunt
// for them in a raster. Pure — no tldraw or React imports — which is what lets `bun test` cover
// it, the same reason graph.ts is its own module. tools.ts feeds it live editor data and
// read_frame / create_graph report what it finds; the raster still does what only an eye can
// do (crossed arrows, composition, reading order).

export type CheckShape = {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  growY?: number
}

export type CheckBinding = { arrowId: string; start: string | null; end: string | null }

export type Issue =
  | { kind: 'text-overflow'; id: string; grewBy: number }
  | { kind: 'overlap'; id: string; with: string }
  | { kind: 'unbound-arrow'; id: string; missing: ('start' | 'end')[] }
  | { kind: 'clipped'; id: string }

export type Bounds = { x: number; y: number; w: number; h: number }

// Shapes a reader sees as a box. Arrows and freehand strokes are SUPPOSED to lie across things,
// so counting them would make the overlap check fire on every diagram; a frame contains its
// children by definition.
const BOXES = new Set(['geo', 'note', 'text', 'image', 'embed', 'bookmark', 'video'])

// `frame` — when the shapes are a frame's children — turns on the clipping check. Leave it out
// for a loose set of shapes, where nothing clips anything.
export function findIssues(shapes: CheckShape[], bindings: CheckBinding[] = [], frame?: Bounds): Issue[] {
  const issues: Issue[] = []

  // tldraw sets growY when a label does not fit and it grew the shape to compensate. Note this
  // is NOT "the label wrapped" — a label wrapping to two lines inside a 100px box leaves growY
  // at 0. growY > 0 means the box is taller than it was asked to be, which is what silently
  // pushes it into whatever sits below.
  // Only geo shapes: a sticky note grows to fit its text by design, has no w/h props to be
  // resized with, and NoteShapeUtil recomputes growY on every render — so reporting one would be
  // a complaint nobody can act on, and the issues list would never reach empty.
  for (const s of shapes) {
    if (s.type === 'geo' && s.growY != null && s.growY > 0) {
      issues.push({ kind: 'text-overflow', id: s.id, grewBy: s.growY })
    }
  }

  // Two boxes sharing pixels. Reported at most once per shape: a pile of N boxes is one thing
  // to fix, not N² complaints for the agent to loop on. A pair hidden behind an already-reported
  // shape surfaces on the next read, once the first fix lands.
  const boxes = shapes.filter((s) => BOXES.has(s.type))
  const reported = new Set<string>()
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i]
    if (reported.has(a.id)) continue
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j]
      if (reported.has(b.id)) continue
      // Strict comparisons: shapes laid edge to edge touch without overlapping.
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        issues.push({ kind: 'overlap', id: a.id, with: b.id })
        reported.add(a.id)
        reported.add(b.id)
        break
      }
    }
  }

  // A frame clips its children. A child moved entirely outside its frame's bounds — by a batch
  // nudge, say — is still a child, so it is listed in the shape data and is NOT a stray, but it
  // renders nowhere: not on screen, not in read_frame's image, not in a frame export. The exact
  // inverse of a stray, and just as silent. Only a child that is fully outside is reported, so a
  // shape merely poking over the edge (visible, and obvious in the image) never cries wolf.
  if (frame) {
    for (const s of shapes) {
      const outside =
        s.x >= frame.x + frame.w || s.x + s.w <= frame.x || s.y >= frame.y + frame.h || s.y + s.h <= frame.y
      if (outside) issues.push({ kind: 'clipped', id: s.id })
    }
  }

  // An arrow drawn between two shapes but bound to neither looks connected and comes adrift the
  // moment either shape moves.
  for (const b of bindings) {
    const missing: ('start' | 'end')[] = []
    if (!b.start) missing.push('start')
    if (!b.end) missing.push('end')
    if (missing.length > 0) issues.push({ kind: 'unbound-arrow', id: b.arrowId, missing })
  }

  return issues
}
