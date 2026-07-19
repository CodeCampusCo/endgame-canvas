import { createCanvasClient, createDispatcher } from '../src/server'

const client = createCanvasClient('ws://localhost:9910/?role=mcp')
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
