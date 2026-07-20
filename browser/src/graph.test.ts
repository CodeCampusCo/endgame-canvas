import { expect, test } from 'bun:test'
import { treeLayers, graphPositions, NODE_W, NODE_H, type GraphNode, type GraphEdge } from './graph'

const GAP_X = 80
const GAP_Y = 120

function nodes(...keys: string[]): GraphNode[] {
  return keys.map((key) => ({ key, text: key }))
}

// --- treeLayers ---

test('treeLayers: a chain A→B→C→D gives layers 0,1,2,3', () => {
  const ns = nodes('A', 'B', 'C', 'D')
  const edges: GraphEdge[] = [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'C', to: 'D' }]
  const layer = treeLayers(ns, edges)
  expect(Object.fromEntries(layer)).toEqual({ A: 0, B: 1, C: 2, D: 3 })
})

test('treeLayers: a diamond (A→B, A→C, B→D, C→D) gives D the longest-path layer 2, not 1', () => {
  const ns = nodes('A', 'B', 'C', 'D')
  const edges: GraphEdge[] = [
    { from: 'A', to: 'B' },
    { from: 'A', to: 'C' },
    { from: 'B', to: 'D' },
    { from: 'C', to: 'D' },
  ]
  const layer = treeLayers(ns, edges)
  expect(Object.fromEntries(layer)).toEqual({ A: 0, B: 1, C: 1, D: 2 })
})

test('treeLayers: a pure cycle (A→B, B→A) puts every node at layer 0', () => {
  const ns = nodes('A', 'B')
  const edges: GraphEdge[] = [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }]
  const layer = treeLayers(ns, edges)
  expect(Object.fromEntries(layer)).toEqual({ A: 0, B: 0 })
})

test('treeLayers: a partial cycle leaves the unreachable node one past the deepest assigned layer', () => {
  // A→B is a normal chain (A=0, B=1). C→C is a self-cycle disconnected from any
  // root, so it never enters the Kahn queue and is never assigned during the pass —
  // it lands at maxLayer + 1 = 2, one past B's layer of 1.
  const ns = nodes('A', 'B', 'C')
  const edges: GraphEdge[] = [{ from: 'A', to: 'B' }, { from: 'C', to: 'C' }]
  const layer = treeLayers(ns, edges)
  expect(Object.fromEntries(layer)).toEqual({ A: 0, B: 1, C: 2 })
})

// --- graphPositions ---

test('graphPositions grid: node i at col=i%ceil(sqrt(n)), row=floor(i/ceil(sqrt(n)))', () => {
  const ns = nodes('A', 'B', 'C', 'D', 'E') // n=5 → cols = ceil(sqrt(5)) = 3
  const positions = graphPositions(ns, [], 'grid', 100, 100)
  expect(Object.fromEntries(positions)).toEqual({
    A: { px: 100, py: 100 }, // col 0, row 0
    B: { px: 100 + (NODE_W + GAP_X), py: 100 }, // col 1, row 0
    C: { px: 100 + 2 * (NODE_W + GAP_X), py: 100 }, // col 2, row 0
    D: { px: 100, py: 100 + (NODE_H + GAP_Y) }, // col 0, row 1
    E: { px: 100 + (NODE_W + GAP_X), py: 100 + (NODE_H + GAP_Y) }, // col 1, row 1
  })
})

test('graphPositions tree: layer L at py = y + L*(NODE_H+GAP_Y), j-th node in layer at px = x + j*(NODE_W+GAP_X)', () => {
  const ns = nodes('A', 'B', 'C', 'D')
  const edges: GraphEdge[] = [
    { from: 'A', to: 'B' },
    { from: 'A', to: 'C' },
    { from: 'B', to: 'D' },
    { from: 'C', to: 'D' },
  ]
  const positions = graphPositions(ns, edges, 'tree', 100, 100)
  expect(Object.fromEntries(positions)).toEqual({
    A: { px: 100, py: 100 }, // layer 0, j=0
    B: { px: 100, py: 100 + (NODE_H + GAP_Y) }, // layer 1, j=0
    C: { px: 100 + (NODE_W + GAP_X), py: 100 + (NODE_H + GAP_Y) }, // layer 1, j=1
    D: { px: 100, py: 100 + 2 * (NODE_H + GAP_Y) }, // layer 2, j=0
  })
})
