import { expect, test } from 'bun:test'
import { layoutScreen, isKnownKind, SCREENS, type Draw, type ScreenNode } from './screen'

// One line per 1.35 em, wrapping every 10 characters — enough to prove wrapped text pushes what
// follows it down, without depending on a real font.
const measure = (text: string, fontSize: number, maxWidth: number) => {
  const perLine = Math.max(1, Math.floor(maxWidth / 10))
  return Math.max(1, Math.ceil(text.length / perLine)) * fontSize * 1.35
}

const run = (root: ScreenNode, width = SCREENS.phone.w) => layoutScreen(root, { width, measure })
const geos = (draws: Draw[]) => draws.filter((d): d is Extract<Draw, { op: 'geo' }> => d.op === 'geo')
const texts = (draws: Draw[]) => draws.filter((d): d is Extract<Draw, { op: 'text' }> => d.op === 'text')

test('a column stacks its children with one gap between them, never before or after', () => {
  const { draws } = run({
    kind: 'column',
    children: [{ kind: 'button', text: 'A' }, { kind: 'button', text: 'B' }, { kind: 'button', text: 'C' }],
  })
  const ys = geos(draws).map((g) => g.y)
  expect(ys).toEqual([24, 24 + 48 + 16, 24 + (48 + 16) * 2])
})

test('a column inset by the screen padding is as wide as the screen minus both sides', () => {
  const { draws } = run({ kind: 'column', children: [{ kind: 'button', text: 'Sign in' }] })
  expect(geos(draws)[0]).toMatchObject({ x: 24, w: SCREENS.phone.w - 48 })
})

test('a row splits the width evenly when no child claims a span', () => {
  const { draws } = run({
    kind: 'column',
    children: [{ kind: 'row', children: [{ kind: 'button', text: 'A' }, { kind: 'button', text: 'B' }] }],
  })
  const [a, b] = geos(draws)
  const inner = SCREENS.phone.w - 48
  expect(a.w).toBeCloseTo((inner - 16) / 2)
  expect(b.x).toBeCloseTo(24 + a.w + 16)
})

test('a span claims that many twelfths, and the plain sibling takes the rest', () => {
  const { draws } = run({
    kind: 'column',
    children: [{ kind: 'row', children: [{ kind: 'button', text: 'side', span: 3 }, { kind: 'button', text: 'main' }] }],
  })
  const [side, main] = geos(draws)
  const inner = SCREENS.phone.w - 48 - 16
  expect(side.w).toBeCloseTo(inner * 0.25)
  expect(main.w).toBeCloseTo(inner * 0.75)
})

test('a row is as tall as its tallest child, so the next sibling clears all of them', () => {
  const { draws, height } = run({
    kind: 'column',
    children: [
      { kind: 'row', children: [{ kind: 'button', text: 'short' }, { kind: 'image', h: 200 }] },
      { kind: 'button', text: 'below' },
    ],
  })
  const below = geos(draws)[2]
  expect(below.y).toBe(24 + 200 + 16)
  expect(height).toBe(24 + 200 + 16 + 48 + 24)
})

test('a panel wraps its children in a rectangle sized to what it holds', () => {
  const { draws } = run({
    kind: 'column',
    children: [{ kind: 'panel', children: [{ kind: 'button', text: 'inside' }] }],
  })
  const [panel, button] = geos(draws)
  expect(panel).toMatchObject({ shape: 'rectangle', x: 24, y: 24 })
  // padding · child · padding
  expect(panel.h).toBe(24 + 48 + 24)
  expect(button).toMatchObject({ x: 24 + 24, y: 24 + 24, w: SCREENS.phone.w - 48 - 48 })
})

test('wrapped text pushes the next element down — the reason heights are measured, not assumed', () => {
  const short = run({ kind: 'column', children: [{ kind: 'body', text: 'hi' }, { kind: 'button', text: 'go' }] })
  const long = run({
    kind: 'column',
    children: [{ kind: 'body', text: 'x'.repeat(200) }, { kind: 'button', text: 'go' }],
  })
  const buttonY = (r: ReturnType<typeof run>) => geos(r.draws)[0].y
  expect(buttonY(long)).toBeGreaterThan(buttonY(short))
})

test('an input draws label, box and placeholder, with the placeholder inside the box', () => {
  const { draws } = run({
    kind: 'column',
    children: [{ kind: 'input', label: 'Email', placeholder: 'you@example.com' }],
  })
  const box = geos(draws)[0]
  const [label, placeholder] = texts(draws)
  expect(label).toMatchObject({ text: 'Email', size: 's', muted: true, y: 24 })
  expect(box.y).toBeGreaterThan(label.y)
  expect(placeholder.x).toBe(box.x + 12)
  expect(placeholder.y).toBeGreaterThan(box.y)
  expect(placeholder.y).toBeLessThan(box.y + box.h)
})

test('a select is an input plus a caret inside its right edge', () => {
  const { draws } = run({ kind: 'column', children: [{ kind: 'select', label: 'Country', text: 'Thailand' }] })
  const caret = geos(draws).find((g) => g.shape === 'arrow-down')!
  const box = geos(draws).find((g) => g.shape === 'rectangle')!
  expect(caret.x + caret.w).toBe(box.x + box.w - 12)
  expect(caret.y).toBeGreaterThan(box.y)
})

test('a button is an empty box with its label centred over it — no box ever carries text', () => {
  const { draws } = run({ kind: 'column', children: [{ kind: 'button', text: 'Sign in' }] })
  const box = geos(draws)[0]
  const label = texts(draws)[0]
  expect(label).toMatchObject({ text: 'Sign in', align: 'middle', x: box.x, w: box.w })
  expect(label.y).toBeGreaterThan(box.y)
  expect(draws.every((d) => d.op !== 'geo' || !('text' in d))).toBe(true)
})

test('a primary button is filled and a secondary one is not', () => {
  const { draws } = run({
    kind: 'column',
    children: [{ kind: 'button', text: 'Sign in' }, { kind: 'button', text: 'Cancel', primary: false }],
  })
  expect(geos(draws).map((g) => g.fill)).toEqual(['solid', 'none'])
})

test('a checkbox is a fixed tick beside its label, and a radio is the round one', () => {
  const { draws } = run({
    kind: 'column',
    children: [{ kind: 'checkbox', text: 'Remember me' }, { kind: 'radio', text: 'Card' }],
  })
  const shapes = geos(draws)
  expect(shapes.map((g) => g.shape)).toEqual(['check-box', 'ellipse'])
  expect(shapes[0]).toMatchObject({ w: 28, h: 28 })
  expect(texts(draws)[0].x).toBe(24 + 28 + 16)
})

test('a wrapped checkbox label grows downward, never back over the element above it', () => {
  const { draws } = run({
    kind: 'column',
    children: [{ kind: 'button', text: 'above' }, { kind: 'checkbox', text: 'x'.repeat(120) }],
  })
  const top = 24 + 48 + 16
  const tick = geos(draws).find((g) => g.shape === 'check-box')!
  const label = texts(draws).find((t) => t.text.startsWith('x'))!
  expect(tick.y).toBeGreaterThanOrEqual(top)
  expect(label.y).toBeGreaterThanOrEqual(top)
})

test('keys ride along on the shape the caller named, so ids come back addressable', () => {
  const { draws } = run({
    kind: 'column',
    children: [{ kind: 'button', text: 'Sign in', key: 'submit' }, { kind: 'body', text: 'or', key: 'hint' }],
  })
  // A key names the element, not one shape of it: the button's box and its label both answer to it.
  expect(draws.filter((d) => d.key === 'submit').map((d) => d.op)).toEqual(['geo', 'text'])
  expect(draws.filter((d) => d.key === 'hint').map((d) => d.op)).toEqual(['text'])
})

test('an unknown kind is named rather than silently skipped', () => {
  expect(() => run({ kind: 'column', children: [{ kind: 'carousel' }] })).toThrow('unknown element kind: carousel')
  expect(isKnownKind('carousel')).toBe(false)
  expect(isKnownKind('checkbox')).toBe(true)
})
