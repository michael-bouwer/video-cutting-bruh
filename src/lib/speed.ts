import type { Clip } from "../types";
import { interpolate } from "./keyframes";
import { SPEED_MAX, SPEED_MIN } from "./props";

/**
 * Speed and speed ramps: mapping between a clip's local timeline time and its
 * source time.
 *
 * `speed` is an animatable property in %, keyframed in clip-local *timeline*
 * time. The source position at local time t is
 *   trimIn + ∫₀ᵗ speed(u) du,
 * and the clip's length on the timeline is the t at which that integral covers
 * the trimmed span (trimOut − trimIn). Before the first / after the last
 * keyframe the speed is constant, so the mapping extends to negative times
 * (transition handles, extending a trim) and past the end.
 */

export interface TimeMap {
  /** Seconds of source covered (trimOut − trimIn). */
  span: number;
  /** Length on the timeline. */
  duration: number;
  /** Source offset (from trimIn) at clip-local time t. */
  src: (t: number) => number;
  /** Clip-local time at source offset o (inverse of `src`). */
  local: (o: number) => number;
  /** Speed factor (1 = normal) at clip-local time t. */
  speedAt: (t: number) => number;
  /** True when the speed is the same everywhere. */
  constant: boolean;
}

const clampSpeed = (pct: number) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, pct)) / 100;

const cache = new WeakMap<Clip, TimeMap>();

export function timeMap(c: Clip): TimeMap {
  let tm = cache.get(c);
  if (!tm) {
    tm = build(c);
    cache.set(c, tm);
  }
  return tm;
}

/** Source time (seconds into the file) at clip-local time t. */
export const sourceTime = (c: Clip, t: number) => c.trimIn + timeMap(c).src(t);

/** Trimmed span shown by the clip, in source seconds. */
export const sourceSpan = (c: Clip) => Math.max(0, c.trimOut - c.trimIn);

function build(c: Clip): TimeMap {
  const span = sourceSpan(c);
  const kfs = c.keyframes?.speed ?? [];
  const base = c.base?.speed ?? 100;
  if (kfs.length === 0) {
    const s = clampSpeed(base);
    return { span, duration: span / s, src: (t) => t * s, local: (o) => o / s, speedAt: () => s, constant: true };
  }

  const speedAt = (t: number) => clampSpeed(interpolate(kfs, base, t));
  // Cumulative integral C(t) sampled between the first and last keyframe; constant speed outside.
  const t0 = kfs[0].t;
  const t1 = kfs[kfs.length - 1].t;
  const v0 = speedAt(t0 - 1);
  const v1 = speedAt(t1 + 1);
  const ts: number[] = [t0];
  const cs: number[] = [0];
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i].t;
    const b = kfs[i + 1].t;
    if (b - a < 1e-9) continue;
    const n = 48;
    for (let j = 1; j <= n; j++) {
      const x0 = a + ((b - a) * (j - 1)) / n;
      const x1 = a + ((b - a) * j) / n;
      // Simpson's rule per sub-step.
      const area = ((x1 - x0) / 6) * (speedAt(x0) + 4 * speedAt((x0 + x1) / 2) + speedAt(x1));
      ts.push(x1);
      cs.push(cs[cs.length - 1] + area);
    }
  }
  const cEnd = cs[cs.length - 1];
  const C = (t: number): number => {
    if (t <= t0) return (t - t0) * v0;
    if (t >= t1) return cEnd + (t - t1) * v1;
    let lo = 0;
    let hi = ts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] <= t) lo = mid;
      else hi = mid;
    }
    const f = (t - ts[lo]) / (ts[hi] - ts[lo] || 1);
    return cs[lo] + (cs[hi] - cs[lo]) * f;
  };
  const Cinv = (y: number): number => {
    if (y <= 0) return t0 + y / v0;
    if (y >= cEnd) return t1 + (y - cEnd) / v1;
    let lo = 0;
    let hi = cs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cs[mid] <= y) lo = mid;
      else hi = mid;
    }
    const f = (y - cs[lo]) / (cs[hi] - cs[lo] || 1);
    return ts[lo] + (ts[hi] - ts[lo]) * f;
  };
  const c0 = C(0);
  const src = (t: number) => C(t) - c0;
  const local = (o: number) => Cinv(o + c0);
  return { span, duration: local(span), src, local, speedAt, constant: false };
}

/** Speed range a clip uses over its length (for UI and audio tempo limits). */
export function speedRange(c: Clip): [number, number] {
  const tm = timeMap(c);
  if (tm.constant) return [tm.speedAt(0), tm.speedAt(0)];
  // Keyframe values exactly, plus samples in between (eased curves can overshoot).
  const inClip = (c.keyframes.speed ?? []).filter((k) => k.t >= 0 && k.t <= tm.duration).map((k) => tm.speedAt(k.t));
  let lo = Math.min(Infinity, ...inClip);
  let hi = Math.max(0, ...inClip);
  const n = 200;
  for (let i = 0; i <= n; i++) {
    const s = tm.speedAt((tm.duration * i) / n);
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  return [lo, hi];
}

/** True if the clip plays at anything other than normal speed. */
export const hasSpeedChange = (c: Clip) => (c.keyframes?.speed?.length ?? 0) > 0 || Math.abs((c.base?.speed ?? 100) - 100) > 1e-6;

/**
 * ffmpeg audio filters that retime a clip's audio (pitch preserved), for its
 * source segment starting at trimIn: an `atempo` chain, driven by an asendcmd
 * file (`cmds`, times in seconds from the segment start) for speed ramps.
 * `name` makes the filter instance unique within a graph.
 */
export function audioTempo(c: Clip, name: string): { filters: string[]; cmds: string | null } {
  if (!hasSpeedChange(c)) return { filters: [], cmds: null };
  const tm = timeMap(c);
  const fmt = (n: number) => n.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
  if (tm.constant) {
    // atempo takes 0.5–100 per instance; chain halves for slower speeds.
    let s = tm.speedAt(0);
    const filters: string[] = [];
    while (s < 0.5) {
      filters.push("atempo=0.5");
      s /= 0.5;
    }
    filters.push(`atempo=${fmt(Math.min(100, s))}`);
    return { filters, cmds: null };
  }
  const [lo] = speedRange(c);
  // Fixed ×0.5 stages so the commanded stage stays within atempo's range.
  let stages = 0;
  while (lo / 0.5 ** stages < 0.5 && stages < 4) stages++;
  const k = 0.5 ** stages;
  const target = `atempo@${name}`;
  const lines: string[] = [];
  let last = "";
  // Sampled along the *source* (asendcmd sees source timestamps), 20× a second.
  for (let o = 0; o <= tm.span + 1e-9; o += 0.05) {
    const v = fmt(Math.min(100, Math.max(0.5, tm.speedAt(tm.local(o)) / k)));
    if (v !== last) lines.push(`${o.toFixed(4)} ${target} tempo ${v};`);
    last = v;
  }
  const first = Math.min(100, Math.max(0.5, tm.speedAt(0) / k));
  return {
    filters: [`asendcmd=f=${name}.cmd`, ...Array(stages).fill("atempo=0.5"), `${target}=tempo=${fmt(first)}`],
    cmds: lines.join("\n") + "\n",
  };
}
