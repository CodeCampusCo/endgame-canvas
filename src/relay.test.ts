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

// --- Item 1: pending eviction on browser close ---

test('browser drops mid-request → caller rejected with "browser disconnected" promptly', async () => {
  const s = startRelay(0)
  const browser = await connect(s.port!, 'browser')
  const mcp = await connect(s.port!, 'mcp')
  // browser gets the request, then vanishes WITHOUT replying
  browser.onmessage = () => browser.close()
  const p = nextMsg(mcp)
  mcp.send(JSON.stringify({ requestId: 'r1', tool: 'read_canvas' }))
  // must arrive fast (eviction), not after a 10s timeout — the whole test is bounded well under a second
  expect(await p).toEqual({ requestId: 'r1', ok: false, error: 'browser disconnected' })
  mcp.close(); s.stop()
})

// --- Item 1: mcp close removes its pending entries; relay stays healthy ---

test('mcp drops mid-request → relay stays healthy, a fresh round-trip still works', async () => {
  const s = startRelay(0)
  let replyNow = false
  const browser = await connect(s.port!, 'browser')
  browser.onmessage = (e) => {
    const req = JSON.parse(e.data as string)
    if (replyNow) browser.send(JSON.stringify({ requestId: req.requestId, ok: true, result: { got: req.tool } }))
  }
  const mcpA = await connect(s.port!, 'mcp')
  mcpA.send(JSON.stringify({ requestId: 'r1', tool: 'read_canvas' })) // browser holds it, never replies
  await new Promise((r) => setTimeout(r, 20))
  mcpA.close() // caller gone mid-request → relay must drop its pending entry
  await new Promise((r) => setTimeout(r, 20))
  replyNow = true
  const mcpB = await connect(s.port!, 'mcp')
  const p = nextMsg(mcpB)
  mcpB.send(JSON.stringify({ requestId: 'r2', tool: 'get_snapshot' }))
  expect(await p).toEqual({ requestId: 'r2', ok: true, result: { got: 'get_snapshot' } })
  browser.close(); mcpB.close(); s.stop()
})

// --- Item 2: newest browser wins, old browser is torn down (no phantom) ---

test('new browser connects → old browser is closed and routing goes to the new one', async () => {
  const s = startRelay(0)
  const browserA = await connect(s.port!, 'browser')
  let aClosed = false
  let aGot = false
  browserA.onclose = () => { aClosed = true }
  browserA.onmessage = () => { aGot = true }
  const browserB = await connect(s.port!, 'browser')
  browserB.onmessage = (e) => {
    const req = JSON.parse(e.data as string)
    browserB.send(JSON.stringify({ requestId: req.requestId, ok: true, result: { via: 'B' } }))
  }
  await new Promise((r) => setTimeout(r, 30))
  expect(aClosed).toBe(true) // old browser was cleanly torn down
  const mcp = await connect(s.port!, 'mcp')
  const p = nextMsg(mcp)
  mcp.send(JSON.stringify({ requestId: 'r1', tool: 'get_snapshot' }))
  expect(await p).toEqual({ requestId: 'r1', ok: true, result: { via: 'B' } })
  expect(aGot).toBe(false) // nothing routed to the phantom
  browserB.close(); mcp.close(); s.stop()
})

test('browser replace evicts the old browser\'s in-flight pending', async () => {
  const s = startRelay(0)
  const browserA = await connect(s.port!, 'browser')
  browserA.onmessage = () => {} // receives but never replies
  const mcp = await connect(s.port!, 'mcp')
  const p = nextMsg(mcp)
  mcp.send(JSON.stringify({ requestId: 'r1', tool: 'read_canvas' }))
  await new Promise((r) => setTimeout(r, 20))
  // a new browser arrives → A becomes a phantom → A's in-flight call must be rejected
  const browserB = await connect(s.port!, 'browser')
  expect(await p).toEqual({ requestId: 'r1', ok: false, error: 'browser disconnected' })
  browserA.close(); browserB.close(); mcp.close(); s.stop()
})

test('adopting a new browser while the old one is closing/gone still evicts its pending', async () => {
  const s = startRelay(0)
  const browserA = await connect(s.port!, 'browser')
  browserA.onmessage = () => {} // receives but never replies
  const mcp = await connect(s.port!, 'mcp')
  const p = nextMsg(mcp)
  mcp.send(JSON.stringify({ requestId: 'r1', tool: 'read_canvas' }))
  await new Promise((r) => setTimeout(r, 20))

  // A vanishes abruptly (no clean close frame) and B is adopted right after: whichever
  // of the two teardown paths runs, r1 must be evicted — never orphaned in the map.
  ;(browserA as any).terminate()
  const browserB = await connect(s.port!, 'browser')
  browserB.onmessage = (e) => {
    const req = JSON.parse(e.data as string)
    browserB.send(JSON.stringify({ requestId: req.requestId, ok: true, result: { via: 'B' } }))
  }
  const t0 = Date.now()
  expect(await p).toEqual({ requestId: 'r1', ok: false, error: 'browser disconnected' })
  expect(Date.now() - t0).toBeLessThan(500) // promptly, not after a client timeout

  // B is fully adopted afterwards
  const p2 = nextMsg(mcp)
  mcp.send(JSON.stringify({ requestId: 'r2', tool: 'get_snapshot' }))
  expect(await p2).toEqual({ requestId: 'r2', ok: true, result: { via: 'B' } })
  browserB.close(); mcp.close(); s.stop()
})

// --- Item 4: malformed frames are ignored, not fatal ---

test('malformed frame is ignored → relay survives, next valid request round-trips', async () => {
  const s = startRelay(0)
  const browser = await connect(s.port!, 'browser')
  browser.onmessage = (e) => {
    const req = JSON.parse(e.data as string)
    browser.send(JSON.stringify({ requestId: req.requestId, ok: true, result: { got: req.tool } }))
  }
  const mcp = await connect(s.port!, 'mcp')
  mcp.send('not json {{{') // must not crash the relay
  await new Promise((r) => setTimeout(r, 20))
  const p = nextMsg(mcp)
  mcp.send(JSON.stringify({ requestId: 'r2', tool: 'get_snapshot' }))
  expect(await p).toEqual({ requestId: 'r2', ok: true, result: { got: 'get_snapshot' } })
  browser.close(); mcp.close(); s.stop()
})

// --- Item 5: Origin allowlist on the WS upgrade ---

test('upgrade with a disallowed Origin → 403, no upgrade', async () => {
  const s = startRelay(0)
  const res = await fetch(`http://localhost:${s.port}/?role=browser`, { headers: { origin: 'http://evil.example' } })
  expect(res.status).toBe(403)
  expect(await res.text()).toBe('forbidden origin')
  s.stop()
})

test('upgrade with an allowlisted Origin → not rejected (426 without WS handshake headers)', async () => {
  const s = startRelay(0)
  const res = await fetch(`http://localhost:${s.port}/?role=browser`, { headers: { origin: 'http://localhost:5173' } })
  expect(res.status).toBe(426) // passed the origin gate; failed only because it is not a real WS handshake
  s.stop()
})

test('no Origin header (non-browser client) → allowed to connect', async () => {
  const s = startRelay(0)
  const mcp = await connect(s.port!, 'mcp') // bun WS client sends no Origin header
  expect(mcp.readyState).toBe(WebSocket.OPEN)
  mcp.close(); s.stop()
})

test('custom allowedOrigins is honored (allow the custom, reject the default)', async () => {
  const s = startRelay(0, { allowedOrigins: ['http://custom.example'] })
  const good = await fetch(`http://localhost:${s.port}/?role=browser`, { headers: { origin: 'http://custom.example' } })
  expect(good.status).toBe(426)
  const bad = await fetch(`http://localhost:${s.port}/?role=browser`, { headers: { origin: 'http://localhost:5173' } })
  expect(bad.status).toBe(403)
  s.stop()
})
