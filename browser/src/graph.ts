export const NODE_W = 200
export const NODE_H = 100
export const GAP_X = 80
export const GAP_Y = 120

export type GraphNode = { key: string; text: string; shape?: string }
export type GraphEdge = { from: string; to: string; text?: string }

// Layered top-down layout: layer[v] = 1 + max(layer[u]) over incoming edges u->v,
// roots (indegree 0) at layer 0. Kahn-style topological pass so cycles can't loop
// forever — any node left unprocessed after the pass lands one layer past the
// deepest layer we did assign; if there were no roots at all (pure cycle), every
// node lands at layer 0.
export function treeLayers(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const indegree = new Map<string, number>(nodes.map((n) => [n.key, 0]))
  const outgoing = new Map<string, string[]>(nodes.map((n) => [n.key, []]))
  for (const e of edges) {
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1)
    outgoing.get(e.from)?.push(e.to)
  }
  const layer = new Map<string, number>()
  let queue = nodes.filter((n) => indegree.get(n.key) === 0).map((n) => n.key)
  for (const k of queue) layer.set(k, 0)
  const remaining = new Map(indegree)
  while (queue.length > 0) {
    const next: string[] = []
    for (const u of queue) {
      for (const v of outgoing.get(u) ?? []) {
        const candidate = (layer.get(u) ?? 0) + 1
        layer.set(v, Math.max(layer.get(v) ?? 0, candidate))
        const left = (remaining.get(v) ?? 0) - 1
        remaining.set(v, left)
        if (left === 0) next.push(v)
      }
    }
    queue = next
  }
  if (layer.size === 0) {
    // pure cycle, no roots
    for (const n of nodes) layer.set(n.key, 0)
  } else {
    const maxLayer = Math.max(...layer.values())
    for (const n of nodes) {
      if (!layer.has(n.key)) layer.set(n.key, maxLayer + 1)
    }
  }
  return layer
}

export function graphPositions(
  nodes: GraphNode[],
  edges: GraphEdge[],
  layout: string,
  x: number,
  y: number,
): Map<string, { px: number; py: number }> {
  const positions = new Map<string, { px: number; py: number }>()
  if (layout === 'grid') {
    const cols = Math.ceil(Math.sqrt(nodes.length))
    nodes.forEach((n, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      positions.set(n.key, {
        px: x + col * (NODE_W + GAP_X),
        py: y + row * (NODE_H + GAP_Y),
      })
    })
    return positions
  }
  // 'tree' (default): group node keys by layer, preserving nodes[] order within each layer.
  const layer = treeLayers(nodes, edges)
  const byLayer = new Map<number, string[]>()
  for (const n of nodes) {
    const l = layer.get(n.key)!
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(n.key)
  }
  for (const [l, keys] of byLayer) {
    keys.forEach((key, j) => {
      positions.set(key, {
        px: x + j * (NODE_W + GAP_X),
        py: y + l * (NODE_H + GAP_Y),
      })
    })
  }
  return positions
}
