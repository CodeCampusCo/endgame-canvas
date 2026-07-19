import { expect, test } from 'bun:test'
import { startRelay } from './relay'
import { createCanvasClient, createDispatcher } from './server'

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

test('dispatch read_frame with url → image content + shapes/bindings text', async () => {
  const shapes = [{ id: 'shape:a', type: 'geo', x: 1, y: 2, w: 3, h: 4, text: '' }]
  const bindings = [{ arrowId: 'shape:arrow1', start: 'shape:a', end: null }]
  const dispatch = createDispatcher(async () => ({
    url: 'data:image/png;base64,AAAB',
    width: 400,
    height: 300,
    shapes,
    bindings,
    frameId: 'shape:frame1',
  }))
  expect(await dispatch('read_frame', { name: 'probe-frame' })).toEqual({
    content: [
      { type: 'image', data: 'AAAB', mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify({ shapes, bindings, frameId: 'shape:frame1' }, null, 2) },
    ],
  })
})

test('dispatch read_frame with url: null → text-only content, no image part', async () => {
  const dispatch = createDispatcher(async () => ({
    url: null,
    width: 0,
    height: 0,
    shapes: [],
    bindings: [],
    frameId: 'shape:empty1',
  }))
  expect(await dispatch('read_frame', { name: 'empty-frame' })).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ shapes: [], bindings: [], frameId: 'shape:empty1' }, null, 2) }],
  })
})
