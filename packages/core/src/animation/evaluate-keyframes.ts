import { evaluateCraftGraph, type CraftGraph } from "../motion/craft-graph";
import type { Keyframe } from "../types/timeline";
import { keyframeEngine } from "../video/keyframe-engine";

export function evaluateKeyframesAt(
  keyframes: readonly Keyframe[] | undefined,
  localTime: number,
  graphs?: Readonly<Record<string, CraftGraph>>,
  resolveReference: (key: string) => number = () => 0,
): Map<string, number> {
  const values = new Map<string, number>();
  if (!keyframes || keyframes.length === 0) {
    for (const [property, graph] of Object.entries(graphs ?? {})) values.set(property, evaluateCraftGraph(graph, localTime, resolveReference));
    return values;
  }

  const byProperty = new Map<string, Keyframe[]>();
  for (const keyframe of keyframes) {
    const group = byProperty.get(keyframe.property);
    if (group) {
      group.push(keyframe);
    } else {
      byProperty.set(keyframe.property, [keyframe]);
    }
  }

  for (const [property, propertyKeyframes] of byProperty) {
    const result = keyframeEngine.getValueAtTime(propertyKeyframes, localTime);
    if (typeof result.value === "number" && Number.isFinite(result.value)) {
      values.set(property, result.value);
    }
  }

  for (const [property, graph] of Object.entries(graphs ?? {})) values.set(property, evaluateCraftGraph(graph, localTime, resolveReference));
  return values;
}
