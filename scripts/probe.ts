import { createCanvasClient } from '../src/server'

const client = createCanvasClient('ws://localhost:9910/?role=mcp')
const cmd = process.argv[2] ?? 'get_snapshot'

if (cmd === 'create') {
  console.log(await client.call('create_shape', { type: 'rectangle', x: 100, y: 100, text: 'probe' }))
} else if (cmd === 'read') {
  const r: any = await client.call('read_canvas', {})
  console.log(r.empty ? 'empty' : `png ${r.width}x${r.height}, dataUrl length ${r.url.length}`)
} else {
  console.log(JSON.stringify(await client.call('get_snapshot', {}), null, 2))
}
client.close()
