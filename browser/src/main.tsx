import { useState } from 'react'
import { Tldraw, type Editor, type TLShape, type TLShapeId, type IndexKey, toRichText, createShapeId, getArrowBindings, getIndices, PageRecordType } from 'tldraw'
import 'tldraw/tldraw.css'
import { createRoot } from 'react-dom/client'

const RELAY_URL = 'ws://localhost:9910/?role=browser'

// Real tldraw DefaultColorStyle enum values (verified in
// @tldraw/tlschema/dist-cjs/styles/TLColorStyle.js: defaultColorNames). Excludes
// 'black' (the no-agent default — must never be assigned to an agent) and 'white'
// (invisible against the canvas's light background).
const AGENT_PALETTE = [
  'blue', 'green', 'violet', 'orange', 'light-blue',
  'light-green', 'red', 'yellow', 'light-violet', 'grey',
] as const

// agent name → colour, populated the first time each agent is seen. This map IS
// what list_agents reports — the browser is the source of truth (agents seen
// since the page loaded), not whoever happens to be connected to the relay right now.
const agentColors = new Map<string, string>()

// Deterministic so the same agent name gets the same colour across restarts.
// Collisions between different names are acceptable at this scale (see task brief).
function colorForAgent(agent: string): string {
  const known = agentColors.get(agent)
  if (known) return known
  let hash = 0
  for (let i = 0; i < agent.length; i++) {
    hash = (hash * 31 + agent.charCodeAt(i)) | 0
  }
  const color = AGENT_PALETTE[Math.abs(hash) % AGENT_PALETTE.length]
  agentColors.set(agent, color)
  return color
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'))
    reader.readAsDataURL(blob)
  })
}

function shapeSnapshot(editor: Editor, s: TLShape) {
  const b = editor.getShapePageBounds(s)
  return {
    id: s.id,
    type: s.type,
    x: b?.x,
    y: b?.y,
    w: b?.w,
    h: b?.h,
    text: editor.getShapeUtil(s).getText(s) ?? '',
  }
}

function getFrames(editor: Editor) {
  return editor
    .getCurrentPageShapes()
    .filter((s): s is Extract<TLShape, { type: 'frame' }> => s.type === 'frame')
}

function findFrame(editor: Editor, name: string) {
  const frames = getFrames(editor)
  return name.startsWith('shape:')
    ? frames.find((s) => s.id === name)
    : frames.find((s) => s.props.name === name)
}

// Shared by create_arrow and the flowchart/connected tools: create an arrow shape
// bound at both ends (start→fromShapeId, end→toShapeId) so moving either shape
// drags the arrow with it.
function bindArrow(editor: Editor, fromShapeId: TLShapeId, toShapeId: TLShapeId, text?: string, color?: string) {
  if (!editor.getShape(fromShapeId)) throw new Error('shape not found: ' + fromShapeId)
  if (!editor.getShape(toShapeId)) throw new Error('shape not found: ' + toShapeId)
  const arrowId = createShapeId()
  const start = editor.getShapePageBounds(fromShapeId)
  editor.createShape({
    id: arrowId,
    type: 'arrow',
    x: start?.x ?? 0,
    y: start?.y ?? 0,
    props: { ...(text ? { text } : {}), ...(color ? { color } : {}) },
  })
  editor.createBinding({
    type: 'arrow',
    fromId: arrowId,
    toId: fromShapeId,
    props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false, isExact: false },
  })
  editor.createBinding({
    type: 'arrow',
    fromId: arrowId,
    toId: toShapeId,
    props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false, isExact: false },
  })
  return arrowId
}

// Shared by the create_flowchart and create_connected tools: a geo node with
// centered text, ready to be positioned by the caller. (create_shape keeps its
// own inline geo block — the shared props are duplicated, not routed through here.)
function createGeoNode(editor: Editor, geo: string, x: number, y: number, text: string, w: number, h: number, color?: string): TLShapeId {
  const id = createShapeId()
  editor.createShape({
    id,
    type: 'geo',
    x,
    y,
    props: {
      geo,
      w,
      h,
      richText: toRichText(text ?? ''),
      align: 'middle',
      verticalAlign: 'middle',
      font: 'draw',
      ...(color ? { color } : {}),
    },
  })
  return id
}

const FLOWCHART_NODE_W = 200
const FLOWCHART_NODE_H = 100
const FLOWCHART_GAP_X = 80
const FLOWCHART_GAP_Y = 120

type FlowchartNode = { key: string; text: string; shape?: string }
type FlowchartEdge = { from: string; to: string; text?: string }

// Layered top-down layout: layer[v] = 1 + max(layer[u]) over incoming edges u->v,
// roots (indegree 0) at layer 0. Kahn-style topological pass so cycles can't loop
// forever — any node left unprocessed after the pass lands one layer past the
// deepest layer we did assign; if there were no roots at all (pure cycle), every
// node lands at layer 0.
function treeLayers(nodes: FlowchartNode[], edges: FlowchartEdge[]): Map<string, number> {
  const indegree = new Map<string, number>(nodes.map((n) => [n.key, 0]))
  const outgoing = new Map<string, string[]>(nodes.map((n) => [n.key, []]))
  for (const e of edges) {
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1)
    outgoing.get(e.from)?.push(e.to)
  }
  const layer = new Map<string, number>()
  let queue = nodes.filter((n) => indegree.get(n.key) === 0).map((n) => n.key)
  for (const k of queue) layer.set(k, 0)
  const remaining = new Map(indegree)
  while (queue.length > 0) {
    const next: string[] = []
    for (const u of queue) {
      for (const v of outgoing.get(u) ?? []) {
        const candidate = (layer.get(u) ?? 0) + 1
        layer.set(v, Math.max(layer.get(v) ?? 0, candidate))
        const left = (remaining.get(v) ?? 0) - 1
        remaining.set(v, left)
        if (left === 0) next.push(v)
      }
    }
    queue = next
  }
  if (layer.size === 0) {
    // pure cycle, no roots
    for (const n of nodes) layer.set(n.key, 0)
  } else {
    const maxLayer = Math.max(...layer.values())
    for (const n of nodes) {
      if (!layer.has(n.key)) layer.set(n.key, maxLayer + 1)
    }
  }
  return layer
}

function flowchartPositions(
  nodes: FlowchartNode[],
  edges: FlowchartEdge[],
  layout: string,
  x: number,
  y: number,
): Map<string, { px: number; py: number }> {
  const positions = new Map<string, { px: number; py: number }>()
  if (layout === 'grid') {
    const cols = Math.ceil(Math.sqrt(nodes.length))
    nodes.forEach((n, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      positions.set(n.key, {
        px: x + col * (FLOWCHART_NODE_W + FLOWCHART_GAP_X),
        py: y + row * (FLOWCHART_NODE_H + FLOWCHART_GAP_Y),
      })
    })
    return positions
  }
  // 'tree' (default): group node keys by layer, preserving nodes[] order within each layer.
  const layer = treeLayers(nodes, edges)
  const byLayer = new Map<number, string[]>()
  for (const n of nodes) {
    const l = layer.get(n.key)!
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(n.key)
  }
  for (const [l, keys] of byLayer) {
    keys.forEach((key, j) => {
      positions.set(key, {
        px: x + j * (FLOWCHART_NODE_W + FLOWCHART_GAP_X),
        py: y + l * (FLOWCHART_NODE_H + FLOWCHART_GAP_Y),
      })
    })
  }
  return positions
}

async function runTool(editor: Editor, tool: string, params: any, agent?: string) {
  // Absent agent (no CANVAS_AGENT, e.g. an unlabelled probe) → undefined, so every
  // ...(color ? {...} : {}) spread below is a no-op and tldraw's own default applies —
  // behaviour is unchanged from before this feature existed.
  const color = agent ? colorForAgent(agent) : undefined
  // read_canvas/get_snapshot/list_frames/read_frame all call editor.getCurrentPageShapes(),
  // so they're inherently scoped to the current page — switch_page re-scopes them for free.
  if (tool === 'read_canvas') {
    const shapes = editor.getCurrentPageShapes()
    if (shapes.length === 0) return { empty: true }
    const { blob, width, height } = await editor.toImage(shapes, {
      format: 'png',
      background: true,
    })
    const url = await blobToDataUrl(blob)
    return { url, width, height }
  }
  if (tool === 'get_snapshot') {
    return editor.getCurrentPageShapes().map((s) => shapeSnapshot(editor, s))
  }
  if (tool === 'create_frame') {
    const { name, x, y, w, h } = params
    const id = createShapeId()
    editor.createShape({ id, type: 'frame', x, y, props: { w, h, name } })
    return { id }
  }
  if (tool === 'list_frames') {
    return getFrames(editor).map((s) => {
      const b = editor.getShapePageBounds(s)
      return {
        id: s.id,
        name: s.props.name,
        x: b?.x,
        y: b?.y,
        w: b?.w,
        h: b?.h,
        shapeCount: editor.getSortedChildIdsForParent(s.id).length,
      }
    })
  }
  if (tool === 'read_frame') {
    const frame = findFrame(editor, params.name)
    if (!frame) throw new Error('frame not found: ' + params.name)
    const children = editor
      .getSortedChildIdsForParent(frame.id)
      .map((id) => editor.getShape(id))
      .filter((s): s is TLShape => s != null)
    const bindings = children
      .filter((s): s is Extract<TLShape, { type: 'arrow' }> => s.type === 'arrow')
      .map((arrow) => {
        const b = getArrowBindings(editor, arrow)
        return { arrowId: arrow.id, start: b.start?.toId ?? null, end: b.end?.toId ?? null }
      })
    if (children.length === 0) return { url: null, width: 0, height: 0, shapes: [], bindings: [], frameId: frame.id }
    const { blob, width, height } = await editor.toImage(children, { format: 'png', background: true })
    const url = await blobToDataUrl(blob)
    return { url, width, height, shapes: children.map((s) => shapeSnapshot(editor, s)), bindings, frameId: frame.id }
  }
  if (tool === 'create_shape') {
    const { type, x, y, text } = params
    const id = createShapeId()
    if (type === 'text') {
      editor.createShape({
        id, type: 'text', x, y,
        props: { richText: toRichText(text ?? ''), ...(color ? { color } : {}) },
      })
    } else {
      editor.createShape({
        id,
        type: 'geo',
        x,
        y,
        props: {
          geo: type,
          w: 200,
          h: 100,
          richText: toRichText(text ?? ''),
          align: 'middle',
          verticalAlign: 'middle',
          font: 'draw',
          ...(color ? { color } : {}),
        },
      })
    }
    return { id }
  }
  if (tool === 'create_line') {
    const { points } = params
    const origin = points[0]
    const indices = getIndices(points.length)
    const pointsDict: Record<string, { id: string; index: IndexKey; x: number; y: number }> = {}
    points.forEach((p: { x: number; y: number }, i: number) => {
      const id = `point-${i}`
      pointsDict[id] = { id, index: indices[i], x: p.x - origin.x, y: p.y - origin.y }
    })
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'line',
      x: origin.x,
      y: origin.y,
      props: { points: pointsDict, scale: 1, ...(color ? { color } : {}) },
    })
    return { id }
  }
  if (tool === 'create_highlight') {
    const { points } = params
    const origin = points[0]
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'highlight',
      x: origin.x,
      y: origin.y,
      props: {
        segments: [
          { type: 'free', points: points.map((p: { x: number; y: number }) => ({ x: p.x - origin.x, y: p.y - origin.y, z: 0.5 })) },
        ],
        isComplete: true,
        isPen: false,
        scale: 1,
        ...(color ? { color } : {}),
      },
    })
    return { id }
  }
  if (tool === 'create_arrow') {
    const { fromId, toId, text } = params
    let id!: TLShapeId
    editor.run(() => {
      id = bindArrow(editor, fromId, toId, text, color)
    })
    return { id }
  }
  if (tool === 'create_note') {
    const { x, y, text } = params
    const id = createShapeId()
    editor.createShape({
      id, type: 'note', x, y,
      props: { richText: toRichText(text), ...(color ? { color } : {}) },
    })
    return { id }
  }
  if (tool === 'update_shape') {
    const { id, x, y, w, h, text, color, fill } = params
    const shape = editor.getShape(id)
    if (!shape) throw new Error('shape not found: ' + id)
    const props: Record<string, unknown> = {}
    if (w !== undefined) props.w = w
    if (h !== undefined) props.h = h
    if (color !== undefined) props.color = color
    if (fill !== undefined) props.fill = fill
    if (text !== undefined) {
      if (shape.type === 'arrow') props.text = text
      else props.richText = toRichText(text)
    }
    let local: { x: number; y: number } | undefined
    if (x !== undefined || y !== undefined) {
      const pb = editor.getShapePageBounds(shape) // page-space top-left
      const pagePoint = { x: x ?? pb!.x, y: y ?? pb!.y }
      local = editor.getPointInParentSpace(shape, pagePoint)
    }
    editor.updateShape({
      id,
      type: shape.type,
      ...(local ? { x: local.x, y: local.y } : {}),
      props,
    })
    return { id }
  }
  if (tool === 'delete_shape') {
    const { ids } = params
    const existing = ids.filter((id: any) => editor.getShape(id))
    editor.deleteShapes(existing)
    return { deleted: existing.length }
  }
  if (tool === 'zoom_to_frame') {
    const frame = findFrame(editor, params.name)
    if (!frame) throw new Error('frame not found: ' + params.name)
    const bounds = editor.getShapePageBounds(frame)
    if (!bounds) throw new Error('frame has no bounds: ' + params.name)
    editor.zoomToBounds(bounds)
    return { ok: true }
  }
  if (tool === 'select') {
    const { ids } = params
    // editor.select() stores whatever ids it's given verbatim — it does not check
    // that they reference existing shapes — so filter first for an honest count.
    const existing = ids.filter((id: any) => editor.getShape(id))
    editor.select(...existing)
    return { selected: editor.getSelectedShapeIds().length }
  }
  if (tool === 'create_page') {
    const { name } = params
    const id = PageRecordType.createId()
    editor.createPage({ id, name })
    return { id }
  }
  if (tool === 'list_pages') {
    const current = editor.getCurrentPageId()
    return editor.getPages().map((p) => ({ id: p.id, name: p.name, current: p.id === current }))
  }
  if (tool === 'switch_page') {
    const { name } = params
    const page = String(name).startsWith('page:')
      ? editor.getPage(name)
      : editor.getPages().find((p) => p.name === name)
    if (!page) throw new Error('page not found: ' + name)
    editor.setCurrentPage(page.id)
    return { ok: true }
  }
  if (tool === 'export_image') {
    const { target, name, format } = params
    let shapes: TLShape[]
    if (target === 'frame') {
      const frame = findFrame(editor, name)
      if (!frame) throw new Error('frame not found: ' + name)
      shapes = [frame]
    } else if (target === 'selection') {
      const ids = editor.getSelectedShapeIds()
      if (ids.length === 0) throw new Error('nothing selected')
      shapes = ids.map((id) => editor.getShape(id)).filter((s): s is TLShape => s != null)
    } else {
      shapes = editor.getCurrentPageShapes()
    }
    if (shapes.length === 0) throw new Error('nothing to export')
    if (format === 'svg') {
      const r = await editor.getSvgString(shapes, { background: true })
      if (!r) throw new Error('svg export failed')
      return { svg: r.svg, width: r.width, height: r.height }
    }
    const { blob, width, height } = await editor.toImage(shapes, { format, background: true })
    const url = await blobToDataUrl(blob)
    return { url, width, height }
  }
  if (tool === 'create_flowchart') {
    const { nodes, edges, layout = 'tree', frame, x = 100, y = 100 } = params
    const positions = flowchartPositions(nodes, edges, layout, x, y)

    const ids: Record<string, TLShapeId> = {}
    const arrowIds: string[] = []
    editor.run(() => {
      if (frame) {
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const { px, py } of positions.values()) {
          minX = Math.min(minX, px)
          minY = Math.min(minY, py)
          maxX = Math.max(maxX, px + FLOWCHART_NODE_W)
          maxY = Math.max(maxY, py + FLOWCHART_NODE_H)
        }
        const pad = 40
        editor.createShape({
          id: createShapeId(),
          type: 'frame',
          x: minX - pad,
          y: minY - pad,
          props: { w: maxX - minX + pad * 2, h: maxY - minY + pad * 2, name: frame },
        })
      }

      for (const node of nodes) {
        const { px, py } = positions.get(node.key)!
        ids[node.key] = createGeoNode(editor, node.shape ?? 'rectangle', px, py, node.text, FLOWCHART_NODE_W, FLOWCHART_NODE_H, color)
      }

      for (const edge of edges) {
        if (!(edge.from in ids)) throw new Error('unknown node key in edge: ' + edge.from)
        if (!(edge.to in ids)) throw new Error('unknown node key in edge: ' + edge.to)
        arrowIds.push(bindArrow(editor, ids[edge.from], ids[edge.to], edge.text, color))
      }
    })

    return { ids, arrowIds }
  }
  if (tool === 'create_connected') {
    const { fromId, text, shape = 'rectangle', direction = 'right' } = params
    const from = editor.getShape(fromId)
    if (!from) throw new Error('shape not found: ' + fromId)
    const b = editor.getShapePageBounds(fromId)!
    const GAP = 80
    const nx = direction === 'down' ? b.x : b.x + b.w + GAP
    const ny = direction === 'down' ? b.y + b.h + GAP : b.y
    let nodeId!: TLShapeId
    let arrowId!: TLShapeId
    editor.run(() => {
      nodeId = createGeoNode(editor, shape, nx, ny, text, FLOWCHART_NODE_W, FLOWCHART_NODE_H, color)
      arrowId = bindArrow(editor, fromId, nodeId, undefined, color)
    })
    return { nodeId, arrowId }
  }
  if (tool === 'list_agents') {
    return Array.from(agentColors, ([agent, color]) => ({ agent, color }))
  }
  throw new Error(`unknown tool: ${tool}`)
}

// 4001: the relay's app-defined code for "a newer browser took over" (see src/relay.ts).
// Every other close code (relay restarting, network blip, ordinary close) still retries.
const SUPERSEDED_CLOSE_CODE = 4001

function connectRelay(editor: Editor, onSuperseded: () => void) {
  const ws = new WebSocket(RELAY_URL)
  ws.onmessage = async (e) => {
    const { requestId, tool, params, agent } = JSON.parse(e.data as string)
    try {
      const result = await runTool(editor, tool, params, agent)
      ws.send(JSON.stringify({ requestId, ok: true, result }))
    } catch (err: any) {
      ws.send(JSON.stringify({ requestId, ok: false, error: String(err?.message ?? err) }))
    }
  }
  ws.onclose = (e) => {
    if (e.code === SUPERSEDED_CLOSE_CODE) {
      onSuperseded()
      return
    }
    setTimeout(() => connectRelay(editor, onSuperseded), 1000)
  }
}

function SupersededBanner() {
  return (
    <div
      style={{
        position: 'fixed',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10000,
        background: '#1d1d1d',
        color: '#fff',
        padding: '8px 16px',
        borderRadius: 8,
        fontSize: 13,
        fontFamily: 'sans-serif',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
      }}
    >
      Another tab took control of this canvas. Reload this tab to use it here.
    </div>
  )
}

function App() {
  const [superseded, setSuperseded] = useState(false)
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      {superseded && <SupersededBanner />}
      <Tldraw persistenceKey="endgame-canvas" onMount={(editor) => connectRelay(editor, () => setSuperseded(true))} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
