import type { Editor } from 'tldraw'
import { runTool } from './tools'

const RELAY_URL = 'ws://localhost:9910/?role=browser'

// 4001: the relay's app-defined code for "a newer browser took over" (see src/relay.ts).
// Every other close code (relay restarting, network blip, ordinary close) still retries.
const SUPERSEDED_CLOSE_CODE = 4001

export function connectRelay(editor: Editor, onSuperseded: () => void) {
  const ws = new WebSocket(RELAY_URL)
  ws.onmessage = async (e) => {
    const { requestId, tool, params, agent } = JSON.parse(e.data as string)
    try {
      const result = await runTool(editor, tool, params, agent)
      ws.send(JSON.stringify({ requestId, ok: true, result }))
    } catch (err: any) {
      ws.send(JSON.stringify({ requestId, ok: false, error: String(err?.message ?? err) }))
    }
  }
  ws.onclose = (e) => {
    if (e.code === SUPERSEDED_CLOSE_CODE) {
      onSuperseded()
      return
    }
    setTimeout(() => connectRelay(editor, onSuperseded), 1000)
  }
}
