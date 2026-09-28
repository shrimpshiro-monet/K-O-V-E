import {
  BeatDetectionProcessor,
  getBeatDetectionProcessor,
  initWasmBeatDetection,
} from "../wasm/beat-detection";

export interface Beat {
  readonly time: number;
  readonly strength: number;
  readonly index: number;
}

export interface BeatAnalysisResult {
  readonly bpm: number;
  readonly confidence: number;
  readonly beats: Beat[];
  readonly duration: number;
  readonly downbeats: number[];
}

export interface BeatDetectionConfig {
  readonly minBpm: number;
  readonly maxBpm: number;
  readonly sensitivity: number;
  readonly windowSize: number;
  readonly hopSize: number;
}

export const DEFAULT_BEAT_DETECTION_CONFIG: BeatDetectionConfig = {
  minBpm: 60,
  maxBpm: 200,
  sensitivity: 0.5,
  windowSize: 2048,
  hopSize: 512,
};

export class BeatDetectionEngine {
  private config: BeatDetectionConfig;
  private audioContext: AudioContext | OfflineAudioContext | null = null;
  private wasmProcessor: BeatDetectionProcessor;
  private wasmInitialized: boolean = false;
  private lastEnvelope: { values: Float32Array; sampleRate: number; hopSize: number } | null = null;

  constructor(config: Partial<BeatDetectionConfig> = {}) {
    this.config = { ...DEFAULT_BEAT_DETECTION_CONFIG, ...config };
    this.wasmProcessor = getBeatDetectionProcessor();
    this.initWasm();
  }

  private async initWasm(): Promise<void> {
    if (this.wasmInitialized) return;
    try {
      await initWasmBeatDetection();
      await this.wasmProcessor.ensureWasm();
      this.wasmInitialized = true;
    } catch {
      this.wasmInitialized = false;
    }
  }

  async analyzeAudioBuffer(
    audioBuffer: AudioBuffer,
  ): Promise<BeatAnalysisResult> {
    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const duration = audioBuffer.duration;

    const onsets = this.detectOnsets(channelData, sampleRate);
    const { bpm, confidence } = this.calculateBpm(onsets, duration);
    const beats = this.generateBeats(bpm, duration, onsets);
    const downbeats = this.detectDownbeats(beats);

    return {
      bpm,
      confidence,
      beats,
      duration,
      downbeats,
    };
  }

  async analyzeFromBlob(blob: Blob): Promise<BeatAnalysisResult> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }

    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    return this.analyzeAudioBuffer(audioBuffer);
  }

  async analyzeFromUrl(url: string): Promise<BeatAnalysisResult> {
    const response = await fetch(url);
    const blob = await response.blob();
    return this.analyzeFromBlob(blob);
  }

  /**
   * Detects onset events (significant energy increases) in audio using RMS energy analysis.
   * Algorithm: Extract RMS energy in windows, smooth for stability, apply adaptive threshold,
   * find peaks (local maxima with sufficient rise), enforce minimum spacing between detections.
   *
   * This is more robust than spectral methods for real-world audio with variable dynamics.
   */
  private detectOnsets(samples: Float32Array, sampleRate: number): number[] {
    const { windowSize, hopSize, sensitivity } = this.config;
    const onsets: number[] = [];

    const numFrames = Math.floor((samples.length - windowSize) / hopSize);
    const energiesF32 = new Float32Array(numFrames);

    this.wasmProcessor.computeRMSEnergies(samples, windowSize, hopSize, energiesF32);

    const smoothedF32 = new Float32Array(numFrames);
    this.wasmProcessor.smoothArray(energiesF32, smoothedF32, 5);

    const smoothedEnergies = Array.from(smoothedF32);
    this.lastEnvelope = { values: smoothedF32, sampleRate, hopSize };
    // Step 3: Compute dynamic threshold based on local statistics and sensitivity
    const threshold = this.calculateAdaptiveThreshold(
      smoothedEnergies,
      sensitivity,
    );

    // Step 4: Detect peaks (onsets) with multiple constraints
    let lastOnsetFrame = -10;
    // Minimum 100ms between onsets to avoid detecting echoes/reverb as separate onsets
    const minFramesBetweenOnsets = Math.floor((sampleRate / hopSize) * 0.1);
    // Rise is measured against the preceding ~35ms trough: after smoothing, a
    // single-frame delta never reaches a meaningful fraction of the threshold.
    const riseLookback = Math.max(1, Math.floor((sampleRate / hopSize) * 0.035));

    for (let i = 1; i < smoothedEnergies.length - 1; i++) {
      const current = smoothedEnergies[i];
      const localThreshold = threshold[i];

      // Must be local maximum in time
      const isLocalMax =
        current > smoothedEnergies[i - 1] && current >= smoothedEnergies[i + 1];
      // Must exceed adaptive threshold at this point
      const isAboveThreshold = current > localThreshold;
      // Must show sufficient energy rise since the recent trough (attack phase)
      let trough = smoothedEnergies[i - 1];
      for (let j = i - 1; j >= Math.max(0, i - riseLookback); j--) {
        if (smoothedEnergies[j] < trough) trough = smoothedEnergies[j];
      }
      const hasRise = current - trough > localThreshold * 0.25;
      // Enforce minimum spacing between detections (prevents duplicate detections)
      const notTooClose = i - lastOnsetFrame >= minFramesBetweenOnsets;

      if (isLocalMax && isAboveThreshold && hasRise && notTooClose) {
        const timeInSeconds = (i * hopSize) / sampleRate;
        onsets.push(timeInSeconds);
        lastOnsetFrame = i;
      }
    }

    return onsets;
  }

  /**
   * Computes per-frame dynamic thresholds using local statistics.
   * Combines median (robust to outliers) and mean (captures overall level).
   * Sensitivity parameter: 0 (strict, few false positives) to 1 (loose, more detections).
   * Local context window accounts for audio dynamics (e.g., quiet intro vs loud chorus).
   */
  private calculateAdaptiveThreshold(
    energies: number[],
    sensitivity: number,
  ): number[] {
    const medianWindowSize = 50;
    const thresholds: number[] = [];

    for (let i = 0; i < energies.length; i++) {
      const start = Math.max(0, i - medianWindowSize);
      const end = Math.min(energies.length, i + medianWindowSize);
      const windowArr = new Float32Array(energies.slice(start, end));

      const median = this.wasmProcessor.calculateMedian(windowArr);
      const mean = this.wasmProcessor.calculateMean(windowArr);

      const threshold = median + (mean - median) * (1 - sensitivity);
      thresholds.push(threshold * (1.5 - sensitivity * 0.5));
    }

    return thresholds;
  }

  private calculateBpm(
    onsets: number[],
    duration: number,
  ): { bpm: number; confidence: number } {
    if (onsets.length < 4) {
      return { bpm: 120, confidence: 0 };
    }

    const { minBpm, maxBpm } = this.config;
    const envelopeRate = 100;
    const frames = Math.max(2, Math.ceil(duration * envelopeRate));
    const envelope = new Float32Array(frames);
    for (const onset of onsets) {
      const index = Math.round(onset * envelopeRate);
      if (index >= 0 && index < frames) envelope[index] += 1;
    }

    const minLag = Math.max(2, Math.floor((60 / maxBpm) * envelopeRate));
    const maxLag = Math.min(frames - 2, Math.ceil((60 / minBpm) * envelopeRate));
    if (maxLag <= minLag) return { bpm: 120, confidence: 0 };

    const scores: number[] = [];
    let bestScore = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < frames; i++) sum += envelope[i] * envelope[i + lag];
      const score = sum / (frames - lag);
      scores.push(score);
      if (score > bestScore) bestScore = score;
    }

    // Prefer the fastest plausible lag that explains the data — the raw peak sits
    // on beat multiples (half/double tempo), which are all equally correlated.
    const threshold = bestScore * 0.9;
    let bestOffset = 0;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] >= threshold) {
        bestOffset = i;
        break;
      }
    }

    const lag = minLag + bestOffset;
    let refinedLag = lag;
    const left = scores[bestOffset - 1];
    const mid = scores[bestOffset];
    const right = scores[bestOffset + 1];
    if (left !== undefined && right !== undefined && mid > left && mid > right) {
      const denom = left - 2 * mid + right;
      if (denom !== 0) refinedLag = lag - 0.5 * (right - left) / denom;
    }

    const bpm = 60 / (refinedLag / envelopeRate);
    if (!(bpm >= minBpm && bpm <= maxBpm)) return { bpm: 120, confidence: 0 };

    const expectedBeats = (duration * bpm) / 60;
    const confidence = Math.min(
      1,
      Math.max(0, 1 - Math.abs(expectedBeats - onsets.length) / expectedBeats),
    );

    return { bpm, confidence };
  }

  private generateBeats(
    bpm: number,
    duration: number,
    onsets: number[],
  ): Beat[] {
    const beatInterval = 60 / bpm;
    const beats: Beat[] = [];
    if (onsets.length === 0) {
      let index = 0;
      for (let time = 0; time < duration; time += beatInterval) {
        beats.push({ time, strength: 0.5, index: index++ });
      }
      return beats;
    }

    // Fit one phase over a single beat period, then walk a fixed lattice.
    // Targets never accumulate the previous beat's snap error, so a late onset
    // cannot slide the whole grid onto the off-beat.
    const tolerance = beatInterval * 0.45;
    const fitPhase = (period: number): number => {
      let bestPhase = 0;
      let bestScore = -1;
      const phaseSteps = 120;
      for (let s = 0; s < phaseSteps; s++) {
        const phase = (s / phaseSteps) * period;
        let score = 0;
        for (const onset of onsets) {
          const wrapped = ((onset - phase) % period + period) % period;
          const distance = Math.min(wrapped, period - wrapped);
          if (distance <= tolerance) score += 1 - distance / tolerance;
        }
        if (score > bestScore) {
          bestScore = score;
          bestPhase = phase;
        }
      }
      return bestPhase;
    };

    const walk = (period: number, phase: number) => {
      const snapped: Array<{ k: number; onset: number | null }> = [];
      let k = 0;
      for (let time = phase; time < duration; time += period, k++) {
        let best: number | null = null;
        let bestDistance = tolerance;
        for (const onset of onsets) {
          const distance = Math.abs(onset - time);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = onset;
          }
        }
        snapped.push({ k, onset: best });
      }
      return snapped;
    };

    // A coarse autocorrelation lag quantises to ~10ms, which drifts past the
    // 50ms budget inside 30s. Refine period and phase against the dense energy
    // envelope instead of the sparse onset list: ~0.1% period error is the
    // difference between staying inside 50ms and drifting half a beat.
    let period = beatInterval;
    let phase = fitPhase(period);
    const envelope = this.lastEnvelope;
    if (envelope && envelope.values.length > 8) {
      const frameOf = (time: number) =>
        Math.round((time * envelope.sampleRate) / envelope.hopSize);
      const halfWindow = Math.max(
        1,
        Math.round((0.025 * envelope.sampleRate) / envelope.hopSize),
      );
      const score = (candidatePeriod: number, candidatePhase: number) => {
        let total = 0;
        for (let time = candidatePhase; time < duration; time += candidatePeriod) {
          const center = frameOf(time);
          let peak = 0;
          for (
            let j = Math.max(0, center - halfWindow);
            j <= Math.min(envelope.values.length - 1, center + halfWindow);
            j++
          ) {
            if (envelope.values[j] > peak) peak = envelope.values[j];
          }
          total += peak;
        }
        return total;
      };

      let bestScore = -1;
      for (let step = -40; step <= 40; step++) {
        const candidatePeriod = beatInterval * (1 + step * 0.001);
        const phaseSteps = 60;
        for (let s = 0; s < phaseSteps; s++) {
          const candidatePhase = (s / phaseSteps) * candidatePeriod;
          const candidateScore = score(candidatePeriod, candidatePhase);
          if (candidateScore > bestScore) {
            bestScore = candidateScore;
            period = candidatePeriod;
            phase = candidatePhase;
          }
        }
      }
    }

    const snapped = walk(period, phase);

    // Emit the uniform lattice itself. Snapping each beat to whatever onset
    // sits nearby drags beats onto the off-beat (half-period) hits.
    const hitTolerance = beatInterval * 0.15;
    let index = 0;
    for (const { k, onset } of snapped) {
      const time = phase + k * period;
      const onHit = onset !== null && Math.abs(onset - time) <= hitTolerance;
      beats.push({
        time: onHit ? (onset as number) : time,
        strength: onHit ? 1 : 0.5,
        index: index++,
      });
    }

    return beats;
  }

  private detectDownbeats(beats: Beat[]): number[] {
    if (beats.length < 4) {
      return beats.filter((_, i) => i % 4 === 0).map((b) => b.time);
    }

    const downbeats: number[] = [];
    const strongBeats = beats.filter((b) => b.strength > 0.7);

    if (strongBeats.length > 0) {
      const firstStrong = strongBeats[0];
      const firstIndex = beats.findIndex((b) => b.time === firstStrong.time);

      for (let i = firstIndex; i < beats.length; i += 4) {
        downbeats.push(beats[i].time);
      }
    } else {
      for (let i = 0; i < beats.length; i += 4) {
        downbeats.push(beats[i].time);
      }
    }

    return downbeats;
  }

  generateBeatMarkersAtInterval(
    bpm: number,
    duration: number,
    startTime: number = 0,
    beatsPerBar: number = 4,
  ): Beat[] {
    const beatInterval = 60 / bpm;
    const beats: Beat[] = [];
    let beatIndex = 0;

    for (let time = startTime; time < duration; time += beatInterval) {
      const isDownbeat = beatIndex % beatsPerBar === 0;
      beats.push({
        time,
        strength: isDownbeat ? 1 : 0.7,
        index: beatIndex,
      });
      beatIndex++;
    }

    return beats;
  }

  snapTimeToNearestBeat(
    time: number,
    beats: Beat[],
    snapThreshold: number = 0.1,
  ): number {
    if (beats.length === 0) return time;

    let nearest = beats[0];
    let minDist = Math.abs(beats[0].time - time);

    for (const beat of beats) {
      const dist = Math.abs(beat.time - time);
      if (dist < minDist) {
        minDist = dist;
        nearest = beat;
      }
    }

    return minDist <= snapThreshold ? nearest.time : time;
  }

  getBeatsInRange(beats: Beat[], startTime: number, endTime: number): Beat[] {
    return beats.filter((b) => b.time >= startTime && b.time <= endTime);
  }

  dispose(): void {
    if (this.audioContext && this.audioContext instanceof AudioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}

let beatDetectionEngineInstance: BeatDetectionEngine | null = null;

export function getBeatDetectionEngine(): BeatDetectionEngine {
  if (!beatDetectionEngineInstance) {
    beatDetectionEngineInstance = new BeatDetectionEngine();
  }
  return beatDetectionEngineInstance;
}

export function disposeBeatDetectionEngine(): void {
  if (beatDetectionEngineInstance) {
    beatDetectionEngineInstance.dispose();
    beatDetectionEngineInstance = null;
  }
}
