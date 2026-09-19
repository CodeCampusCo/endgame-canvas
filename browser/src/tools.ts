import { type Editor, type TLShape, type TLShapeId, type IndexKey, toRichText, createShapeId, getArrowBindings, getIndices, PageRecordType } from 'tldraw'
import { graphPositions, NODE_W, NODE_H } from './graph'
import { findIssues, type CheckShape } from './checks'

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

// The check module's view of a shape: page bounds — which already include growY, since tldraw
// reports a grown box at its grown height — plus the raw growY that says it was grown at all.
function checkShape(editor: Editor, s: TLShape): CheckShape {
  const b = editor.getShapePageBounds(s)
  return {
    id: s.id,
    type: s.type,
    x: b?.x ?? 0,
    y: b?.y ?? 0,
    w: b?.w ?? 0,
    h: b?.h ?? 0,
    growY: (s.props as { growY?: number }).growY,
  }
}

function getFrames(editor: Editor) {
  return editor
    .getCurrentPageShapes()
    .filter((s): s is Extract<TLShape, { type: 'frame' }> => s.type === 'frame')
}

// Shapes that sit over a frame without being its children. tldraw drops a shape from a
// frame the moment it is dragged past the edge and never takes it back — not when the frame
// is resized to cover it again, and not when the shape is moved back inside. So a frame can
// look complete on screen while read_frame and export_image quietly leave those shapes out.
// Reporting them turns that silent omission into something the caller can see and fix
// (update_shape's `parent`).
function straysOver(editor: Editor, frame: TLShape) {
  const fb = editor.getShapePageBounds(frame)
  if (!fb) return []
  return editor
    .getCurrentPageShapes()
    // hasAncestor, not parentId: a shape inside a frame inside this one is already part of the
    // picture and part of the export. Calling it a stray would send the caller to reparent it,
    // which would tear it out of the inner frame for nothing.
    .filter((s) => s.type !== 'frame' && !editor.hasAncestor(s, frame.id))
    .filter((s) => {
      const b = editor.getShapePageBounds(s)
      return b != null && b.x < fb.x + fb.w && b.x + b.w > fb.x && b.y < fb.y + fb.h && b.y + b.h > fb.y
    })
    .map((s) => shapeSnapshot(editor, s))
}

function findFrame(editor: Editor, name: string) {
  const frames = getFrames(editor)
  // A "shape:" prefix means "this is an id", but nothing stops a human naming a frame that way —
  // and then every tool that takes a name would lose it. Fall back to the name.
  return name.startsWith('shape:')
    ? (frames.find((s) => s.id === name) ?? frames.find((s) => s.props.name === name))
    : frames.find((s) => s.props.name === name)
}

// Shared by create_arrow and the graph/connected tools: create an arrow shape
// bound at both ends (start→fromShapeId, end→toShapeId) so moving either shape
// drags the arrow with it.
function bindArrow(editor: Editor, fromShapeId: TLShapeId, toShapeId: TLShapeId, text?: string, color?: string) {
  // tldraw routes an arrow between two terminals; given one shape twice it produces a 0x0 shape
  // that draws nothing and leaves the label floating, while both ends count as bound so no check
  // can see it. Refuse instead.
  if (fromShapeId === toShapeId) throw new Error('an arrow needs two different shapes, got the same one twice: ' + fromShapeId)
  if (!editor.getShape(fromShapeId)) throw new Error('shape not found: ' + fromShapeId)
  if (!editor.getShape(toShapeId)) throw new Error('shape not found: ' + toShapeId)
  const arrowId = createShapeId()
  const start = editor.getShapePageBounds(fromShapeId)
  editor.createShape({
    id: arrowId,
    type: 'arrow',
    x: start?.x ?? 0,
    y: start?.y ?? 0,
    props: { font: 'mono', size: 's', labelColor: 'grey', dash: 'solid', ...(text ? { text } : {}), ...(color ? { color } : {}) },
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

// Shared by the create_graph and create_connected tools: a geo node with
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
      font: 'sans',
      dash: 'solid',
      ...(color ? { color } : {}),
    },
  })
  return id
}

// tldraw's Editor already implements every multi-shape move; these tools are the thin exposure
// of them. Each takes explicit `ids` — there is no "ids or frame" alternative, because a schema
// cannot express "exactly one of these two", which would leave the tool depending on the caller
// to choose correctly. list_frames reports shapeIds for the "everything in this frame" case.
const BATCH_OPS: Record<string, (editor: Editor, ids: TLShapeId[], p: any) => void> = {
  nudge_shapes: (e, ids, p) => e.nudgeShapes(ids, { x: p.dx, y: p.dy }),
  align_shapes: (e, ids, p) => e.alignShapes(ids, p.edge),
  distribute_shapes: (e, ids, p) => e.distributeShapes(ids, p.axis),
  stack_shapes: (e, ids, p) => e.stackShapes(ids, p.axis, p.gap),
  pack_shapes: (e, ids, p) => e.packShapes(ids, p.gap),
  flip_shapes: (e, ids, p) => e.flipShapes(ids, p.axis),
}

// align/distribute/stack/pack merge shapes joined by an arrow that is ITSELF in the id list
// into one cluster, then return early when fewer than this many clusters remain. A connected
// diagram collapses to one cluster, so handing them a frame's shapeIds — exactly what list_frames
// offers — moves nothing while still reporting a count. Bound arrows follow their shapes anyway,
// so drop them and arrange the shapes. flip_shapes does no clustering and takes ids as given.
const CLUSTERING_MIN: Record<string, number> = {
  align_shapes: 2,
  distribute_shapes: 3,
  stack_shapes: 2,
  pack_shapes: 2,
}

// nudgeShapes reads each shape without a null check, so one stale id would throw mid-batch.
// Filter first, and refuse a call that would move nothing rather than report a silent success.
function existingIds(editor: Editor, ids: string[]): TLShapeId[] {
  // Deduplicate: the same id twice would be counted twice and, for a move, applied twice.
  const found = [...new Set(ids ?? [])].filter((id) => editor.getShape(id as TLShapeId)) as TLShapeId[]
  if (found.length === 0) throw new Error('no shapes found for ids: ' + (ids ?? []).join(', '))
  return found
}

export async function runTool(editor: Editor, tool: string, params: any, agent?: string) {
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
      // shapeIds so the batch tools can act on a frame's contents: they take explicit ids, and
      // this is the cheap text-only way to get them — read_frame would cost a raster.
      const childIds = editor.getSortedChildIdsForParent(s.id)
      return {
        id: s.id,
        name: s.props.name,
        x: b?.x,
        y: b?.y,
        w: b?.w,
        h: b?.h,
        shapeCount: childIds.length,
        shapeIds: childIds,
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
    const strays = straysOver(editor, frame)
    const issues = findIssues(children.map((s) => checkShape(editor, s)), bindings, editor.getShapePageBounds(frame))
    if (children.length === 0) return { url: null, width: 0, height: 0, shapes: [], bindings: [], frameId: frame.id, strays, issues }
    // Every child can render to nothing — all of them clipped outside the frame — and toImage
    // throws on a zero-area region. That is precisely when the issues matter most, so lose the
    // picture rather than the whole payload.
    let url: string | null = null
    let width = 0
    let height = 0
    try {
      const img = await editor.toImage(children, { format: 'png', background: true })
      width = img.width
      height = img.height
      url = await blobToDataUrl(img.blob)
    } catch {}
    return { url, width, height, shapes: children.map((s) => shapeSnapshot(editor, s)), bindings, frameId: frame.id, strays, issues }
  }
  if (tool === 'create_shape') {
    const { type, x, y, text } = params
    const id = createShapeId()
    if (type === 'text') {
      editor.createShape({
        id, type: 'text', x, y,
        props: { richText: toRichText(text ?? ''), font: 'sans', ...(color ? { color } : {}) },
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
          font: 'sans',
          dash: 'solid',
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
      props: { points: pointsDict, scale: 1, dash: 'solid', ...(color ? { color } : {}) },
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
      props: { richText: toRichText(text), font: 'sans', ...(color ? { color } : {}) },
    })
    return { id }
  }
  if (tool === 'update_shape') {
    const { id, x, y, w, h, text, color, fill, parent } = params
    const shape = editor.getShape(id)
    if (!shape) throw new Error('shape not found: ' + id)
    // Deliberately no growY reset anywhere below, though an explicit resize looks like the moment
    // for one. tldraw grows a box to fit a label and recomputes that only when the text changes,
    // so clearing growY hands back an exact height while cropping the label out of sight — and
    // disarms the text-overflow check for that shape for good, since nothing will ever set it
    // again. A grown box therefore measures h + growY, and only a shorter label brings it down.
    const size: Record<string, unknown> = {}
    if (w !== undefined) size.w = w
    if (h !== undefined) size.h = h
    const props: Record<string, unknown> = {}
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
    editor.run(() => {
      // Size first, in its own update: tldraw measures a new label against the height the shape
      // had when the update arrived, so resizing and relabelling together leaves a leftover
      // growY from the old height — a text-overflow the caller cannot clear, because the label
      // already fits the size they asked for.
      if (Object.keys(size).length > 0) editor.updateShape({ id, type: shape.type, props: size })
      editor.updateShape({
        id,
        type: shape.type,
        ...(local ? { x: local.x, y: local.y } : {}),
        props,
      })
      // tldraw re-measures a label only when the text itself changes — and it compares for
      // equality, so re-sending the same string does nothing either. A resize therefore leaves
      // the old growth behind: narrow a box and the label is cropped while text-overflow still
      // reports the shortfall measured at the old width. Write a marker into the text and take it
      // straight back out, inside this same transaction so nothing intermediate is ever drawn,
      // and the label ends up measured against the size that was actually asked for.
      if (shape.type === 'geo' && Object.keys(size).length > 0) {
        const label = text ?? editor.getShapeUtil(shape).getText(shape) ?? ''
        if (label !== '') {
          editor.updateShape({ id, type: shape.type, props: { richText: toRichText(label + '\u200B') } })
          editor.updateShape({ id, type: shape.type, props: { richText: toRichText(label) } })
        }
      }
      // Reparent last: reparentShapes rewrites x/y to keep the page position, so it has to see
      // the position this call just set, not the one it started with.
      if (parent !== undefined) {
        if (parent === 'page') {
          editor.reparentShapes([id], editor.getCurrentPageId())
        } else {
          const target = findFrame(editor, parent)
          if (!target) throw new Error('frame not found: ' + parent)
          editor.reparentShapes([id], target.id)
        }
      }
    })
    return { id }
  }
  if (tool === 'delete_shape') {
    const { ids } = params
    const existing = [...new Set<string>(ids)].filter((id) => editor.getShape(id as TLShapeId)) as TLShapeId[]
    // Count what actually left the page, not how many ids were handed in: deleting a frame takes
    // its children with it, so the two numbers are rarely the same.
    const before = editor.getCurrentPageShapes().length
    editor.deleteShapes(existing)
    return { deleted: before - editor.getCurrentPageShapes().length }
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
    const existing = [...new Set<string>(ids)].filter((id) => editor.getShape(id as TLShapeId)) as TLShapeId[]
    editor.select(...existing)
    return { selected: editor.getSelectedShapeIds().length }
  }
  if (tool === 'create_page') {
    const { name } = params
    const id = PageRecordType.createId()
    editor.createPage({ id, name })
    // createPage is a silent no-op once the board is at tldraw's page cap, which would otherwise
    // hand back an id for a page that does not exist — and switch_page would then fail with
    // "page not found" for something this tool just reported creating.
    if (!editor.getPage(id)) {
      throw new Error('page not created: the board is at tldraw\'s limit of ' + editor.options.maxPages + ' pages — delete one in the browser first')
    }
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
    let strays: ReturnType<typeof straysOver> = []
    if (target === 'frame') {
      const frame = findFrame(editor, name)
      if (!frame) throw new Error('frame not found: ' + name)
      shapes = [frame]
      strays = straysOver(editor, frame)
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
      return { svg: r.svg, width: r.width, height: r.height, strays }
    }
    const { blob, width, height } = await editor.toImage(shapes, { format, background: true })
    const url = await blobToDataUrl(blob)
    return { url, width, height, strays }
  }
  if (tool === 'create_graph') {
    const { nodes, edges, layout = 'tree', frame, x = 100, y = 100 } = params
    // Node keys index everything downstream — the positions map, the id map the caller gets back,
    // and the issue check. A missing or repeated key silently collapses several nodes into one
    // entry: they are all drawn, stacked on the same spot, and the check only ever sees the last.
    const keys = new Set<string>()
    for (const node of nodes) {
      if (typeof node?.key !== 'string' || node.key === '') throw new Error('every node needs a key')
      if (keys.has(node.key)) throw new Error('duplicate node key: ' + node.key)
      keys.add(node.key)
    }
    const positions = graphPositions(nodes, edges, layout, x, y)

    const ids: Record<string, TLShapeId> = {}
    const arrowIds: string[] = []
    let frameId: TLShapeId | undefined
    editor.run(() => {
      if (frame && positions.size > 0) {
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const { px, py } of positions.values()) {
          minX = Math.min(minX, px)
          minY = Math.min(minY, py)
          maxX = Math.max(maxX, px + NODE_W)
          maxY = Math.max(maxY, py + NODE_H)
        }
        const pad = 40
        frameId = createShapeId()
        editor.createShape({
          id: frameId,
          type: 'frame',
          x: minX - pad,
          y: minY - pad,
          props: { w: maxX - minX + pad * 2, h: maxY - minY + pad * 2, name: frame },
        })
      }

      for (const node of nodes) {
        const { px, py } = positions.get(node.key)!
        ids[node.key] = createGeoNode(editor, node.shape ?? 'rectangle', px, py, node.text, NODE_W, NODE_H, color)
      }

      for (const edge of edges) {
        // hasOwn, not `in`: 'toString' and friends are on every object's prototype and would
        // sail past this check straight into a confusing shape-not-found from tldraw.
        if (!Object.hasOwn(ids, edge.from)) throw new Error('unknown node key in edge: ' + edge.from)
        if (!Object.hasOwn(ids, edge.to)) throw new Error('unknown node key in edge: ' + edge.to)
        arrowIds.push(bindArrow(editor, ids[edge.from], ids[edge.to], edge.text, color))
      }

      // The frame above was sized from the layout, which assumes every node is NODE_H tall. A
      // node whose label did not fit is taller than that by the time it exists, and a frame
      // clips its children — so it would hang out of the bottom of its own frame and simply not
      // render. Re-fit to what was actually drawn. Measured from the frame's own origin so the
      // frame never moves, which would drag every child along with it.
      if (frameId) {
        const fb = editor.getShapePageBounds(frameId)!
        const drawn = [...Object.values(ids), ...arrowIds]
          .map((id) => editor.getShapePageBounds(id as TLShapeId))
          .filter((b) => b != null)
        const pad = 40
        const w = Math.max(fb.w, ...drawn.map((b) => b!.x + b!.w - fb.x + pad))
        const h = Math.max(fb.h, ...drawn.map((b) => b!.y + b!.h - fb.y + pad))
        if (w !== fb.w || h !== fb.h) editor.updateShape({ id: frameId, type: 'frame', props: { w, h } })
      }
    })

    // Check what was just drawn: a label too long for its node grows the box (see checks.ts),
    // and the caller should learn that without spending a read_frame round trip to find out.
    const issues = findIssues(Object.values(ids).map((id) => checkShape(editor, editor.getShape(id)!)))
    return { ids, arrowIds, ...(issues.length ? { issues } : {}) }
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
      nodeId = createGeoNode(editor, shape, nx, ny, text, NODE_W, NODE_H, color)
      arrowId = bindArrow(editor, fromId, nodeId, undefined, color)
    })
    return { nodeId, arrowId }
  }
  // hasOwn, not `in`: `in` walks the prototype chain, so 'constructor', 'toString' and friends
  // would match here and be called as if they were ops — returning a fake success instead of
  // falling through to the unknown-tool throw at the bottom.
  if (Object.hasOwn(BATCH_OPS, tool)) {
    let ids = existingIds(editor, params.ids)
    // tldraw moves a frame's children along with the frame, so a list holding both — which is
    // exactly what list_frames' `id` and `shapeIds` invite — would move every child twice and
    // quietly stretch the diagram apart inside its own frame.
    const listed = ids
    ids = ids.filter((id) => !listed.some((other) => other !== id && editor.hasAncestor(id, other)))
    if (Object.hasOwn(CLUSTERING_MIN, tool)) {
      const min = CLUSTERING_MIN[tool]
      ids = ids.filter((id) => {
        const s = editor.getShape(id)!
        if (s.type !== 'arrow') return true
        // Only a BOUND arrow does the clustering. One left loose — its endpoints deleted, or a
        // human's stray stroke — is an ordinary shape to tldraw and lays out fine.
        const bound = getArrowBindings(editor, s as Extract<TLShape, { type: 'arrow' }>)
        return !bound.start && !bound.end
      })
      // Throw rather than let tldraw return early in silence: a no-op that reports a count is
      // indistinguishable from work done, and the caller has no other way to find out.
      if (ids.length < min) {
        throw new Error(tool + ' needs at least ' + min + ' shapes it can lay out — bound arrows follow their endpoints and are skipped — got ' + ids.length)
      }
    }
    editor.run(() => BATCH_OPS[tool](editor, ids, params))
    return { count: ids.length }
  }
  if (tool === 'place_shape') {
    const { id, relativeTo, side, gap = 40, align = 'center' } = params
    const shape = editor.getShape(id)
    if (!shape) throw new Error('shape not found: ' + id)
    const anchor = editor.getShapePageBounds(relativeTo)
    if (!anchor) throw new Error('shape not found: ' + relativeTo)
    // A bound arrow's position comes from its bindings, not its x/y — tldraw drags it straight
    // back to the shapes it connects, so placing one reports a position it never reached. Say so
    // instead. An arrow left loose (its target deleted) has no bindings and places fine.
    if (shape.type === 'arrow') {
      const bound = getArrowBindings(editor, shape as Extract<TLShape, { type: 'arrow' }>)
      if (bound.start || bound.end) {
        throw new Error('bound arrow follows the shapes it connects — place those instead: ' + id)
      }
    }
    const b = editor.getShapePageBounds(shape)!
    // The dispatcher validates this against the published enum; this is the backstop, because
    // an unrecognised side would otherwise fall through to the left branch and move the shape
    // somewhere nobody asked for.
    const vertical = side === 'above' || side === 'below'
    if (!vertical && side !== 'left' && side !== 'right') throw new Error('unknown side: ' + side)
    // The gap is between the two bounding boxes, so the shape's near edge lands `gap` from the
    // anchor's; on the other axis the two are lined up according to `align`.
    const lineUp = (start: number, extent: number, own: number) =>
      align === 'start' ? start : align === 'end' ? start + extent - own : start + (extent - own) / 2
    const x = vertical
      ? lineUp(anchor.x, anchor.w, b.w)
      : side === 'right'
        ? anchor.x + anchor.w + gap
        : anchor.x - gap - b.w
    const y = vertical
      ? side === 'below'
        ? anchor.y + anchor.h + gap
        : anchor.y - gap - b.h
      : lineUp(anchor.y, anchor.h, b.h)
    // Move by the delta rather than writing the target into x/y: a shape's own origin is not
    // its page-bounds top-left for arrows, rotated shapes or draw strokes, so assigning the
    // target directly would land them somewhere other than the position this call reports.
    // nudgeShapes also does the page-space to parent-local conversion for a frame's children.
    editor.nudgeShapes([id], { x: x - b.x, y: y - b.y })
    return { id, x, y }
  }
  if (tool === 'list_agents') {
    return Array.from(agentColors, ([agent, color]) => ({ agent, color }))
  }
  throw new Error(`unknown tool: ${tool}`)
}
