import { Tldraw, type Editor, toRichText, createShapeId } from 'tldraw'
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
    return editor.getCurrentPageShapes().map((s) => {
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
    })
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
