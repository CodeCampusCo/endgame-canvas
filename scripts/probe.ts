import { createCanvasClient } from '../src/server'

const client = createCanvasClient('ws://localhost:9910/?role=mcp')
const cmd = process.argv[2] ?? 'get_snapshot'

if (cmd === 'create') {
  console.log(await client.call('create_shape', { type: 'rectangle', x: 100, y: 100, text: 'probe' }))
} else if (cmd === 'read') {
  const r: any = await client.call('read_canvas', {})
  console.log(r.empty ? 'empty' : `png ${r.width}x${r.height}, dataUrl length ${r.url.length}`)
} else if (cmd === 'create-frame') {
  const name = process.argv[3] ?? 'probe-frame'
  console.log(await client.call('create_frame', { name, x: 100, y: 300, w: 400, h: 300 }))
} else if (cmd === 'list-frames') {
  console.log(JSON.stringify(await client.call('list_frames', {}), null, 2))
} else if (cmd === 'read-frame') {
  const name = process.argv[3] ?? 'probe-frame'
  const r: any = await client.call('read_frame', { name })
  console.log(r.url ? `png ${r.width}x${r.height}, dataUrl length ${r.url.length}` : 'url: null (empty frame)')
  console.log('shapes:', JSON.stringify(r.shapes, null, 2))
  console.log('bindings:', JSON.stringify(r.bindings, null, 2))
} else {
  console.log(JSON.stringify(await client.call('get_snapshot', {}), null, 2))
}
client.close()
