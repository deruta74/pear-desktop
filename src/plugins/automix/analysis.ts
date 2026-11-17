// Adapted from upstream #4749 by @SurajBhari, pinned 31d35d3a1149bd273e5cd0d3794844d16664aa14.
// Weighted onset autocorrelation and Krumhansl-Kessler chroma profiles; see EXPERIMENT.md.
import type { CrossfadePluginConfig } from '../crossfade/config';

export const FPS = 20;
export const MAX_FRAMES = 400;
export type Frame = { energy: number; chroma: readonly number[] };
export type Analysis = {
  bpm: number;
  tempoConfidence: number;
  key: {
    pitchClass: number;
    mode: 'major' | 'minor';
    confidence: number;
  } | null;
};
const major = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const minor = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];
const correlation = (a: number[], b: number[]) => {
  const am = a.reduce((x, y) => x + y, 0) / 12,
    bm = b.reduce((x, y) => x + y, 0) / 12;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < 12; i++) {
    dot += (a[i] - am) * (b[i] - bm);
    aa += (a[i] - am) ** 2;
    bb += (b[i] - bm) ** 2;
  }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : 0;
};
export function analyseFrames(input: readonly Frame[]): Analysis {
  const frames = input.slice(-MAX_FRAMES);
  const result: Analysis = { bpm: 0, tempoConfidence: 0, key: null };
  if (
    frames.length < 160 ||
    frames.some(
      (f) =>
        !Number.isFinite(f.energy) ||
        f.energy < 0 ||
        f.chroma.length !== 12 ||
        f.chroma.some((v) => !Number.isFinite(v) || v < 0),
    )
  )
    return result;
  const onset = frames.map((f, i) =>
    i
      ? Math.max(
          0,
          Math.log1p(1000 * f.energy) - Math.log1p(1000 * frames[i - 1].energy),
        )
      : 0,
  );
  const mean = onset.reduce((a, b) => a + b, 0) / onset.length;
  const centered = onset.map((v) => v - mean);
  const ac = (lag: number) => {
    let sum = 0;
    for (let i = lag; i < centered.length; i++)
      sum += centered[i] * centered[i - lag];
    return sum / (centered.length - lag);
  };
  const zero = ac(0);
  let score = -Infinity;
  if (zero > 1e-10)
    for (let lag = 6; lag <= 20; lag++) {
      const bpm = (60 * FPS) / lag,
        octave = Math.log2(bpm / 120),
        prior = Math.exp(-0.5 * Math.pow(octave, 2)),
        doublePeak = 0.5 * ac(lag * 2),
        raw = ac(lag) + doublePeak,
        value = raw * prior;
      if (value > score) {
        score = value;
        result.bpm = bpm;
        result.tempoConfidence = Math.max(0, Math.min(1, ac(lag) / zero));
      }
    }
  if (result.tempoConfidence < 0.3) {
    result.bpm = 0;
    result.tempoConfidence = 0;
  }
  const chroma = Array.from({ length: 12 }, (_, i) =>
    frames.reduce((sum, f) => sum + f.chroma[i], 0),
  );
  for (let tonic = 0; tonic < 12; tonic++)
    for (const mode of ['major', 'minor'] as const) {
      const profile = mode === 'major' ? major : minor;
      const confidence = correlation(
        chroma,
        profile.map((_, i) => profile[(i - tonic + 12) % 12]),
      );
      if (
        confidence >= 0.55 &&
        (!result.key || confidence > result.key.confidence)
      )
        result.key = { pitchClass: tonic, mode, confidence };
    }
  return result;
}
export function planAutoMix(
  analysis: Analysis,
  options: { blendBeats: number; maxSeconds: number },
): CrossfadePluginConfig {
  const max = Math.max(
    1,
    Math.min(8, Number.isFinite(options.maxSeconds) ? options.maxSeconds : 6),
  );
  const beats = options.blendBeats === 4 ? 4 : 8;
  // Unknown incoming harmony: shorten overlap for a clearly tonal outgoing passage.
  const count = analysis.key ? Math.min(4, beats) : beats;
  const seconds =
    analysis.bpm >= 60 && analysis.bpm <= 200 && analysis.tempoConfidence >= 0.3
      ? (count * 60) / analysis.bpm
      : Math.min(3, max);
  const fade = Math.round(Math.max(1, Math.min(max, seconds)) * 1000);
  const lead = fade / 1000;
  return {
    enabled: true,
    fadeInDuration: fade,
    fadeOutDuration: fade,
    secondsBeforeEnd: lead + 0.5,
    fadeScaling: 'equalPower',
  };
}
