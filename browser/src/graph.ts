export const NODE_W = 200
export const NODE_H = 100
export const GAP_X = 80
export const GAP_Y = 120

const PITCH_X = NODE_W + GAP_X
const PITCH_Y = NODE_H + GAP_Y

export type GraphNode = { key: string; text: string; shape?: string }
export type GraphEdge = { from: string; to: string; text?: string }

type Adjacency = { preds: Map<string, string[]>; succs: Map<string, string[]> }

function adjacency(nodes: GraphNode[], edges: GraphEdge[]): Adjacency {
  const preds = new Map<string, string[]>(nodes.map((n) => [n.key, []]))
  const succs = new Map<string, string[]>(nodes.map((n) => [n.key, []]))
  for (const e of edges) {
    preds.get(e.to)?.push(e.from)
    succs.get(e.from)?.push(e.to)
  }
  return { preds, succs }
}

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
  // A source pinned to layer 0 whose only consumer sits several layers down drags
  // one long edge across the whole diagram. Nothing points at a source, so nothing
  // constrains it from above: drop it to just above its earliest consumer. Sources
  // have no incoming edges, so no other node's layer depends on this — one pass is
  // enough, and a source with no consumers at all stays where it is.
  for (const n of nodes) {
    if (indegree.get(n.key) !== 0) continue
    const consumers = outgoing.get(n.key) ?? []
    if (consumers.length === 0) continue
    const earliest = Math.min(...consumers.map((v) => layer.get(v) ?? 0))
    layer.set(n.key, Math.max(0, earliest - 1))
  }
  return layer
}

// Order the nodes within each layer so edges cross as little as possible: repeatedly
// re-sort every layer by the mean position of each node's neighbours in the layer
// it points at (or is pointed at from). Sweeping both directions a couple of times
// is the standard Sugiyama ordering step; a node with no neighbours keeps its slot,
// and sort() is stable, so the caller's nodes[] order survives wherever it is free to.
function orderLayers(byLayer: Map<number, string[]>, adj: Adjacency): void {
  const index = new Map<string, number>()
  const reindex = () => {
    for (const [, keys] of byLayer) keys.forEach((k, i) => index.set(k, i))
  }
  reindex()
  const ascending = [...byLayer.keys()].sort((a, b) => a - b)

  const sweep = (keys: string[], neighbours: Map<string, string[]>) => {
    const barycentre = new Map<string, number>()
    keys.forEach((key, i) => {
      const slots = (neighbours.get(key) ?? [])
        .map((n) => index.get(n))
        .filter((v): v is number => v !== undefined)
      const mean = slots.length > 0 ? slots.reduce((a, b) => a + b, 0) / slots.length : i
      barycentre.set(key, mean)
    })
    keys.sort((a, b) => barycentre.get(a)! - barycentre.get(b)!)
    reindex()
  }

  for (let pass = 0; pass < 2; pass++) {
    for (const l of ascending) sweep(byLayer.get(l)!, adj.preds)
    for (const l of [...ascending].reverse()) sweep(byLayer.get(l)!, adj.succs)
  }
}

// Give every node in one layer its x, honouring the layer's order and the minimum
// gap: each node lands on its desired centre unless the node to its left has already
// claimed that space, in which case it is pushed right.
function placeRow(keys: string[], desired: number[], positions: Map<string, { px: number; py: number }>): void {
  let prev: number | null = null
  keys.forEach((key, i) => {
    const px = prev === null ? desired[i]! : Math.max(desired[i]!, prev + PITCH_X)
    positions.get(key)!.px = px
    prev = px
  })
}

function meanOf(keys: string[], positions: Map<string, { px: number; py: number }>, fallback: number): number {
  const xs = keys.map((k) => positions.get(k)?.px).filter((v): v is number => v !== undefined)
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : fallback
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
      positions.set(n.key, { px: x + col * PITCH_X, py: y + row * PITCH_Y })
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

  const adj = adjacency(nodes, edges)
  orderLayers(byLayer, adj)

  for (const [l, keys] of byLayer) {
    keys.forEach((key, j) => positions.set(key, { px: x + j * PITCH_X, py: y + l * PITCH_Y }))
  }

  const ascending = [...byLayer.keys()].sort((a, b) => a - b)
  // Deepest layer up: a parent belongs over the middle of the children it points at.
  for (const l of [...ascending].reverse()) {
    const keys = byLayer.get(l)!
    const desired = keys.map((k) => meanOf(adj.succs.get(k) ?? [], positions, positions.get(k)!.px))
    placeRow(keys, desired, positions)
  }
  // Top down: a leaf has no children to centre over, so centre it under its parents
  // instead. Nodes with children keep the x the pass above just gave them.
  for (const l of ascending) {
    const keys = byLayer.get(l)!
    const desired = keys.map((k) =>
      (adj.succs.get(k) ?? []).length > 0
        ? positions.get(k)!.px
        : meanOf(adj.preds.get(k) ?? [], positions, positions.get(k)!.px),
    )
    placeRow(keys, desired, positions)
  }
  // Centring can push the whole layout off the origin the caller asked for.
  const minPx = Math.min(...[...positions.values()].map((p) => p.px))
  if (minPx !== x) for (const p of positions.values()) p.px += x - minPx

  return positions
}
