import { Tldraw, type Editor, type TLShape, toRichText, createShapeId, getArrowBindings } from 'tldraw'
import 'tldraw/tldraw.css'
import { createRoot } from 'react-dom/client'

const RELAY_URL = 'ws://localhost:9910/?role=browser'

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

async function runTool(editor: Editor, tool: string, params: any) {
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
    const shapes = editor.getCurrentPageShapes()
    return getFrames(editor).map((s) => {
      const b = editor.getShapePageBounds(s)
      return {
        id: s.id,
        name: s.props.name,
        x: b?.x,
        y: b?.y,
        w: b?.w,
        h: b?.h,
        shapeCount: shapes.filter((c) => c.parentId === s.id).length,
      }
    })
  }
  if (tool === 'read_frame') {
    const frame = findFrame(editor, params.name)
    if (!frame) throw new Error('frame not found: ' + params.name)
    const children = editor.getCurrentPageShapes().filter((s) => s.parentId === frame.id)
    const bindings = children
      .filter((s): s is Extract<TLShape, { type: 'arrow' }> => s.type === 'arrow')
      .map((arrow) => {
        const b = getArrowBindings(editor, arrow)
        return { arrowId: arrow.id, start: b.start?.toId ?? null, end: b.end?.toId ?? null }
      })
    if (children.length === 0) return { url: null, width: 0, height: 0, shapes: [], bindings: [] }
    const { blob, width, height } = await editor.toImage(children, { format: 'png', background: true })
    const url = await blobToDataUrl(blob)
    return { url, width, height, shapes: children.map((s) => shapeSnapshot(editor, s)), bindings }
  }
  if (tool === 'create_shape') {
    const { type, x, y, text } = params
    const id = createShapeId()
    if (type === 'text') {
      editor.createShape({ id, type: 'text', x, y, props: { richText: toRichText(text ?? '') } })
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
        },
      })
    }
    return { id }
  }
  if (tool === 'create_arrow') {
    const { fromId, toId, text } = params
    const arrowId = createShapeId()
    const start = editor.getShapePageBounds(fromId)
    editor.createShape({
      id: arrowId,
      type: 'arrow',
      x: start?.x ?? 0,
      y: start?.y ?? 0,
      props: text ? { text } : {},
    })
    editor.createBinding({
      type: 'arrow',
      fromId: arrowId,
      toId: fromId,
      props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false, isExact: false },
    })
    editor.createBinding({
      type: 'arrow',
      fromId: arrowId,
      toId: toId,
      props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false, isExact: false },
    })
    return { id: arrowId }
  }
  if (tool === 'create_note') {
    const { x, y, text } = params
    const id = createShapeId()
    editor.createShape({ id, type: 'note', x, y, props: { richText: toRichText(text) } })
    return { id }
  }
  throw new Error(`unknown tool: ${tool}`)
}

function connectRelay(editor: Editor) {
  const ws = new WebSocket(RELAY_URL)
  ws.onmessage = async (e) => {
    const { requestId, tool, params } = JSON.parse(e.data as string)
    try {
      const result = await runTool(editor, tool, params)
      ws.send(JSON.stringify({ requestId, ok: true, result }))
    } catch (err: any) {
      ws.send(JSON.stringify({ requestId, ok: false, error: String(err?.message ?? err) }))
    }
  }
  ws.onclose = () => setTimeout(() => connectRelay(editor), 1000)
}

function App() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw persistenceKey="endgame-canvas" onMount={connectRelay} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
