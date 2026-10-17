import Meyda, { type MeydaFeaturesObject } from "meyda";
import { evaluateCraftGraph, type CraftGraph } from "@kove-advanced/core/motion/craft-graph";
export interface LiveAudioFeatures { rms: number; spectralCentroid: number; zcr: number }
/** Attach to an existing AudioNode; caller owns source/context lifecycle. No server analysis. */
export function startReactiveAudioAnalysis(ctx: AudioContext, source: AudioNode, onFeatures: (f: LiveAudioFeatures) => void): () => void {
  const analyzer = Meyda.createMeydaAnalyzer({
    audioContext: ctx, source, bufferSize: 512,
    featureExtractors: ["rms", "spectralCentroid", "zcr"],
    callback: (features: MeydaFeaturesObject) => onFeatures({ rms: features.rms ?? 0, spectralCentroid: features.spectralCentroid ?? 0, zcr: features.zcr ?? 0 }),
  });
  analyzer.start();
  return () => analyzer.stop();
}
/** Reference-node resolver for live previews; returns neutral zero until audio is available. */
export function evaluateAudioGraph(graph: CraftGraph, time: number, features: LiveAudioFeatures | null): number {
  return evaluateCraftGraph(graph, time, (key) => key === "audio.rms" ? (features?.rms ?? 0) : key === "audio.spectralCentroid" ? (features?.spectralCentroid ?? 0) : key === "audio.zcr" ? (features?.zcr ?? 0) : 0);
}
