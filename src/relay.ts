type ServerWS = import('bun').ServerWebSocket<{ role: string }>

export function startRelay(port = 9910) {
  let browserSocket: ServerWS | null = null
  const pending = new Map<string, ServerWS>() // requestId → originating mcp socket

  const server = Bun.serve<{ role: string }>({
    port,
    fetch(req, server) {
      const role = new URL(req.url).searchParams.get('role') ?? 'unknown'
      if (server.upgrade(req, { data: { role } })) return
      return new Response('websocket only', { status: 426 })
    },
    websocket: {
      open(ws: ServerWS) {
        if (ws.data.role === 'browser') browserSocket = ws
      },
      message(ws: ServerWS, raw) {
        const msg = JSON.parse(String(raw))
        if (ws.data.role === 'mcp') {
          if (!browserSocket) {
            ws.send(JSON.stringify({
              requestId: msg.requestId, ok: false,
              error: 'no browser connected — open the canvas tab',
            }))
            return
          }
          pending.set(msg.requestId, ws)
          browserSocket.send(JSON.stringify(msg))
        } else if (ws.data.role === 'browser') {
          const caller = pending.get(msg.requestId)
          pending.delete(msg.requestId)
          caller?.send(JSON.stringify(msg))
        }
      },
      close(ws: ServerWS) {
        if (ws === browserSocket) browserSocket = null
      },
    },
  })
  return server
}

if (import.meta.main) {
  const s = startRelay(9910)
  console.error(`[relay] listening on ws://localhost:${s.port}`)
}
