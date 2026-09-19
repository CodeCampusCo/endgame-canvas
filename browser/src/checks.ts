// Structural diagram defects. Pure — no tldraw or React imports — so `bun test` can cover it.

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

// Overlap applies to these only: arrows and freehand strokes are meant to lie across things, and
// a frame contains its children.
const BOXES = new Set(['geo', 'note', 'text', 'image', 'embed', 'bookmark', 'video'])

// `frame` — the shapes' parent frame, when they have one — enables the clipping check.
export function findIssues(shapes: CheckShape[], bindings: CheckBinding[] = [], frame?: Bounds): Issue[] {
  const issues: Issue[] = []

  // growY is tldraw's record of growing a shape to fit its label; a label that merely wrapped
  // leaves it at 0. Geo only — a note has no w/h to resize, so its growth is not actionable.
  for (const s of shapes) {
    if (s.type === 'geo' && s.growY != null && s.growY > 0) {
      issues.push({ kind: 'text-overflow', id: s.id, grewBy: s.growY })
    }
  }

  // At most one pair per shape, so a pile of N reports ~N/2 issues rather than N².
  const boxes = shapes.filter((s) => BOXES.has(s.type))
  const reported = new Set<string>()
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i]
    if (reported.has(a.id)) continue
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j]
      if (reported.has(b.id)) continue
      // Strict: shapes laid edge to edge touch without overlapping.
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        issues.push({ kind: 'overlap', id: a.id, with: b.id })
        reported.add(a.id)
        reported.add(b.id)
        break
      }
    }
  }

  // A frame clips its children, so a child fully outside it renders nowhere while still being a
  // child. Partly-outside is left alone: it is visible, and reporting it would fire constantly.
  if (frame) {
    for (const s of shapes) {
      const outside =
        s.x >= frame.x + frame.w || s.x + s.w <= frame.x || s.y >= frame.y + frame.h || s.y + s.h <= frame.y
      if (outside) issues.push({ kind: 'clipped', id: s.id })
    }
  }

  // An unbound terminal looks connected but comes adrift when the shape moves.
  for (const b of bindings) {
    const missing: ('start' | 'end')[] = []
    if (!b.start) missing.push('start')
    if (!b.end) missing.push('end')
    if (missing.length > 0) issues.push({ kind: 'unbound-arrow', id: b.arrowId, missing })
  }

  return issues
}
