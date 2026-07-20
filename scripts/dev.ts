// One-command dev launcher: relay + vite in one terminal.
// Frees stale ports first, streams both children's output prefixed, and
// shuts both down cleanly on Ctrl-C. Pure process orchestration — no new
// dependency, no runtime/architecture change.

const PORTS = [9910, 5173] as const

function freeStalePort(port: number) {
  let stdout: Uint8Array
  try {
    ;({ stdout } = Bun.spawnSync(['lsof', '-ti', `tcp:${port}`]))
  } catch {
    return // lsof missing — nothing we can do about it here
  }
  const pids = new TextDecoder().decode(stdout).trim().split('\n').filter(Boolean)
  for (const pid of pids) {
    try {
      process.kill(Number(pid))
      console.log(`[dev] freed :${port} (killed stale pid ${pid})`)
    } catch {
      // gone already between lsof and kill — fine
    }
  }
}

for (const port of PORTS) freeStalePort(port)

async function streamPrefixed(tag: string, stream: ReadableStream<Uint8Array> | null, out: (line: string) => void) {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) out(`[${tag}] ${line}`)
  }
  if (buf) out(`[${tag}] ${buf}`)
}

const relay = Bun.spawn(['bun', 'run', 'relay'], { stdout: 'pipe', stderr: 'pipe' })
const vite = Bun.spawn(['bun', 'run', 'dev'], { stdout: 'pipe', stderr: 'pipe' })

streamPrefixed('relay', relay.stdout, (l) => console.log(l))
streamPrefixed('relay', relay.stderr, (l) => console.error(l))
streamPrefixed('vite', vite.stdout, (l) => console.log(l))
streamPrefixed('vite', vite.stderr, (l) => console.error(l))

let stopping = false
function stop(code: number) {
  if (stopping) return
  stopping = true
  for (const child of [relay, vite]) {
    try {
      child.kill()
    } catch {
      // already exited — fine
    }
  }
  process.exit(code)
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

relay.exited.then((code) => {
  if (stopping) return
  console.error(`[dev] relay exited unexpectedly (code ${code}) — stopping vite`)
  stop(code === 0 ? 1 : code)
})
vite.exited.then((code) => {
  if (stopping) return
  console.error(`[dev] vite exited unexpectedly (code ${code}) — stopping relay`)
  stop(code === 0 ? 1 : code)
})
