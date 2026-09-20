import { expect, test } from 'bun:test'
import { mkdir, rm, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startRelay } from './relay'
import { createCanvasClient, createDispatcher, TOOL_DEFS } from './server'

const TEST_DIR = resolve('test-output')
await mkdir(TEST_DIR, { recursive: true })

function tempPath(ext: string) {
  return join(TEST_DIR, `export-image-test-${crypto.randomUUID()}.${ext}`)
}

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

// Like fakeBrowser, but RECORDS every request it is handed — so a test can assert
// that a request the caller abandoned is never delivered to the canvas.
function recordingBrowser(port: number, log: any[]): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/?role=browser`)
  return new Promise((res) => {
    ws.onopen = () => res(ws)
    ws.onmessage = (e) => {
      const req = JSON.parse(e.data as string)
      log.push(req)
      ws.send(JSON.stringify({ requestId: req.requestId, ok: true, result: { echoed: req.tool } }))
    }
  })
}

test('call round-trips through relay to the browser', async () => {
  const s = startRelay(0)
  const browser = await fakeBrowser(s.port!, (req) => ({ ok: true, result: { echoed: req.tool } }))
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
  const browser = await fakeBrowser(s.port!, () => undefined) // never replies
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

test('mcp client reconnects after a relay restart on the same port', async () => {
  const PORT = 19000 + Math.floor(Math.random() * 2000)
  const s1 = startRelay(PORT)
  const browser1 = await fakeBrowser(PORT, (req) => ({ ok: true, result: { echoed: req.tool } }))
  const client = createCanvasClient(`ws://localhost:${PORT}/?role=mcp`, { timeoutMs: 500, backoffMs: 40 })
  expect(await client.call('get_snapshot', {})).toEqual({ echoed: 'get_snapshot' })

  // relay dies (force-close the mcp socket so onclose fires) → client should back off and retry
  browser1.close(); s1.stop(true)
  await new Promise((r) => setTimeout(r, 30))

  // relay comes back on the SAME port with a fresh browser
  const s2 = startRelay(PORT)
  const browser2 = await fakeBrowser(PORT, (req) => ({ ok: true, result: { echoed2: req.tool } }))
  await new Promise((r) => setTimeout(r, 300)) // let a backoff cycle land

  expect(await client.call('read_canvas', {})).toEqual({ echoed2: 'read_canvas' })
  client.close(); browser2.close(); s2.stop()
})

test('call issued while the relay is down succeeds after the client reconnects', async () => {
  const PORT = 23000 + Math.floor(Math.random() * 2000)
  const s1 = startRelay(PORT)
  const browser1 = await fakeBrowser(PORT, (req) => ({ ok: true, result: { echoed: req.tool } }))
  const client = createCanvasClient(`ws://localhost:${PORT}/?role=mcp`, { timeoutMs: 5000, backoffMs: 200 })
  expect(await client.call('get_snapshot', {})).toEqual({ echoed: 'get_snapshot' })

  browser1.close(); s1.stop(true)
  await new Promise((r) => setTimeout(r, 20)) // let onclose install the fresh pending gate

  // issued WHILE DOWN: must be held at the gate, not fired into the closed socket
  const inFlight = client.call('read_canvas', {})

  const s2 = startRelay(PORT)
  const browser2 = await fakeBrowser(PORT, (req) => ({ ok: true, result: { echoed2: req.tool } }))
  expect(await inFlight).toEqual({ echoed2: 'read_canvas' })

  client.close(); browser2.close(); s2.stop()
})

test('client.close() stops reconnection and fails later calls fast', async () => {
  const PORT = 21000 + Math.floor(Math.random() * 2000)
  const s = startRelay(PORT)
  const browser = await fakeBrowser(PORT, (req) => ({ ok: true, result: { echoed: req.tool } }))
  const client = createCanvasClient(`ws://localhost:${PORT}/?role=mcp`, { timeoutMs: 5000, backoffMs: 40 })
  expect(await client.call('get_snapshot', {})).toEqual({ echoed: 'get_snapshot' })
  client.close()
  browser.close(); s.stop(true)

  // a listener on the same port counts any reconnect the closed client attempts
  let attempts = 0
  const probe = Bun.serve({
    port: PORT,
    fetch(req, server) {
      attempts++
      if (server.upgrade(req)) return
      return new Response('websocket only', { status: 426 })
    },
    websocket: { message() {} },
  })
  await new Promise((r) => setTimeout(r, 200)) // ~5 backoff windows
  expect(attempts).toBe(0)

  // and a call after close() rejects immediately — it must not wait out timeoutMs
  const t0 = Date.now()
  await expect(client.call('read_canvas', {})).rejects.toThrow('client closed')
  expect(Date.now() - t0).toBeLessThan(200)

  probe.stop(true)
})

test('close() rejects in-flight calls instead of letting them time out', async () => {
  const s = startRelay(0)
  const browser = await fakeBrowser(s.port!, () => undefined) // never replies
  const client = createCanvasClient(`ws://localhost:${s.port}/?role=mcp`, { timeoutMs: 5000 })
  const inFlight = client.call('read_canvas', {})
  await new Promise((r) => setTimeout(r, 20)) // let it reach the relay
  const t0 = Date.now()
  client.close()
  await expect(inFlight).rejects.toThrow('relay disconnected')
  expect(Date.now() - t0).toBeLessThan(200)
  browser.close(); s.stop()
})

test('a call that timed out at the gate is NOT replayed onto the reconnected socket', async () => {
  const PORT = 25000 + Math.floor(Math.random() * 2000)
  const s1 = startRelay(PORT)
  const seen1: any[] = []
  const browser1 = await recordingBrowser(PORT, seen1)
  // short timeout, long backoff → the timeout fires while the ready gate is still pending
  const client = createCanvasClient(`ws://localhost:${PORT}/?role=mcp`, { timeoutMs: 120, backoffMs: 400 })
  expect(await client.call('get_snapshot', {})).toEqual({ echoed: 'get_snapshot' })

  browser1.close(); s1.stop(true)
  await new Promise((r) => setTimeout(r, 20)) // let onclose install the fresh gate + retry timer

  // issued while down: it parks at the gate and its 120ms timer fires long before
  // the 400ms reconnect, so the caller has abandoned it by the time the gate opens
  const abandoned = client.call('create_shape', { type: 'rectangle', x: 1, y: 2 })

  // relay comes back on the same port with a NEW recording browser, before the retry
  const s2 = startRelay(PORT)
  const seen2: any[] = []
  const browser2 = await recordingBrowser(PORT, seen2)

  await expect(abandoned).rejects.toThrow('canvas timeout')
  await new Promise((r) => setTimeout(r, 600)) // well past the reconnect

  // the abandoned create_shape must never reach the canvas — no duplicate write
  expect(seen2).toEqual([])

  // and the client really did reconnect (otherwise the empty log above is vacuous)
  expect(await client.call('read_canvas', {})).toEqual({ echoed: 'read_canvas' })
  expect(seen2.map((r) => r.tool)).toEqual(['read_canvas'])

  client.close(); browser2.close(); s2.stop()
})

// --- dispatch map: one handler per tool, centralized unknown/error handling ---

test('dispatch read_canvas → image content with data-URL prefix stripped', async () => {
  const dispatch = createDispatcher(async () => ({ url: 'data:image/png;base64,AAAB', width: 10, height: 10 }))
  expect(await dispatch('read_canvas', {})).toEqual({
    content: [{ type: 'image', data: 'AAAB', mimeType: 'image/png' }],
  })
})

test('dispatch read_canvas empty → friendly text', async () => {
  const dispatch = createDispatcher(async () => ({ empty: true }))
  expect(await dispatch('read_canvas', {})).toEqual({
    content: [{ type: 'text', text: 'canvas is empty — nothing drawn yet' }],
  })
})

test('dispatch get_snapshot → pretty JSON text', async () => {
  const shapes = [{ id: 'a', type: 'geo' }]
  const dispatch = createDispatcher(async () => shapes)
  expect(await dispatch('get_snapshot', {})).toEqual({
    content: [{ type: 'text', text: JSON.stringify(shapes, null, 2) }],
  })
})

test('dispatch create_shape → forwards args, returns id as text', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { id: 'shape:xyz' }
  })
  const args = { type: 'rectangle', x: 1, y: 2, text: 'hi' }
  expect(await dispatch('create_shape', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ id: 'shape:xyz' }) }],
  })
  expect(seen).toEqual({ tool: 'create_shape', params: args })
})

test('dispatch unknown tool → isError text, never calls the canvas', async () => {
  let called = false
  const dispatch = createDispatcher(async () => { called = true; return {} })
  expect(await dispatch('nope', {})).toEqual({
    content: [{ type: 'text', text: 'unknown tool: nope' }],
    isError: true,
  })
  expect(called).toBe(false)
})

test('dispatch wraps a thrown canvas error → isError text', async () => {
  const dispatch = createDispatcher(async () => { throw new Error('canvas timeout') })
  expect(await dispatch('read_canvas', {})).toEqual({
    content: [{ type: 'text', text: 'canvas timeout' }],
    isError: true,
  })
})

// --- Phase 1: frame tools ---

test('dispatch create_frame → forwards args, returns id as text', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { id: 'shape:frame1' }
  })
  const args = { name: 'probe-frame', x: 100, y: 300, w: 400, h: 300 }
  expect(await dispatch('create_frame', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ id: 'shape:frame1' }) }],
  })
  expect(seen).toEqual({ tool: 'create_frame', params: args })
})

test('dispatch list_frames → pretty JSON text', async () => {
  const frames = [{ id: 'shape:frame1', name: 'probe-frame', x: 100, y: 300, w: 400, h: 300, shapeCount: 2 }]
  const dispatch = createDispatcher(async () => frames)
  expect(await dispatch('list_frames', {})).toEqual({
    content: [{ type: 'text', text: JSON.stringify(frames, null, 2) }],
  })
})

test('dispatch read_frame with url → image content + shapes/bindings/frameId text', async () => {
  const shapes = [{ id: 'shape:a', type: 'geo', x: 1, y: 2, w: 3, h: 4, text: '' }]
  const bindings = [{ arrowId: 'shape:arrow1', start: 'shape:a', end: null }]
  const frameId = 'shape:frame1'
  const dispatch = createDispatcher(async () => ({
    url: 'data:image/png;base64,AAAB',
    width: 400,
    height: 300,
    shapes,
    bindings,
    frameId,
  }))
  expect(await dispatch('read_frame', { name: 'probe-frame' })).toEqual({
    content: [
      { type: 'image', data: 'AAAB', mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify({ shapes, bindings, frameId }, null, 2) },
    ],
  })
})

test('dispatch read_frame surfaces strays — shapes overlapping the frame that are not its children', async () => {
  const shapes = [{ id: 'shape:a', type: 'geo', x: 1, y: 2, w: 3, h: 4, text: 'in' }]
  const strays = [{ id: 'shape:b', type: 'geo', x: 9, y: 9, w: 3, h: 4, text: 'out' }]
  const dispatch = createDispatcher(async () => ({
    url: 'data:image/png;base64,AAAB',
    width: 400,
    height: 300,
    shapes,
    bindings: [],
    frameId: 'shape:frame1',
    strays,
  }))
  expect(await dispatch('read_frame', { name: 'probe-frame' })).toEqual({
    content: [
      { type: 'image', data: 'AAAB', mimeType: 'image/png' },
      {
        type: 'text',
        text: JSON.stringify({ shapes, bindings: [], frameId: 'shape:frame1', strays }, null, 2),
      },
    ],
  })
})

test('dispatch read_frame omits strays entirely when the frame has none', async () => {
  const dispatch = createDispatcher(async () => ({
    url: null,
    width: 0,
    height: 0,
    shapes: [],
    bindings: [],
    frameId: 'shape:frame1',
    strays: [],
  }))
  const text = (await dispatch('read_frame', { name: 'f' })).content[0] as { text: string }
  expect(JSON.parse(text.text)).toEqual({ shapes: [], bindings: [], frameId: 'shape:frame1' })
})

test('dispatch read_frame with url: null → text-only content, no image part', async () => {
  const dispatch = createDispatcher(async () => ({
    url: null,
    width: 0,
    height: 0,
    shapes: [],
    bindings: [],
    frameId: 'shape:empty-frame',
  }))
  expect(await dispatch('read_frame', { name: 'empty-frame' })).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ shapes: [], bindings: [], frameId: 'shape:empty-frame' }, null, 2) }],
  })
})

// --- Phase 2: bound arrows + sticky notes ---

test('dispatch create_arrow → forwards fromId/toId/text, returns id as text', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { id: 'shape:arrow1' }
  })
  const args = { fromId: 'shape:a', toId: 'shape:b', text: 'flows to' }
  expect(await dispatch('create_arrow', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ id: 'shape:arrow1' }) }],
  })
  expect(seen).toEqual({ tool: 'create_arrow', params: args })
})

test('dispatch create_arrow without text → still forwards fromId/toId, returns id', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { id: 'shape:arrow2' }
  })
  const args = { fromId: 'shape:a', toId: 'shape:b' }
  expect(await dispatch('create_arrow', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ id: 'shape:arrow2' }) }],
  })
  expect(seen).toEqual({ tool: 'create_arrow', params: args })
})

test('dispatch create_note → forwards x/y/text, returns id as text', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { id: 'shape:note1' }
  })
  const args = { x: 100, y: 200, text: 'hello' }
  expect(await dispatch('create_note', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ id: 'shape:note1' }) }],
  })
  expect(seen).toEqual({ tool: 'create_note', params: args })
})

// --- Phase 3: edit / annotate ---

test('dispatch update_shape → forwards a representative subset, returns id as text', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { id: 'shape:a' }
  })
  const args = { id: 'shape:a', x: 100, y: 200, text: 'relabeled', color: 'blue' }
  expect(await dispatch('update_shape', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ id: 'shape:a' }) }],
  })
  expect(seen).toEqual({ tool: 'update_shape', params: args })
})

test('dispatch update_shape forwards parent — the way a stray gets back into its frame', async () => {
  let seen: unknown
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { id: 'shape:a' }
  })
  const args = { id: 'shape:a', parent: 'source map' }
  expect(await dispatch('update_shape', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ id: 'shape:a' }) }],
  })
  expect(seen).toEqual({ tool: 'update_shape', params: args })
})

test('dispatch update_shape with only id + color → forwards just those, returns id as text', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { id: 'shape:a' }
  })
  const args = { id: 'shape:a', color: 'red' }
  expect(await dispatch('update_shape', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ id: 'shape:a' }) }],
  })
  expect(seen).toEqual({ tool: 'update_shape', params: args })
})

test('dispatch update_shape forwards size on its own — restyling text without touching the box', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { id: 'shape:a' }
  })
  const args = { id: 'shape:a', size: 's' }
  expect(await dispatch('update_shape', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ id: 'shape:a' }) }],
  })
  expect(seen).toEqual({ tool: 'update_shape', params: args })
})

test('dispatch delete_shape → forwards ids, returns deleted count as text', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { deleted: 2 }
  })
  const args = { ids: ['shape:a', 'shape:b'] }
  expect(await dispatch('delete_shape', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ deleted: 2 }) }],
  })
  expect(seen).toEqual({ tool: 'delete_shape', params: args })
})

// --- Phase 4: navigate / point back ---

test('dispatch zoom_to_frame → forwards name, returns ok as text', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { ok: true }
  })
  const args = { name: 'probe-frame' }
  expect(await dispatch('zoom_to_frame', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
  })
  expect(seen).toEqual({ tool: 'zoom_to_frame', params: args })
})

test('dispatch select → forwards ids, returns honest selected count as text', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { selected: 2 }
  })
  const args = { ids: ['shape:a', 'shape:b'] }
  expect(await dispatch('select', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ selected: 2 }) }],
  })
  expect(seen).toEqual({ tool: 'select', params: args })
})

// --- Family A: extended draw vocabulary (geo variants, line, highlight) ---

test('dispatch create_shape forwards size — the only type hierarchy a screen mock has', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { id: 'shape:a' }
  })
  const args = { type: 'text', x: 0, y: 0, text: 'Sign in', size: 'xl' }
  expect(await dispatch('create_shape', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ id: 'shape:a' }) }],
  })
  expect(seen).toEqual({ tool: 'create_shape', params: args })
})

test('dispatch create_shape with type: triangle → still forwards correctly', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { id: 'shape:tri1' }
  })
  const args = { type: 'triangle', x: 400, y: 1100 }
  expect(await dispatch('create_shape', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ id: 'shape:tri1' }) }],
  })
  expect(seen).toEqual({ tool: 'create_shape', params: args })
})

test('dispatch create_line → forwards points, returns id as text', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { id: 'shape:line1' }
  })
  const args = { points: [{ x: 400, y: 1350 }, { x: 600, y: 1300 }, { x: 800, y: 1400 }] }
  expect(await dispatch('create_line', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ id: 'shape:line1' }) }],
  })
  expect(seen).toEqual({ tool: 'create_line', params: args })
})

test('dispatch create_highlight → forwards points, returns id as text', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { id: 'shape:hl1' }
  })
  const args = { points: [{ x: 900, y: 1350 }, { x: 1100, y: 1300 }, { x: 1300, y: 1400 }] }
  expect(await dispatch('create_highlight', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ id: 'shape:hl1' }) }],
  })
  expect(seen).toEqual({ tool: 'create_highlight', params: args })
})

// --- Family E: export to file (the handler does real I/O — decode + write) ---

test('dispatch export_image → decodes base64 data URL and writes file to disk', async () => {
  const dispatch = createDispatcher(async () => ({
    url: 'data:image/png;base64,aGVsbG8=', // base64 of "hello"
    width: 10,
    height: 10,
  }))
  const path = tempPath('png')
  try {
    expect(await dispatch('export_image', { target: 'canvas', format: 'png', path })).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ path, width: 10, height: 10 }) }],
    })
    expect(await Bun.file(path).text()).toBe('hello')
  } finally {
    await unlink(path)
  }
})

test('dispatch export_image on a frame reports strays alongside the written path', async () => {
  const strays = [{ id: 'shape:b', type: 'geo', x: 9, y: 9, w: 3, h: 4, text: 'out' }]
  const dispatch = createDispatcher(async () => ({
    url: 'data:image/png;base64,aGVsbG8=',
    width: 10,
    height: 10,
    strays,
  }))
  const path = tempPath('png')
  try {
    expect(await dispatch('export_image', { target: 'frame', name: 'f', format: 'png', path })).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ path, width: 10, height: 10, strays }) }],
    })
  } finally {
    await unlink(path)
  }
})

test('dispatch export_image with svg → round-trips svg text through the same decode path', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
  const dispatch = createDispatcher(async () => ({
    url: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    width: 20,
    height: 30,
  }))
  const path = tempPath('svg')
  try {
    expect(await dispatch('export_image', { target: 'canvas', format: 'svg', path })).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ path, width: 20, height: 30 }) }],
    })
    expect(await Bun.file(path).text()).toBe(svg)
  } finally {
    await unlink(path)
  }
})

test('dispatch export_image with svg → writes the svg text directly, no base64 round trip', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'
  const dispatch = createDispatcher(async () => ({ svg, width: 10, height: 10 }))
  const path = tempPath('svg')
  try {
    expect(await dispatch('export_image', { target: 'canvas', format: 'svg', path })).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ path, width: 10, height: 10 }) }],
    })
    expect(await Bun.file(path).text()).toBe(svg)
  } finally {
    await unlink(path)
  }
})

test('dispatch export_image → forwards target/name/format to the canvas call, path stays server-side', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { url: 'data:image/png;base64,aGVsbG8=', width: 10, height: 10 }
  })
  const path = tempPath('png')
  try {
    await dispatch('export_image', { target: 'frame', name: 'probe-frame', format: 'png', path })
    expect(seen).toEqual({ tool: 'export_image', params: { target: 'frame', name: 'probe-frame', format: 'png' } })
  } finally {
    await unlink(path)
  }
})

test('dispatch export_image → rejects paths outside the server cwd', async () => {
  const dispatch = createDispatcher(async () => ({
    url: 'data:image/png;base64,aGVsbG8=',
    width: 10,
    height: 10,
  }))
  const r = await dispatch('export_image', { target: 'canvas', format: 'png', path: '/etc/passwd' })
  expect(r.isError).toBe(true)
  expect((r.content[0] as { text: string }).text).toInclude('path must be inside the server working directory')
})

test('dispatch export_image → rejects a sibling directory whose name starts with the cwd prefix', async () => {
  const dispatch = createDispatcher(async () => ({
    url: 'data:image/png;base64,aGVsbG8=',
    width: 10,
    height: 10,
  }))
  const r = await dispatch('export_image', { target: 'canvas', format: 'png', path: resolve(process.cwd() + '-evil/file.png') })
  expect(r.isError).toBe(true)
  expect((r.content[0] as { text: string }).text).toInclude('path must be inside the server working directory')
})

test('dispatch export_image → resolves a relative path against cwd', async () => {
  const dispatch = createDispatcher(async () => ({
    url: 'data:image/png;base64,aGVsbG8=',
    width: 10,
    height: 10,
  }))
  const rel = `test-output/rel-test-${crypto.randomUUID()}.png`
  try {
    const r = await dispatch('export_image', { target: 'canvas', format: 'png', path: rel })
    expect(r.isError).toBeUndefined()
    const parsed = JSON.parse((r.content[0] as { text: string }).text)
    expect(parsed.path).toBe(resolve(rel))
  } finally {
    await unlink(rel)
  }
})

// --- Family F: multi-page ---

test('dispatch create_page → forwards name, returns id as text', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { id: 'page:board2' }
  })
  const args = { name: 'Board2' }
  expect(await dispatch('create_page', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ id: 'page:board2' }) }],
  })
  expect(seen).toEqual({ tool: 'create_page', params: args })
})

test('dispatch list_pages → pretty JSON text', async () => {
  const pages = [
    { id: 'page:page', name: 'Page 1', current: true },
    { id: 'page:board2', name: 'Board2', current: false },
  ]
  const dispatch = createDispatcher(async () => pages)
  expect(await dispatch('list_pages', {})).toEqual({
    content: [{ type: 'text', text: JSON.stringify(pages, null, 2) }],
  })
})

test('dispatch switch_page → forwards name, returns ok as text', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { ok: true }
  })
  const args = { name: 'Board2' }
  expect(await dispatch('switch_page', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
  })
  expect(seen).toEqual({ tool: 'switch_page', params: args })
})

// --- Family G: graph tools ---

test('dispatch create_graph → forwards nodes/edges/layout/frame, returns ids+arrowIds as text', async () => {
  let seen: any
  const result = {
    ids: { A: 'shape:a', B: 'shape:b' },
    arrowIds: ['shape:arrow1'],
  }
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return result
  })
  const args = {
    nodes: [{ key: 'A', text: 'Start' }, { key: 'B', text: 'End', shape: 'ellipse' }],
    edges: [{ from: 'A', to: 'B', text: 'flows to' }],
    layout: 'tree',
    frame: 'flow1',
    x: 200,
    y: 2100,
  }
  expect(await dispatch('create_graph', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify(result) }],
  })
  expect(seen).toEqual({ tool: 'create_graph', params: args })
})

test('dispatch create_graph with minimal args → still forwards correctly', async () => {
  let seen: any
  const result = { ids: { A: 'shape:a' }, arrowIds: [] }
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return result
  })
  const args = { nodes: [{ key: 'A', text: 'Solo' }], edges: [] }
  expect(await dispatch('create_graph', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify(result) }],
  })
  expect(seen).toEqual({ tool: 'create_graph', params: args })
})

test('dispatch create_connected → forwards fromId/text/shape/direction, returns nodeId+arrowId as text', async () => {
  let seen: any
  const result = { nodeId: 'shape:new1', arrowId: 'shape:arrow2' }
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return result
  })
  const args = { fromId: 'shape:a', text: 'Branch', shape: 'ellipse', direction: 'down' }
  expect(await dispatch('create_connected', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify(result) }],
  })
  expect(seen).toEqual({ tool: 'create_connected', params: args })
})

test('dispatch create_connected with only fromId/text → still forwards correctly', async () => {
  let seen: any
  const result = { nodeId: 'shape:new2', arrowId: 'shape:arrow3' }
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return result
  })
  const args = { fromId: 'shape:a', text: 'Next' }
  expect(await dispatch('create_connected', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify(result) }],
  })
  expect(seen).toEqual({ tool: 'create_connected', params: args })
})

// --- Milestone 3: per-agent attribution ---

test('dispatch list_agents → pretty JSON text', async () => {
  const agents = [{ agent: 'alice', color: 'blue' }, { agent: 'bob', color: 'green' }]
  const dispatch = createDispatcher(async () => agents)
  expect(await dispatch('list_agents', {})).toEqual({
    content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }],
  })
})

// --- Structural checks: issues ride along with read_frame and create_graph ---

test('dispatch read_frame surfaces issues alongside the shapes', async () => {
  const issues = [
    { kind: 'text-overflow', id: 'shape:a', grewBy: 34 },
    { kind: 'overlap', id: 'shape:a', with: 'shape:b' },
  ]
  const dispatch = createDispatcher(async () => ({
    url: null,
    width: 0,
    height: 0,
    shapes: [],
    bindings: [],
    frameId: 'shape:f1',
    issues,
  }))
  const text = (await dispatch('read_frame', { name: 'f' })).content[0] as { text: string }
  expect(JSON.parse(text.text)).toEqual({ shapes: [], bindings: [], frameId: 'shape:f1', issues })
})

test('dispatch read_frame omits issues entirely when the frame is clean', async () => {
  const dispatch = createDispatcher(async () => ({
    url: null,
    width: 0,
    height: 0,
    shapes: [],
    bindings: [],
    frameId: 'shape:f1',
    issues: [],
    strays: [],
  }))
  const text = (await dispatch('read_frame', { name: 'f' })).content[0] as { text: string }
  expect(JSON.parse(text.text)).toEqual({ shapes: [], bindings: [], frameId: 'shape:f1' })
})

test('dispatch read_frame reports issues and strays together when both are present', async () => {
  const issues = [{ kind: 'unbound-arrow', id: 'shape:arr', missing: ['end'] }]
  const strays = [{ id: 'shape:b', type: 'geo', x: 9, y: 9, w: 3, h: 4, text: 'out' }]
  const dispatch = createDispatcher(async () => ({
    url: null,
    width: 0,
    height: 0,
    shapes: [],
    bindings: [],
    frameId: 'shape:f1',
    issues,
    strays,
  }))
  const text = (await dispatch('read_frame', { name: 'f' })).content[0] as { text: string }
  expect(JSON.parse(text.text)).toEqual({
    shapes: [],
    bindings: [],
    frameId: 'shape:f1',
    issues,
    strays,
  })
})

test('dispatch create_graph passes issues through untouched', async () => {
  const result = {
    ids: { A: 'shape:a' },
    arrowIds: [],
    issues: [{ kind: 'text-overflow', id: 'shape:a', grewBy: 12 }],
  }
  const dispatch = createDispatcher(async () => result)
  expect(await dispatch('create_graph', { nodes: [], edges: [] })).toEqual({
    content: [{ type: 'text', text: JSON.stringify(result) }],
  })
})

// --- Batch layout ops + relative placement ---

const BATCH_CALLS: [string, Record<string, unknown>][] = [
  ['nudge_shapes', { ids: ['shape:a', 'shape:b'], dx: 0, dy: 50 }],
  ['align_shapes', { ids: ['shape:a', 'shape:b'], edge: 'left' }],
  ['distribute_shapes', { ids: ['shape:a', 'shape:b'], axis: 'horizontal' }],
  ['stack_shapes', { ids: ['shape:a', 'shape:b'], axis: 'vertical', gap: 80 }],
  ['pack_shapes', { ids: ['shape:a', 'shape:b'], gap: 32 }],
  ['flip_shapes', { ids: ['shape:a', 'shape:b'], axis: 'horizontal' }],
]

for (const [tool, args] of BATCH_CALLS) {
  test(`dispatch ${tool} → forwards args verbatim, returns the count as text`, async () => {
    let seen: any
    const result = { count: 2 }
    const dispatch = createDispatcher(async (t, params) => {
      seen = { tool: t, params }
      return result
    })
    expect(await dispatch(tool, args)).toEqual({
      content: [{ type: 'text', text: JSON.stringify(result) }],
    })
    expect(seen).toEqual({ tool, params: args })
  })
}

test('dispatch stack_shapes without a gap → forwards without it, browser applies the default', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { count: 3 }
  })
  const args = { ids: ['shape:a', 'shape:b', 'shape:c'], axis: 'vertical' }
  await dispatch('stack_shapes', args)
  expect(seen).toEqual({ tool: 'stack_shapes', params: args })
})

test('dispatch place_shape → forwards id/relativeTo/side/gap/align, returns the page point', async () => {
  let seen: any
  const result = { id: 'shape:a', x: 380, y: 100 }
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return result
  })
  const args = { id: 'shape:a', relativeTo: 'shape:b', side: 'right', gap: 40, align: 'center' }
  expect(await dispatch('place_shape', args)).toEqual({
    content: [{ type: 'text', text: JSON.stringify(result) }],
  })
  expect(seen).toEqual({ tool: 'place_shape', params: args })
})

test('dispatch place_shape with only the required args → gap/align left to the browser default', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => {
    seen = { tool, params }
    return { id: 'shape:a', x: 0, y: 0 }
  })
  const args = { id: 'shape:a', relativeTo: 'shape:b', side: 'below' }
  await dispatch('place_shape', args)
  expect(seen).toEqual({ tool: 'place_shape', params: args })
})

test('every new tool is declared in TOOL_DEFS with a schema that fully describes a valid call', async () => {
  const required = Object.fromEntries(
    TOOL_DEFS.map((t: any) => [t.name, (t.inputSchema.required ?? []).sort()]),
  )
  expect(required.nudge_shapes).toEqual(['dx', 'dy', 'ids'])
  expect(required.align_shapes).toEqual(['edge', 'ids'])
  expect(required.distribute_shapes).toEqual(['axis', 'ids'])
  expect(required.stack_shapes).toEqual(['axis', 'ids'])
  expect(required.pack_shapes).toEqual(['ids'])
  expect(required.flip_shapes).toEqual(['axis', 'ids'])
  expect(required.place_shape).toEqual(['id', 'relativeTo', 'side'])
})

test('every tool declared to the client has a handler — the three-place recipe, enforced', async () => {
  const dispatch = createDispatcher(async () => ({}))
  const unhandled: string[] = []
  for (const { name } of TOOL_DEFS as { name: string }[]) {
    const r = await dispatch(name, {})
    if (r.isError && String((r.content[0] as any).text).startsWith('unknown tool')) unhandled.push(name)
  }
  expect(unhandled).toEqual([])
})

// --- the published schema is enforced, because the MCP SDK does not enforce it ---

test('a missing required argument is refused before the canvas is touched', async () => {
  let called = false
  const dispatch = createDispatcher(async () => { called = true; return {} })
  const r = await dispatch('place_shape', { id: 'shape:a', relativeTo: 'shape:b' })
  expect(r.isError).toBe(true)
  expect((r.content[0] as any).text).toBe('place_shape: missing required argument side')
  expect(called).toBe(false)
})

test('several missing required arguments are named together', async () => {
  const dispatch = createDispatcher(async () => ({}))
  const r = await dispatch('nudge_shapes', { ids: ['shape:a'] })
  expect((r.content[0] as any).text).toBe('nudge_shapes: missing required arguments dx, dy')
})

test('a misspelled enum is refused, naming the values that would have worked', async () => {
  let called = false
  const dispatch = createDispatcher(async () => { called = true; return {} })
  const r = await dispatch('export_image', { target: 'frme', format: 'png', path: 'x.png' })
  expect(r.isError).toBe(true)
  expect((r.content[0] as any).text).toContain('target must be one of canvas, frame, selection')
  expect(called).toBe(false)
})

test('an omitted optional enum is not an error — the browser applies its default', async () => {
  let seen: any
  const dispatch = createDispatcher(async (tool, params) => { seen = { tool, params }; return { id: 'shape:a' } })
  const args = { nodes: [{ key: 'a', text: 'A' }], edges: [] } // no `layout`
  await dispatch('create_graph', args)
  expect(seen).toEqual({ tool: 'create_graph', params: args })
})

// A value that satisfies whatever the schema declares for a field, so a sweep trips the one
// constraint it is testing rather than a neighbour.
function sampleFor(spec: any): unknown {
  if (spec?.enum) return spec.enum[0]
  if (spec?.type === 'number') return 0
  if (spec?.type === 'array') return [{ x: 0, y: 0 }, { x: 1, y: 1 }]
  if (spec?.type === 'object') return {}
  if (spec?.type === 'boolean') return true
  return 'x'
}

test('every enum the tools publish is checked, not just the ones someone remembered', async () => {
  const dispatch = createDispatcher(async () => ({}))
  const withEnums = (TOOL_DEFS as any[]).flatMap((t) =>
    Object.entries(t.inputSchema.properties ?? {})
      .filter(([, spec]: [string, any]) => spec.enum)
      .map(([key]) => [t.name, key, t.inputSchema.required ?? []] as const),
  )
  expect(withEnums.length).toBeGreaterThan(5)
  for (const [name, key, required] of withEnums) {
    const props = (TOOL_DEFS as any[]).find((t) => t.name === name).inputSchema.properties ?? {}
    const args: Record<string, unknown> = Object.fromEntries(
      required.map((k: string) => [k, sampleFor(props[k])]),
    )
    args[key] = 'definitely-not-a-valid-value'
    const r = await dispatch(name, args)
    expect({ name, key, isError: r.isError }).toEqual({ name, key, isError: true })
    expect((r.content[0] as any).text).toContain(`${key} must be one of`)
  }
})

test('a name inherited from Object.prototype is an unknown tool, not a callable handler', async () => {
  const dispatch = createDispatcher(async () => ({}))
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    const r = await dispatch(name, {})
    expect({ name, text: (r.content[0] as any).text }).toEqual({ name, text: `unknown tool: ${name}` })
  }
})

test('an array shorter than the schema says is refused', async () => {
  let called = false
  const dispatch = createDispatcher(async () => { called = true; return {} })
  const r = await dispatch('create_line', { points: [{ x: 0, y: 0 }] })
  expect(r.isError).toBe(true)
  expect((r.content[0] as any).text).toBe('create_line: points needs at least 2 items — got 1')
  expect(called).toBe(false)
})

test('export_image names the one requirement a schema cannot state, instead of a TypeError', async () => {
  const dispatch = createDispatcher(async () => ({}))
  const r = await dispatch('export_image', { target: 'frame', format: 'png', path: 'test-output/x.png' })
  expect(r.isError).toBe(true)
  expect((r.content[0] as any).text).toBe('export_image: name is required when target is frame')
})

test('every minItems the tools publish is enforced, not just the one someone remembered', async () => {
  const dispatch = createDispatcher(async () => ({}))
  const withMin = (TOOL_DEFS as any[]).flatMap((t) =>
    Object.entries(t.inputSchema.properties ?? {})
      .filter(([, spec]: [string, any]) => spec.minItems)
      .map(([key, spec]: [string, any]) => [t.name, key, spec.minItems, t.inputSchema.required ?? []] as const),
  )
  expect(withMin.length).toBeGreaterThan(0)
  for (const [name, key, min, required] of withMin) {
    const props = (TOOL_DEFS as any[]).find((t) => t.name === name).inputSchema.properties ?? {}
    const args: Record<string, unknown> = Object.fromEntries(
      required.map((k: string) => [k, sampleFor(props[k])]),
    )
    args[key] = []
    const r = await dispatch(name, args)
    expect({ name, key, isError: r.isError }).toEqual({ name, key, isError: true })
    expect((r.content[0] as any).text).toContain(`needs at least ${min} items`)
  }
})

test('a value of the wrong type is named, instead of erroring somewhere inside tldraw', async () => {
  let called = false
  const dispatch = createDispatcher(async () => { called = true; return {} })
  const cases: [string, Record<string, unknown>, string][] = [
    ['create_line', { points: 'hello' }, 'create_line: points must be array — got string'],
    ['select', { ids: 'shape:a' }, 'select: ids must be array — got string'],
    ['create_shape', { type: 'rectangle', x: '100', y: 0 }, 'create_shape: x must be number — got string'],
    ['create_frame', { name: 'f', x: 0, y: 0, w: null, h: 10 }, 'create_frame: w must be number — got null'],
    ['nudge_shapes', { ids: ['shape:a'], dx: 0, dy: [] }, 'nudge_shapes: dy must be number — got array'],
  ]
  for (const [tool, args, message] of cases) {
    const r = await dispatch(tool, args)
    expect({ tool, text: (r.content[0] as any).text }).toEqual({ tool, text: message })
  }
  expect(called).toBe(false)
})

test('every declared type the tools publish is enforced', async () => {
  const dispatch = createDispatcher(async () => ({}))
  const typed = (TOOL_DEFS as any[]).flatMap((t) =>
    Object.entries(t.inputSchema.properties ?? {})
      .filter(([, spec]: [string, any]) => ['array', 'number', 'boolean'].includes(spec.type))
      .map(([key, spec]: [string, any]) => [t.name, key, spec.type, t.inputSchema.required ?? []] as const),
  )
  expect(typed.length).toBeGreaterThan(10)
  for (const [name, key, type, required] of typed) {
    const props = (TOOL_DEFS as any[]).find((t) => t.name === name).inputSchema.properties ?? {}
    const args: Record<string, unknown> = Object.fromEntries(
      required.map((k: string) => [k, sampleFor(props[k])]),
    )
    args[key] = 'not-a-' + type
    const r = await dispatch(name, args)
    expect({ name, key, isError: r.isError }).toEqual({ name, key, isError: true })
    expect((r.content[0] as any).text).toContain(`${key} must be ${type}`)
  }
})
