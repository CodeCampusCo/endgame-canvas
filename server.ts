import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export function createCanvasClient(relayUrl: string, opts: { timeoutMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? 10000
  const pending = new Map<string, Pending>()
  const ws = new WebSocket(relayUrl)
  const ready = new Promise<void>((res) => { ws.onopen = () => res() })

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data as string)
    const p = pending.get(msg.requestId)
    if (!p) return
    pending.delete(msg.requestId)
    clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error))
  }

  async function call(tool: string, params?: unknown) {
    await ready
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error('canvas timeout'))
      }, timeoutMs)
      pending.set(requestId, { resolve, reject, timer })
      ws.send(JSON.stringify({ requestId, tool, params }))
    })
  }

  return { call, close: () => ws.close() }
}

const TOOL_DEFS = [
  {
    name: 'read_canvas',
    description:
      'Render the whole canvas (all shapes) to a PNG image. Use this to read freehand pen strokes, scribbled text, which shape a circle encloses, and what an arrow points at.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_snapshot',
    description: 'List every shape on the page with id, type, position, size, and plain text.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_shape',
    description: 'Create a shape on the canvas (rectangle, ellipse, or text).',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['rectangle', 'ellipse', 'text'] },
        x: { type: 'number' },
        y: { type: 'number' },
        text: { type: 'string' },
      },
      required: ['type', 'x', 'y'],
    },
  },
]

if (import.meta.main) {
  const client = createCanvasClient('ws://localhost:9910/?role=mcp')
  const server = new Server(
    { name: 'endgame-canvas', version: '0.0.1' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    try {
      if (name === 'read_canvas') {
        const r: any = await client.call('read_canvas', {})
        if (r?.empty) return { content: [{ type: 'text', text: 'canvas is empty — nothing drawn yet' }] }
        const data = String(r.url).split(',')[1] // strip "data:image/png;base64,"
        return { content: [{ type: 'image', data, mimeType: 'image/png' }] }
      }
      if (name === 'get_snapshot') {
        const r = await client.call('get_snapshot', {})
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
      }
      if (name === 'create_shape') {
        const r = await client.call('create_shape', args)
        return { content: [{ type: 'text', text: JSON.stringify(r) }] }
      }
      return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
    } catch (e: any) {
      return { content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true }
    }
  })

  await server.connect(new StdioServerTransport())
  console.error('[server] endgame-canvas MCP ready')
}
