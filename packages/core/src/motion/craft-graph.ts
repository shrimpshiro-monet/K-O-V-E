import createGraph, { type Graph } from "ngraph.graph";
/** Serializable numeric composition graph. Input links point to upstream nodes. */
export type CraftNodeKind = "keyframe-track" | "expression" | "reference" | "combine";
export interface CraftNode { id: string; kind: CraftNodeKind; inputs?: string[]; params: Record<string, number | string> }
export interface CraftGraph { nodes: CraftNode[]; output: string }
export function toGraph(cg: CraftGraph): Graph<CraftNode> {
  validateCraftGraph(cg);
  const graph = createGraph<CraftNode>();
  for (const node of cg.nodes) graph.addNode(node.id, node);
  for (const node of cg.nodes) for (const input of node.inputs ?? []) graph.addLink(input, node.id);
  return graph;
}
export function validateCraftGraph(cg: CraftGraph): void {
  const nodes = new Map<string, CraftNode>();
  for (const node of cg.nodes) {
    if (!node.id || nodes.has(node.id)) throw new Error(`CraftGraph: duplicate/empty node ${node.id}`);
    nodes.set(node.id, node);
  }
  const visited = new Set<string>(), active = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) throw new Error(`CraftGraph: cycle at ${id}`);
    if (visited.has(id)) return;
    const node = nodes.get(id);
    if (!node) throw new Error(`CraftGraph: missing node ${id}`);
    active.add(id);
    for (const input of node.inputs ?? []) visit(input);
    active.delete(id); visited.add(id);
  };
  visit(cg.output);
  for (const id of nodes.keys()) visit(id);
}
export function evaluateCraftGraph(cg: CraftGraph, t: number, resolveReference: (key: string) => number): number {
  validateCraftGraph(cg);
  const nodes = new Map(cg.nodes.map((node) => [node.id, node]));
  const memo = new Map<string, number>();
  const evaluate = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const node = nodes.get(id)!;
    const number = (key: string, fallback: number) => Number(node.params[key] ?? fallback);
    let value: number;
    switch (node.kind) {
      case "reference": value = resolveReference(String(node.params.key)); break;
      case "keyframe-track": {
        const p = Math.max(0, Math.min(1, t / Math.max(1e-9, number("duration", 1))));
        const easing = node.params.easing;
        const eased = easing === "easeInOutSine" ? (1 - Math.cos(Math.PI * p)) / 2 : easing === "easeOutCubic" ? 1 - (1 - p) ** 3 : p;
        value = number("from", 0) + (number("to", 0) - number("from", 0)) * eased;
        break;
      }
      case "expression": {
        const base = node.inputs?.[0] ? evaluate(node.inputs[0]) : 0;
        value = node.params.kind === "spring" ? base * (1 - Math.exp(-number("stiffness", 8) * Math.max(0, t))) : base + Math.sin(t * number("freq", 2) * 2 * Math.PI) * number("amp", 0.05);
        break;
      }
      case "combine": {
        const vals = (node.inputs ?? []).map(evaluate);
        value = node.params.op === "multiply" ? vals.reduce((a, b) => a * b, 1) : vals.reduce((a, b) => a + b, 0);
        break;
      }
    }
    if (!Number.isFinite(value)) throw new Error(`CraftGraph: nonfinite value at ${id}`);
    memo.set(id, value);
    return value;
  };
  return evaluate(cg.output);
}
export function compilePresetToGraph(presetId: string, intensity = 1): CraftGraph {
  switch (presetId) {
    case "slow-push": return { nodes: [{ id: "scale", kind: "keyframe-track", params: { from: 1, to: 1 + 0.08 * intensity, duration: 1, easing: "easeInOutSine" } }], output: "scale" };
    case "handheld": return { nodes: [
      { id: "base", kind: "keyframe-track", params: { from: 0, to: 0 } },
      { id: "shake", kind: "expression", inputs: ["base"], params: { kind: "wiggle", freq: 6, amp: 0.01 * intensity } },
    ], output: "shake" };
    default: return { nodes: [{ id: "flat", kind: "keyframe-track", params: { from: 1, to: 1 } }], output: "flat" };
  }
}
