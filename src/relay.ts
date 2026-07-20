type ServerWS = import('bun').ServerWebSocket<{ role: string }>

const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

export function startRelay(port = 9910, opts: { allowedOrigins?: string[] } = {}) {
  const allowedOrigins = opts.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS
  let browserSocket: ServerWS | null = null
  const pending = new Map<string, ServerWS>() // requestId → originating mcp socket

  // The browser is gone: every in-flight call was waiting for its reply and will
  // never get one. Reject each caller so it fails fast instead of hanging the timeout.
  // Reused by both browser-close (item 1) and browser-replace (item 2).
  function dropBrowser(reason: string) {
    for (const [requestId, mcpSocket] of pending) {
      try {
        mcpSocket.send(JSON.stringify({ requestId, ok: false, error: reason }))
      } catch {
        // caller socket already gone — nothing to deliver to
      }
    }
    pending.clear()
    browserSocket = null
  }

  const server = Bun.serve<{ role: string }>({
    port,
    fetch(req, server) {
      // Origin allowlist: browsers send an Origin header; trusted local non-browser
      // clients (the MCP server, the probe) send none. Absent → allow; present but
      // not allowlisted → reject before upgrading.
      const origin = req.headers.get('origin')
      if (origin !== null && !allowedOrigins.includes(origin)) {
        return new Response('forbidden origin', { status: 403 })
      }
      const role = new URL(req.url).searchParams.get('role') ?? 'unknown'
      if (server.upgrade(req, { data: { role } })) return
      return new Response('websocket only', { status: 426 })
    },
    websocket: {
      open(ws: ServerWS) {
        if (ws.data.role === 'browser') {
          // Newest browser wins. If an old one is still around, tear it down cleanly
          // (evict its pending, then close it) so it can't linger as a phantom that
          // silently swallows routed messages.
          if (browserSocket && browserSocket.readyState === WebSocket.OPEN) {
            const old = browserSocket
            dropBrowser('browser disconnected')
            old.close()
          }
          browserSocket = ws
        }
      },
      message(ws: ServerWS, raw) {
        let msg: any
        try {
          msg = JSON.parse(String(raw))
        } catch {
          return // ignore a malformed frame — do not crash the relay
        }
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
        } else if (ws.data.role === 'browser' && ws === browserSocket) {
          // Only the CURRENT browser may answer — an evicted phantom must not
          // deliver a reply between being replaced and being closed.
          const caller = pending.get(msg.requestId)
          pending.delete(msg.requestId)
          caller?.send(JSON.stringify(msg))
        }
      },
      close(ws: ServerWS) {
        if (ws === browserSocket) {
          dropBrowser('browser disconnected')
        } else if (ws.data.role === 'mcp') {
          // Caller is gone; drop any of its in-flight entries so the map doesn't leak.
          for (const [requestId, mcpSocket] of pending) {
            if (mcpSocket === ws) pending.delete(requestId)
          }
        }
      },
    },
  })
  return server
}

if (import.meta.main) {
  const s = startRelay(9910)
  console.error(`[relay] listening on ws://localhost:${s.port}`)
}
