import { resolve } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export function createCanvasClient(relayUrl: string, opts: { timeoutMs?: number; backoffMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? 10000
  const initialBackoff = opts.backoffMs ?? 500
  const pending = new Map<string, Pending>()

  let ws: WebSocket
  let ready: Promise<void>
  let openGate!: () => void
  let failGate!: (e: Error) => void
  let closed = false
  let backoff = initialBackoff
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  // One gate per connection attempt: pending while disconnected, resolved by that
  // attempt's onopen, rejected by its onerror. A call made during an outage awaits
  // the pending gate and is sent on the reconnected socket — never into a dead one.
  function newGate() {
    ready = new Promise<void>((resolve, reject) => { openGate = resolve; failGate = reject })
    ready.catch(() => {}) // avoid unhandled-rejection noise when no call is in flight
  }

  function connect() {
    if (closed) return
    retryTimer = null
    ws = new WebSocket(relayUrl)
    const resolveThis = openGate // this attempt owns the gate current at connect time
    const rejectThis = failGate
    ws.onopen = () => { backoff = initialBackoff; resolveThis() } // reset backoff on a good connection
    ws.onerror = () => rejectThis(new Error('relay connection failed'))

    ws.onmessage = (e) => {
      let msg: any
      try {
        msg = JSON.parse(e.data as string)
      } catch {
        return // ignore a malformed frame
      }
      const p = pending.get(msg.requestId)
      if (!p) return
      pending.delete(msg.requestId)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error))
    }

    ws.onclose = () => {
      if (closed) return // deliberate close() — do not reconnect
      // The socket dropped (relay restart). Fail every in-flight call, then retry with backoff.
      for (const [, p] of pending) {
        clearTimeout(p.timer)
        p.reject(new Error('relay disconnected'))
      }
      pending.clear()
      // Install a FRESH pending gate before retrying, so calls made during the
      // backoff window wait for the new socket instead of firing into the dead one
      // (a send on a CLOSED socket does not throw — it is silently discarded).
      newGate()
      retryTimer = setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 5000)
    }
  }
  newGate()
  connect()

  async function call(tool: string, params?: unknown) {
    if (closed) throw new Error('client closed')
    const requestId = crypto.randomUUID()
    let timer!: ReturnType<typeof setTimeout>
    // The timer starts BEFORE the ready wait, so timeoutMs bounds the whole
    // operation — a pending gate can never mean an unbounded hang.
    const result = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error('canvas timeout'))
      }, timeoutMs)
      pending.set(requestId, { resolve, reject, timer })
    })
    result.catch(() => {}) // it can be rejected (drop/close) before we return it — keep that handled
    const abandon = () => { pending.delete(requestId); clearTimeout(timer) }

    try {
      await ready // pending during an outage: the call is held until the reconnect opens
    } catch (e: any) {
      abandon()
      throw e instanceof Error ? e : new Error('relay connection failed')
    }
    // The timer runs independently of the gate wait, so the caller may have already
    // timed out (or been closed) while we were parked here. Sending now would replay
    // an abandoned request onto the reconnected socket — a duplicate canvas write.
    if (!pending.has(requestId)) return result // already rejected; preserve that rejection
    try {
      ws.send(JSON.stringify({ requestId, tool, params }))
    } catch {
      abandon()
      throw new Error('relay send failed')
    }
    return result
  }

  function close() {
    if (closed) return
    closed = true
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    // Deliberate close: fail in-flight calls now instead of letting them time out.
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new Error('relay disconnected'))
    }
    pending.clear()
    failGate(new Error('client closed')) // settle any pending gate; a no-op if already resolved
    ws.close()
  }

  return { call, close }
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
    description: 'Create a shape on the canvas (rectangle, ellipse, text, or another geo variant).',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [
            'rectangle',
            'ellipse',
            'text',
            'triangle',
            'diamond',
            'star',
            'hexagon',
            'cloud',
            'x-box',
            'check-box',
          ],
        },
        x: { type: 'number' },
        y: { type: 'number' },
        text: { type: 'string' },
      },
      required: ['type', 'x', 'y'],
    },
  },
  {
    name: 'create_line',
    description: 'Create a straight/multi-point line through a sequence of page-coordinate points.',
    inputSchema: {
      type: 'object',
      properties: {
        points: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
        },
      },
      required: ['points'],
    },
  },
  {
    name: 'create_highlight',
    description: 'Create a highlighter stroke through a sequence of page-coordinate points.',
    inputSchema: {
      type: 'object',
      properties: {
        points: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
        },
      },
      required: ['points'],
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
  {
    name: 'update_shape',
    description: 'Edit an existing shape — move, resize, relabel, or recolour it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
        text: { type: 'string' },
        color: { type: 'string' },
        fill: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_shape',
    description: 'Delete one or more shapes by id.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['ids'],
    },
  },
  {
    name: 'zoom_to_frame',
    description: 'Move the camera to a named frame — point the shared view at it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Frame name, or a shape:... id to disambiguate.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'select',
    description: 'Select shapes by id, highlighting them on the canvas — point back at specific shapes.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['ids'],
    },
  },
  {
    name: 'create_page',
    description: 'Create a new page on the canvas — a separate board/topic with its own shapes.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'list_pages',
    description: 'List every page on the canvas with id, name, and whether it is the current page.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'switch_page',
    description: 'Switch the current page — re-scopes read tools (get_snapshot, read_canvas, list_frames, read_frame) to it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Page name, or a page:... id to disambiguate.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_graph',
    description:
      'Build a node-and-edge diagram in one step: lay out nodes (tree or grid), create each as a shape, and connect edges with bound arrows. Optionally wrap it all in a named frame. Works for any graph — flowchart, org chart, dependency graph, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: 'Node list — key is the id used by edges, not the resulting shape id.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              text: { type: 'string' },
              shape: { type: 'string', description: 'Geo type, default rectangle.' },
            },
            required: ['key', 'text'],
          },
        },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'Source node key.' },
              to: { type: 'string', description: 'Target node key.' },
              text: { type: 'string', description: 'Optional label on the arrow.' },
            },
            required: ['from', 'to'],
          },
        },
        layout: { type: 'string', enum: ['tree', 'grid'], description: "Default 'tree'." },
        frame: { type: 'string', description: 'Optional frame name to wrap the graph in.' },
        x: { type: 'number', description: 'Layout origin x, default 100.' },
        y: { type: 'number', description: 'Layout origin y, default 100.' },
      },
      required: ['nodes', 'edges'],
    },
  },
  {
    name: 'create_connected',
    description: 'Create a new node next to an existing shape and connect it with a bound arrow — connect a new node to an existing shape.',
    inputSchema: {
      type: 'object',
      properties: {
        fromId: { type: 'string', description: 'Shape id to extend from.' },
        text: { type: 'string' },
        shape: { type: 'string', description: 'Geo type, default rectangle.' },
        direction: { type: 'string', enum: ['right', 'down'], description: "Default 'right'." },
      },
      required: ['fromId', 'text'],
    },
  },
  {
    name: 'list_agents',
    description: "List every agent the browser has seen since the page loaded, with each agent's assigned colour.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'export_image',
    description:
      'Export the whole canvas, a named frame, or the current selection to a PNG or SVG file on disk — for embedding diagrams into documents.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['canvas', 'frame', 'selection'] },
        format: { type: 'string', enum: ['png', 'svg'] },
        path: { type: 'string', description: 'File path to write to (resolved against the server process cwd).' },
        name: { type: 'string', description: 'Frame name — required only when target is frame.' },
      },
      required: ['target', 'format', 'path'],
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
    async create_line(args) {
      return asText(JSON.stringify(await call('create_line', args)))
    },
    async create_highlight(args) {
      return asText(JSON.stringify(await call('create_highlight', args)))
    },
    async create_frame(args) {
      return asText(JSON.stringify(await call('create_frame', args)))
    },
    async list_frames() {
      return asText(JSON.stringify(await call('list_frames', {}), null, 2))
    },
    async read_frame(args) {
      const r = await call('read_frame', args)
      const text: ToolContent = { type: 'text', text: JSON.stringify({ shapes: r.shapes, bindings: r.bindings, frameId: r.frameId }, null, 2) }
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
    async update_shape(args) {
      return asText(JSON.stringify(await call('update_shape', args)))
    },
    async delete_shape(args) {
      return asText(JSON.stringify(await call('delete_shape', args)))
    },
    async zoom_to_frame(args) {
      return asText(JSON.stringify(await call('zoom_to_frame', args)))
    },
    async select(args) {
      return asText(JSON.stringify(await call('select', args)))
    },
    async create_page(args) {
      return asText(JSON.stringify(await call('create_page', args)))
    },
    async list_pages() {
      return asText(JSON.stringify(await call('list_pages', {}), null, 2))
    },
    async switch_page(args) {
      return asText(JSON.stringify(await call('switch_page', args)))
    },
    async create_graph(args) {
      return asText(JSON.stringify(await call('create_graph', args)))
    },
    async create_connected(args) {
      return asText(JSON.stringify(await call('create_connected', args)))
    },
    async list_agents() {
      return asText(JSON.stringify(await call('list_agents', {}), null, 2))
    },
    async export_image(args) {
      const { target, format, path, name } = args
      const resolved = resolve(path)
      if (!resolved.startsWith(process.cwd() + '/')) {
        throw new Error(`path must be inside the server working directory: ${path}`)
      }
      const r = await call('export_image', { target, name, format })
      if (typeof r.svg === 'string') await Bun.write(resolved, r.svg)
      else await Bun.write(resolved, Buffer.from(String(r.url).split(',')[1], 'base64'))
      return asText(JSON.stringify({ path: resolved, width: r.width, height: r.height }))
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
  // Optional agent identity: unset → connect exactly as before (no `agent` param).
  const agent = process.env.CANVAS_AGENT
  const relayUrl = agent
    ? `ws://localhost:9910/?role=mcp&agent=${encodeURIComponent(agent)}`
    : 'ws://localhost:9910/?role=mcp'
  const client = createCanvasClient(relayUrl)
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
