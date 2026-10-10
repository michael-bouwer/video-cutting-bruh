import type { AnimProp, Clip, Easing, Effect, Keyframe } from "../types";
import { PROP_KEYS } from "./props";

export const EASINGS: { key: Easing; label: string }[] = [
  { key: "linear", label: "Linear" },
  { key: "easeIn", label: "Ease in" },
  { key: "easeOut", label: "Ease out" },
  { key: "easeInOut", label: "Ease in-out" },
  { key: "hold", label: "Hold" },
];

/** A random, readable keyframe colour (varied hue, fixed saturation/lightness). */
export function randomKeyframeColor(): string {
  return `hsl(${Math.floor(Math.random() * 360)} 85% 62%)`;
}

/** A keyframe's colour; older projects without one get a stable colour from the id. */
export function keyframeColor(kf: Keyframe): string {
  if (kf.color) return kf.color;
  let h = 0;
  for (const ch of kf.id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 85% 62%)`;
}

export function ease(kind: Easing, p: number): number {
  switch (kind) {
    case "linear":
      return p;
    case "easeIn":
      return p * p * p;
    case "easeOut":
      return 1 - Math.pow(1 - p, 3);
    case "easeInOut":
      return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    case "hold":
      return 0;
  }
}

/** Interpolated value of a keyframe track at clip-local time `t` (`base` if it has no keyframes). */
export function interpolate(kfs: Keyframe[], base: number, t: number): number {
  if (kfs.length === 0) return base;
  if (t <= kfs[0].t) return kfs[0].v;
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (t >= a.t && t < b.t) {
      const p = ease(a.ease, (t - a.t) / (b.t - a.t));
      return a.v + (b.v - a.v) * p;
    }
  }
  return last.v;
}

/** Interpolated value of `prop` at clip-local time `t`. */
export function valueAt(clip: Clip, prop: AnimProp, t: number): number {
  return interpolate(clip.keyframes[prop], clip.base[prop], t);
}

/** Value of an effect parameter at clip-local time `t`. */
export function effectValueAt(fx: Effect, key: string, t: number): number {
  return interpolate(fx.keyframes[key] ?? [], fx.params[key] ?? 0, t);
}

export function transformAt(clip: Clip, t: number): Record<AnimProp, number> {
  return Object.fromEntries(PROP_KEYS.map((k) => [k, valueAt(clip, k, t)])) as Record<AnimProp, number>;
}

/** Keyframe within half a frame of `t`, if any. */
export function keyframeNear(kfs: Keyframe[], t: number, fps: number): Keyframe | undefined {
  const tol = 0.5 / fps;
  return kfs.find((k) => Math.abs(k.t - t) <= tol);
}

export function sortKeyframes(kfs: Keyframe[]): Keyframe[] {
  return [...kfs].sort((a, b) => a.t - b.t);
}
