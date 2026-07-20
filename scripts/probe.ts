import { createCanvasClient, createDispatcher } from '../src/server'

// Optional agent identity: unset → connect exactly as before (no `agent` param).
// Set CANVAS_AGENT to simulate a specific agent's connection (e.g. two probes as
// two different agents, to exercise per-agent attribution colours).
const agent = process.env.CANVAS_AGENT
const relayUrl = agent
  ? `ws://localhost:9910/?role=mcp&agent=${encodeURIComponent(agent)}`
  : 'ws://localhost:9910/?role=mcp'
const client = createCanvasClient(relayUrl)
const cmd = process.argv[2] ?? 'get_snapshot'

// points given as "x,y" pairs, e.g. create-line 400,1350 600,1300 800,1400
function parsePoints(args: string[]) {
  return args.map((pair) => {
    const [x, y] = pair.split(',').map(Number)
    return { x, y }
  })
}

if (cmd === 'create') {
  const type = process.argv[3] ?? 'rectangle'
  const x = Number(process.argv[4] ?? 100)
  const y = Number(process.argv[5] ?? 100)
  const text = process.argv[6] ?? 'probe'
  console.log(await client.call('create_shape', { type, x, y, text }))
} else if (cmd === 'create-line') {
  const points = parsePoints(process.argv.slice(3))
  if (points.length < 2) throw new Error('usage: create-line <x,y> <x,y> [x,y...]')
  console.log(await client.call('create_line', { points }))
} else if (cmd === 'create-highlight') {
  const points = parsePoints(process.argv.slice(3))
  if (points.length < 2) throw new Error('usage: create-highlight <x,y> <x,y> [x,y...]')
  console.log(await client.call('create_highlight', { points }))
} else if (cmd === 'read') {
  const r: any = await client.call('read_canvas', {})
  console.log(r.empty ? 'empty' : `png ${r.width}x${r.height}, dataUrl length ${r.url.length}`)
} else if (cmd === 'create-frame') {
  const name = process.argv[3] ?? 'probe-frame'
  const x = Number(process.argv[4] ?? 100)
  const y = Number(process.argv[5] ?? 300)
  const w = Number(process.argv[6] ?? 400)
  const h = Number(process.argv[7] ?? 300)
  console.log(await client.call('create_frame', { name, x, y, w, h }))
} else if (cmd === 'list-frames') {
  console.log(JSON.stringify(await client.call('list_frames', {}), null, 2))
} else if (cmd === 'read-frame') {
  const name = process.argv[3] ?? 'probe-frame'
  const r: any = await client.call('read_frame', { name })
  console.log(r.url ? `png ${r.width}x${r.height}, dataUrl length ${r.url.length}` : 'url: null (empty frame)')
  console.log('shapes:', JSON.stringify(r.shapes, null, 2))
  console.log('bindings:', JSON.stringify(r.bindings, null, 2))
} else if (cmd === 'create-arrow') {
  const fromId = process.argv[3]
  const toId = process.argv[4]
  const text = process.argv[5]
  if (!fromId || !toId) throw new Error('usage: create-arrow <fromId> <toId> [text]')
  console.log(await client.call('create_arrow', { fromId, toId, text }))
} else if (cmd === 'create-note') {
  const x = Number(process.argv[3] ?? 500)
  const y = Number(process.argv[4] ?? 500)
  const text = process.argv[5] ?? 'hello'
  console.log(await client.call('create_note', { x, y, text }))
} else if (cmd === 'update-shape') {
  const id = process.argv[3]
  if (!id) throw new Error('usage: update-shape <id> [x=..] [y=..] [text=..] [color=..] [fill=..]')
  const params: Record<string, unknown> = { id }
  for (const arg of process.argv.slice(4)) {
    const [key, ...rest] = arg.split('=')
    const value = rest.join('=')
    params[key] = key === 'x' || key === 'y' || key === 'w' || key === 'h' ? Number(value) : value
  }
  console.log(await client.call('update_shape', params))
} else if (cmd === 'delete-shape') {
  const ids = process.argv.slice(3)
  if (ids.length === 0) throw new Error('usage: delete-shape <id...>')
  console.log(await client.call('delete_shape', { ids }))
} else if (cmd === 'zoom-to-frame') {
  const name = process.argv[3]
  if (!name) throw new Error('usage: zoom-to-frame <name>')
  console.log(await client.call('zoom_to_frame', { name }))
} else if (cmd === 'select') {
  const ids = process.argv.slice(3)
  console.log(await client.call('select', { ids }))
} else if (cmd === 'create-page') {
  const name = process.argv[3]
  if (!name) throw new Error('usage: create-page <name>')
  console.log(await client.call('create_page', { name }))
} else if (cmd === 'list-pages') {
  console.log(JSON.stringify(await client.call('list_pages', {}), null, 2))
} else if (cmd === 'switch-page') {
  const name = process.argv[3]
  if (!name) throw new Error('usage: switch-page <name>')
  console.log(await client.call('switch_page', { name }))
} else if (cmd === 'create-flowchart') {
  // Hardcoded sample graph — a JSON arg is awkward on the CLI.
  // A -> B, A -> C, B -> D, C -> D; A rectangle "Start", D ellipse "End".
  const nodes = [
    { key: 'A', text: 'Start' },
    { key: 'B', text: 'Step 1' },
    { key: 'C', text: 'Step 2' },
    { key: 'D', text: 'End', shape: 'ellipse' },
  ]
  const edges = [
    { from: 'A', to: 'B' },
    { from: 'A', to: 'C' },
    { from: 'B', to: 'D' },
    { from: 'C', to: 'D' },
  ]
  const layout = process.argv[3] ?? 'tree'
  const frame = process.argv[4]
  const x = Number(process.argv[5] ?? 200)
  const y = Number(process.argv[6] ?? 2100)
  console.log(await client.call('create_flowchart', { nodes, edges, layout, frame, x, y }))
} else if (cmd === 'create-connected') {
  const fromId = process.argv[3]
  const text = process.argv[4] ?? 'Branch'
  const direction = process.argv[5] ?? 'right'
  if (!fromId) throw new Error('usage: create-connected <fromId> [text] [right|down]')
  console.log(await client.call('create_connected', { fromId, text, direction }))
} else if (cmd === 'list-agents') {
  console.log(JSON.stringify(await client.call('list_agents', {}), null, 2))
} else if (cmd === 'export-image') {
  // usage: export-image <canvas|frame|selection> <png|svg> <path> [frameName]
  // Goes through the same dispatcher the real MCP server uses, so this
  // actually performs the decode + Bun.write, not just the browser round-trip.
  const target = process.argv[3] ?? 'canvas'
  const format = process.argv[4] ?? 'png'
  const path = process.argv[5]
  const name = process.argv[6]
  if (!path) throw new Error('usage: export-image <canvas|frame|selection> <png|svg> <path> [frameName]')
  const dispatch = createDispatcher(client.call)
  console.log(await dispatch('export_image', { target, format, path, name }))
} else {
  console.log(JSON.stringify(await client.call('get_snapshot', {}), null, 2))
}
client.close()
