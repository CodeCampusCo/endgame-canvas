import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export function createCanvasClient(relayUrl: string, opts: { timeoutMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? 10000
  const pending = new Map<string, Pending>()
  const ws = new WebSocket(relayUrl)
  const ready = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('relay connection failed'))
  })
  ready.catch(() => {}) // avoid unhandled-rejection noise when no call is in flight

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
  {
    name: 'create_frame',
    description: 'Create a named frame on the canvas — the shared reference unit for a region of shapes.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['name', 'x', 'y', 'w', 'h'],
    },
  },
  {
    name: 'list_frames',
    description: 'List every frame on the page with id, name, position, size, and how many shapes it contains.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_frame',
    description:
      "Read one frame's contents: a cropped PNG of its children, their structured shape data, and arrow bindings.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Frame name, or a shape:... id to disambiguate.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_arrow',
    description:
      'Create an arrow bound to two shapes — moving either shape drags the arrow with it.',
    inputSchema: {
      type: 'object',
      properties: {
        fromId: { type: 'string', description: 'Shape id the arrow starts at.' },
        toId: { type: 'string', description: 'Shape id the arrow ends at.' },
        text: { type: 'string', description: 'Optional label on the arrow.' },
      },
      required: ['fromId', 'toId'],
    },
  },
  {
    name: 'create_note',
    description: 'Create a sticky note at a position, for annotation.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        text: { type: 'string' },
      },
      required: ['x', 'y', 'text'],
    },
  },
]

type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
type ToolResult = { content: ToolContent[]; isError?: boolean }
type CanvasCall = (tool: string, params?: unknown) => Promise<any>

const asText = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] })

// One entry per tool — adding a tool means adding a handler here, no branching to touch.
export function createDispatcher(call: CanvasCall) {
  const handlers: Record<string, (args: any) => Promise<ToolResult>> = {
    async read_canvas() {
      const r = await call('read_canvas', {})
      if (r?.empty) return asText('canvas is empty — nothing drawn yet')
      const data = String(r.url).split(',')[1] // strip "data:image/png;base64,"
      return { content: [{ type: 'image', data, mimeType: 'image/png' }] }
    },
    async get_snapshot() {
      return asText(JSON.stringify(await call('get_snapshot', {}), null, 2))
    },
    async create_shape(args) {
      return asText(JSON.stringify(await call('create_shape', args)))
    },
    async create_frame(args) {
      return asText(JSON.stringify(await call('create_frame', args)))
    },
    async list_frames() {
      return asText(JSON.stringify(await call('list_frames', {}), null, 2))
    },
    async read_frame(args) {
      const r = await call('read_frame', args)
      const text: ToolContent = { type: 'text', text: JSON.stringify({ shapes: r.shapes, bindings: r.bindings }, null, 2) }
      if (r.url == null) return { content: [text] }
      const data = String(r.url).split(',')[1] // strip "data:image/png;base64,"
      return { content: [{ type: 'image', data, mimeType: 'image/png' }, text] }
    },
    async create_arrow(args) {
      return asText(JSON.stringify(await call('create_arrow', args)))
    },
    async create_note(args) {
      return asText(JSON.stringify(await call('create_note', args)))
    },
  }

  return async (name: string, args: unknown): Promise<ToolResult> => {
    const handler = handlers[name]
    if (!handler) return { ...asText(`unknown tool: ${name}`), isError: true }
    try {
      return await handler(args ?? {})
    } catch (e: any) {
      return { ...asText(String(e?.message ?? e)), isError: true }
    }
  }
}

if (import.meta.main) {
  const client = createCanvasClient('ws://localhost:9910/?role=mcp')
  const server = new Server(
    { name: 'endgame-canvas', version: '0.0.1' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))

  const dispatch = createDispatcher(client.call)
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    dispatch(req.params.name, req.params.arguments),
  )

  await server.connect(new StdioServerTransport())
  console.error('[server] endgame-canvas MCP ready')
}
