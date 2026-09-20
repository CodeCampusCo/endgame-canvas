// Wireframe layout: a tree of elements in, a flat list of shapes to draw out. Pure — no tldraw
// and no React imports, so the arithmetic is unit-testable without a browser (same rule as
// graph.ts). Text heights come in through `measure`, because only the browser knows how far a
// string wraps at a given width.

export const SCREENS: Record<string, { w: number; h: number }> = {
  phone: { w: 390, h: 844 },
  desktop: { w: 1440, h: 900 },
}

// The whole spacing vocabulary. Anything not on this scale is a number someone made up.
const PAD = 24
const GAP = 16
const LABEL_GAP = 8
const COLS = 12
const FIELD_H = 48
const TICK = 28
const CARET = 12
const IMAGE_H = 180
const LINE_H = 1.35
// A box carries its own label, so these are tldraw's numbers, not ours: every box is drawn at
// `size: 's'`, whose label renders at 18px inside 16px of padding per side.
const LABEL_FS = 18
const LABEL_PAD = 16

const FONT = { heading: 36, body: 24, caption: 18, link: 18 } as const
const TEXT_SIZE = { 36: 'l', 24: 'm', 18: 's' } as const

export type Measure = (text: string, fontSize: number, maxWidth: number) => number

export type ScreenNode = {
  kind: string
  key?: string
  span?: number
  text?: string
  label?: string
  placeholder?: string
  primary?: boolean
  h?: number
  children?: ScreenNode[]
}

export type Draw =
  | {
      op: 'geo'; shape: string; x: number; y: number; w: number; h: number
      fill: 'none' | 'solid'; muted?: boolean
      text?: string; align?: 'start' | 'middle'; labelMuted?: boolean
      key?: string
    }
  | { op: 'text'; x: number; y: number; w: number; text: string; size: 's' | 'm' | 'l'; muted: boolean; align: 'start' | 'middle'; key?: string }

const CONTAINERS = new Set(['column', 'row', 'panel'])
const LEAVES = new Set([
  'heading', 'body', 'caption', 'link',
  'input', 'select', 'button', 'checkbox', 'radio', 'image', 'divider',
])

export function isKnownKind(kind: string) {
  return CONTAINERS.has(kind) || LEAVES.has(kind)
}

// Children without a span share whatever the explicit spans left over, so a row of three plain
// children is thirds and `span: 3` beside a plain child is a quarter and the rest.
function spansFor(children: ScreenNode[]): number[] {
  const given = children.map((c) => (typeof c.span === 'number' ? c.span : 0))
  const claimed = given.reduce((a, b) => a + b, 0)
  const free = given.filter((s) => s === 0).length
  if (free === 0) return given
  const each = Math.max(1, (COLS - claimed) / free)
  return given.map((s) => (s === 0 ? each : s))
}

export function layoutScreen(
  root: ScreenNode,
  opts: { width: number; measure: Measure },
): { draws: Draw[]; height: number } {
  const draws: Draw[] = []
  const { measure } = opts

  // What tldraw will make the box once its own label is measured: it grows a box whose label does
  // not fit, and never shrinks one that is taller than its label.
  function boxHeight(label: string, w: number): number {
    return Math.max(FIELD_H, measure(label, LABEL_FS, w - LABEL_PAD * 2))
  }

  function text(node: ScreenNode, x: number, y: number, w: number, fontSize: number, muted: boolean): number {
    const body = node.text ?? ''
    draws.push({
      op: 'text', x, y, w, text: body,
      size: TEXT_SIZE[fontSize as keyof typeof TEXT_SIZE], muted, align: 'start',
      ...(node.key ? { key: node.key } : {}),
    })
    return measure(body, fontSize, w)
  }

  // Returns the height the node occupied, having pushed its shapes.
  function place(node: ScreenNode, x: number, y: number, w: number): number {
    const kind = node.kind
    const kids = node.children ?? []
    const k = node.key ? { key: node.key } : {}

    if (kind === 'column' || kind === 'panel') {
      const inset = kind === 'panel' ? PAD : 0
      // The panel's own rectangle is sized once its children are placed; hold its slot.
      const slot = draws.length
      if (kind === 'panel') draws.push({ op: 'geo', shape: 'rectangle', x, y, w, h: 1, fill: 'none', ...k })
      let cursor = y + inset
      for (const [i, kid] of kids.entries()) {
        cursor += place(kid, x + inset, cursor, w - inset * 2)
        if (i < kids.length - 1) cursor += GAP
      }
      const height = cursor - y + inset
      if (kind === 'panel') (draws[slot] as Extract<Draw, { op: 'geo' }>).h = Math.max(1, height)
      return height
    }

    if (kind === 'row') {
      const spans = spansFor(kids)
      const available = w - GAP * Math.max(0, kids.length - 1)
      let cursor = x
      let tallest = 0
      for (const [i, kid] of kids.entries()) {
        const kw = (available * spans[i]) / COLS
        tallest = Math.max(tallest, place(kid, cursor, y, kw))
        cursor += kw + GAP
      }
      return tallest
    }

    if (kind === 'heading' || kind === 'body' || kind === 'caption' || kind === 'link') {
      return text(node, x, y, w, FONT[kind], kind === 'caption')
    }

    if (kind === 'input' || kind === 'select') {
      let top = y
      if (node.label) {
        draws.push({ op: 'text', x, y: top, w, text: node.label, size: 's', muted: true, align: 'start', ...k })
        top += measure(node.label, FONT.caption, w) + LABEL_GAP
      }
      const inner = node.placeholder ?? node.text ?? ''
      const h = boxHeight(inner, w)
      draws.push({
        op: 'geo', shape: 'rectangle', x, y: top, w, h, fill: 'none',
        text: inner, align: 'start', labelMuted: true, ...k,
      })
      if (kind === 'select') {
        draws.push({ op: 'geo', shape: 'arrow-down', x: x + w - LABEL_PAD - CARET, y: top + (h - CARET) / 2, w: CARET, h: CARET, fill: 'solid', ...k })
      }
      return top + h - y
    }

    if (kind === 'button') {
      const body = node.text ?? ''
      const h = boxHeight(body, w)
      draws.push({
        op: 'geo', shape: 'rectangle', x, y, w, h,
        fill: node.primary === false ? 'none' : 'solid',
        text: body, align: 'middle', ...k,
      })
      return h
    }

    if (kind === 'checkbox' || kind === 'radio') {
      const labelW = w - TICK - GAP
      const body = node.text ?? ''
      const h = measure(body, FONT.body, labelW)
      // Centre the tick against the label's FIRST line, not against the whole of a wrapped one:
      // centring on the total would start a two-line label above y and reach back over whatever
      // sits above this element.
      const line = FONT.body * LINE_H
      const tickY = y + Math.max(0, (line - TICK) / 2)
      const textY = y + Math.max(0, (TICK - line) / 2)
      draws.push({
        op: 'geo', shape: kind === 'checkbox' ? 'check-box' : 'ellipse',
        x, y: tickY, w: TICK, h: TICK, fill: 'none', ...k,
      })
      draws.push({ op: 'text', x: x + TICK + GAP, y: textY, w: labelW, text: body, size: 'm', muted: false, align: 'start', ...k })
      return Math.max(tickY + TICK, textY + h) - y
    }

    if (kind === 'image') {
      const h = node.h ?? IMAGE_H
      draws.push({ op: 'geo', shape: 'x-box', x, y, w, h, fill: 'none', ...k })
      return h
    }

    if (kind === 'divider') {
      draws.push({ op: 'geo', shape: 'rectangle', x, y, w, h: 2, fill: 'solid', muted: true, ...k })
      return 2
    }

    throw new Error('unknown element kind: ' + kind)
  }

  const height = place(root, PAD, PAD, opts.width - PAD * 2) + PAD * 2
  return { draws, height }
}
