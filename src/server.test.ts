import { expect, test } from 'bun:test'
import { startRelay } from './relay'
import { createCanvasClient } from './server'

function fakeBrowser(port: number, handler: (req: any) => any): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/?role=browser`)
  return new Promise((res) => {
    ws.onopen = () => res(ws)
    ws.onmessage = (e) => {
      const req = JSON.parse(e.data as string)
      const out = handler(req)
      if (out !== undefined) ws.send(JSON.stringify({ requestId: req.requestId, ...out }))
    }
  })
}

test('call round-trips through relay to the browser', async () => {
  const s = startRelay(0)
  const browser = await fakeBrowser(s.port, (req) => ({ ok: true, result: { echoed: req.tool } }))
  const client = createCanvasClient(`ws://localhost:${s.port}/?role=mcp`)
  expect(await client.call('get_snapshot', {})).toEqual({ echoed: 'get_snapshot' })
  client.close(); browser.close(); s.stop()
})

test('no browser → rejects with relay error', async () => {
  const s = startRelay(0)
  const client = createCanvasClient(`ws://localhost:${s.port}/?role=mcp`)
  await expect(client.call('read_canvas', {})).rejects.toThrow('no browser connected')
  client.close(); s.stop()
})

test('silent browser → canvas timeout', async () => {
  const s = startRelay(0)
  const browser = await fakeBrowser(s.port, () => undefined) // never replies
  const client = createCanvasClient(`ws://localhost:${s.port}/?role=mcp`, { timeoutMs: 100 })
  await expect(client.call('read_canvas', {})).rejects.toThrow('canvas timeout')
  client.close(); browser.close(); s.stop()
})

test('relay unreachable → call rejects, does not hang', async () => {
  // 127.0.0.1:1 — nothing listens; connection fails
  const client = createCanvasClient('ws://127.0.0.1:1/?role=mcp', { timeoutMs: 2000 })
  await expect(client.call('read_canvas', {})).rejects.toThrow()
  client.close()
})
