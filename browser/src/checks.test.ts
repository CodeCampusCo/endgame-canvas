import { expect, test } from 'bun:test'
import { findIssues, type CheckShape, type CheckBinding } from './checks'

function box(id: string, x: number, y: number, extra: Partial<CheckShape> = {}): CheckShape {
  return { id, type: 'geo', x, y, w: 200, h: 100, ...extra }
}

// --- text overflow ---

test('growY > 0 is reported as text-overflow with the amount it grew', () => {
  const shapes = [box('a', 0, 0, { growY: 34 }), box('b', 0, 300)]
  expect(findIssues(shapes)).toEqual([{ kind: 'text-overflow', id: 'a', grewBy: 34 }])
})

test('growY 0 or absent is not an issue — a label that merely wrapped is not a defect', () => {
  expect(findIssues([box('a', 0, 0, { growY: 0 }), box('b', 0, 300)])).toEqual([])
})

// --- overlap ---

test('two boxes sharing pixels are reported once, as a pair', () => {
  expect(findIssues([box('a', 0, 0), box('b', 100, 50)])).toEqual([
    { kind: 'overlap', id: 'a', with: 'b' },
  ])
})

test('boxes laid edge to edge touch without overlapping', () => {
  expect(findIssues([box('a', 0, 0), box('b', 200, 0)])).toEqual([])
})

test('a pile of three reports one pair, not three — the agent gets one thing to fix', () => {
  const issues = findIssues([box('a', 0, 0), box('b', 10, 10), box('c', 20, 20)])
  expect(issues).toEqual([{ kind: 'overlap', id: 'a', with: 'b' }])
})

test('arrows and freehand strokes lying across a box are not overlaps', () => {
  const shapes: CheckShape[] = [
    box('a', 0, 0),
    { id: 'arr', type: 'arrow', x: 10, y: 10, w: 180, h: 80 },
    { id: 'hl', type: 'highlight', x: 10, y: 10, w: 180, h: 80 },
    { id: 'line', type: 'line', x: 10, y: 10, w: 180, h: 80 },
    { id: 'draw', type: 'draw', x: 10, y: 10, w: 180, h: 80 },
  ]
  expect(findIssues(shapes)).toEqual([])
})

test('a frame containing a box is not an overlap', () => {
  const shapes: CheckShape[] = [
    { id: 'f', type: 'frame', x: 0, y: 0, w: 400, h: 400 },
    box('a', 40, 40),
  ]
  expect(findIssues(shapes)).toEqual([])
})

test('a note overlapping a box is an overlap — a legend dropped on the diagram counts', () => {
  const shapes: CheckShape[] = [box('a', 0, 0), { id: 'n', type: 'note', x: 50, y: 50, w: 200, h: 200 }]
  expect(findIssues(shapes)).toEqual([{ kind: 'overlap', id: 'a', with: 'n' }])
})

// --- unbound arrows ---

test('an arrow missing one terminal binding is reported with which end is loose', () => {
  const bindings: CheckBinding[] = [{ arrowId: 'arr', start: 'shape:a', end: null }]
  expect(findIssues([], bindings)).toEqual([{ kind: 'unbound-arrow', id: 'arr', missing: ['end'] }])
})

test('an arrow bound at neither end reports both', () => {
  const bindings: CheckBinding[] = [{ arrowId: 'arr', start: null, end: null }]
  expect(findIssues([], bindings)).toEqual([
    { kind: 'unbound-arrow', id: 'arr', missing: ['start', 'end'] },
  ])
})

test('a fully bound arrow is not an issue', () => {
  expect(findIssues([], [{ arrowId: 'arr', start: 'shape:a', end: 'shape:b' }])).toEqual([])
})

// --- across kinds ---

test('a grown box that now collides reports both — cause and effect are two useful facts', () => {
  // 'a' grew by 40, so its bounds (already including growY) reach into 'b' below it.
  const shapes = [box('a', 0, 0, { h: 140, growY: 40 }), box('b', 0, 120)]
  expect(findIssues(shapes)).toEqual([
    { kind: 'text-overflow', id: 'a', grewBy: 40 },
    { kind: 'overlap', id: 'a', with: 'b' },
  ])
})

test('a clean diagram produces no issues at all', () => {
  const shapes = [box('a', 0, 0), box('b', 0, 220), box('c', 280, 220)]
  const bindings: CheckBinding[] = [
    { arrowId: 'x', start: 'a', end: 'b' },
    { arrowId: 'y', start: 'a', end: 'c' },
  ]
  expect(findIssues(shapes, bindings)).toEqual([])
})

// --- clipped children ---

const FRAME = { x: 0, y: 0, w: 400, h: 400 }

test('a child pushed entirely outside its frame is reported as clipped', () => {
  expect(findIssues([box('a', 40, 40), box('b', 40, 900)], [], FRAME)).toEqual([
    { kind: 'clipped', id: 'b' },
  ])
})

test('a child merely poking over the edge is not reported — it is still visible', () => {
  expect(findIssues([box('a', 300, 350)], [], FRAME)).toEqual([])
})

test('a child flush against the outside of the edge is reported', () => {
  // The frame ends at y=400; this box starts there, so none of it renders.
  expect(findIssues([box('a', 40, 400)], [], FRAME)).toEqual([{ kind: 'clipped', id: 'a' }])
})

test('clipping is only checked when the shapes belong to a frame', () => {
  expect(findIssues([box('a', 40, 900)])).toEqual([])
})

test('a clipped shape can still be reported for overflow — the two are independent', () => {
  const issues = findIssues([box('a', 40, 900, { growY: 20 })], [], FRAME)
  expect(issues).toEqual([
    { kind: 'text-overflow', id: 'a', grewBy: 20 },
    { kind: 'clipped', id: 'a' },
  ])
})

test('a sticky note that grew is not reported — notes grow by design and have no w/h to resize', () => {
  const note: CheckShape = { id: 'n', type: 'note', x: 0, y: 0, w: 200, h: 300, growY: 99 }
  expect(findIssues([note])).toEqual([])
})

test('a geo box that grew is still reported next to an ignored note', () => {
  const shapes: CheckShape[] = [
    { id: 'n', type: 'note', x: 0, y: 0, w: 200, h: 300, growY: 99 },
    box('g', 0, 600, { growY: 12 }),
  ]
  expect(findIssues(shapes)).toEqual([{ kind: 'text-overflow', id: 'g', grewBy: 12 }])
})
