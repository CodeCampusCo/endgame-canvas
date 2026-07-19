import { expect, test } from 'bun:test'
import { startRelay } from './relay'

function connect(port: number, role: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/?role=${role}`)
  return new Promise((res) => { ws.onopen = () => res(ws) })
}
function nextMsg(ws: WebSocket): Promise<any> {
  return new Promise((res) => { ws.onmessage = (e) => res(JSON.parse(e.data as string)) })
}

test('mcp request with no browser connected → immediate error', async () => {
  const s = startRelay(0)
  const mcp = await connect(s.port!, 'mcp')
  const p = nextMsg(mcp)
  mcp.send(JSON.stringify({ requestId: 'r1', tool: 'read_canvas' }))
  expect(await p).toEqual({
    requestId: 'r1', ok: false,
    error: 'no browser connected — open the canvas tab',
  })
  mcp.close(); s.stop()
})

test('response routes to the calling mcp client only (never broadcast)', async () => {
  const s = startRelay(0)
  const browser = await connect(s.port!, 'browser')
  const mcpA = await connect(s.port!, 'mcp')
  const mcpB = await connect(s.port!, 'mcp')
  browser.onmessage = (e) => {
    const req = JSON.parse(e.data as string)
    browser.send(JSON.stringify({ requestId: req.requestId, ok: true, result: { got: req.tool } }))
  }
  let bGot = false
  mcpB.onmessage = () => { bGot = true }
  const pA = nextMsg(mcpA)
  mcpA.send(JSON.stringify({ requestId: 'r2', tool: 'get_snapshot' }))
  expect(await pA).toEqual({ requestId: 'r2', ok: true, result: { got: 'get_snapshot' } })
  await new Promise((r) => setTimeout(r, 50))
  expect(bGot).toBe(false)
  browser.close(); mcpA.close(); mcpB.close(); s.stop()
})
