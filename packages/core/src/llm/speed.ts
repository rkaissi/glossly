import type { Speed } from './catalog';

/** One successful call: how long it took and how many tokens it wrote. */
export interface SpeedSample {
  ms: number;
  output: number;
}

/** Calls needed before a model's measured speed replaces its listed one (decision 79). */
export const MIN_SPEED_SAMPLES = 10;
/** Only the latest calls count, so a provider that got faster or slower shows it. */
export const MAX_SPEED_SAMPLES = 50;
/** The answer length the speed is judged at: a typical Ask or Reply answer. */
const TYPICAL_OUTPUT = 300;
/** At or under these times for a typical answer a model counts as fast, then medium. */
const LIMITS_MS = { fast: 3_000, medium: 8_000 };

/**
 * A model's speed from its recent calls (decision 79), or null with too few. Fits
 * ms = wait + output × per-token time over the samples, so short structured answers and long
 * streamed ones are judged alike, then times a typical answer. When the samples can't separate
 * the two (all about the same length), the median time per call stands in.
 */
export function measuredSpeed(samples: SpeedSample[]): Speed | null {
  const s = samples.filter((x) => Number.isFinite(x.ms) && x.ms > 0 && Number.isFinite(x.output) && x.output >= 0).slice(-MAX_SPEED_SAMPLES);
  if (s.length < MIN_SPEED_SAMPLES) return null;
  const n = s.length;
  const mx = s.reduce((a, x) => a + x.output, 0) / n;
  const my = s.reduce((a, x) => a + x.ms, 0) / n;
  const sxx = s.reduce((a, x) => a + (x.output - mx) ** 2, 0);
  const sxy = s.reduce((a, x) => a + (x.output - mx) * (x.ms - my), 0);
  let typical: number;
  // Lengths spread enough (a standard deviation of 20 tokens or more) and a sensible slope.
  if (sxx / n >= 400 && sxy > 0) {
    const perToken = sxy / sxx;
    const wait = Math.max(0, my - perToken * mx);
    typical = wait + perToken * TYPICAL_OUTPUT;
  } else {
    const sorted = s.map((x) => x.ms).sort((a, b) => a - b);
    typical = sorted[n >> 1]!;
  }
  return typical <= LIMITS_MS.fast ? 'fast' : typical <= LIMITS_MS.medium ? 'medium' : 'slow';
}
