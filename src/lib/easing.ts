import type { Easing } from "../types";

/**
 * Timing curves, CSS-style: every easing is a cubic Bézier from (0,0) to (1,1)
 * with two control points (x1,y1) and (x2,y2) — exactly like CSS
 * `cubic-bezier()` — except "hold", which is a step. y may leave 0..1 for
 * overshoot ("back") curves.
 */
export type Bezier = [number, number, number, number];

export interface EasingPreset {
  key: Exclude<Easing, "custom">;
  label: string;
  /** null for "hold" (step). */
  curve: Bezier | null;
}

export const EASING_PRESETS: EasingPreset[] = [
  { key: "linear", label: "Linear", curve: [0, 0, 1, 1] },
  { key: "ease", label: "Ease", curve: [0.25, 0.1, 0.25, 1] },
  { key: "easeIn", label: "Ease in", curve: [0.42, 0, 1, 1] },
  { key: "easeOut", label: "Ease out", curve: [0, 0, 0.58, 1] },
  { key: "easeInOut", label: "Ease in-out", curve: [0.42, 0, 0.58, 1] },
  { key: "easeInExpo", label: "Expo in", curve: [0.7, 0, 0.84, 0] },
  { key: "easeOutExpo", label: "Expo out", curve: [0.16, 1, 0.3, 1] },
  { key: "easeInBack", label: "Back in", curve: [0.36, 0, 0.66, -0.56] },
  { key: "easeOutBack", label: "Back out", curve: [0.34, 1.56, 0.64, 1] },
  { key: "easeInOutBack", label: "Back in-out", curve: [0.68, -0.6, 0.32, 1.6] },
  { key: "hold", label: "Hold", curve: null },
];

export const easingLabel = (e: Easing) => (e === "custom" ? "Custom" : (EASING_PRESETS.find((p) => p.key === e)?.label ?? e));

/** Control points for an easing (custom uses `curve`); null = hold/step. */
export function bezierOf(e: Easing, curve?: Bezier): Bezier | null {
  if (e === "custom") return curve ?? [0.25, 0.1, 0.25, 1];
  const preset = EASING_PRESETS.find((p) => p.key === e);
  return preset ? preset.curve : [0, 0, 1, 1];
}

/** CSS timing function for previews (`animation-timing-function`). */
export function cssTiming(e: Easing, curve?: Bezier): string {
  const b = bezierOf(e, curve);
  return b ? `cubic-bezier(${b.map((n) => +n.toFixed(3)).join(", ")})` : "steps(1, end)";
}

/** Evaluates a cubic Bézier timing curve at x (0..1), like the browser does for CSS. */
export function solveBezier([x1, y1, x2, y2]: Bezier, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x1 === y1 && x2 === y2) return x; // linear
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  // Newton–Raphson, then bisection if it doesn't converge.
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sx(t) - x;
    if (Math.abs(err) < 1e-6) return sy(t);
    const d = dx(t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 40; i++) {
    const v = sx(t);
    if (Math.abs(v - x) < 1e-6) break;
    if (v < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return sy(t);
}

/** Eased progress for p in 0..1. */
export function applyEasing(e: Easing, p: number, curve?: Bezier): number {
  const b = bezierOf(e, curve);
  if (!b) return p >= 1 ? 1 : 0; // hold until the next keyframe
  return solveBezier(b, p);
}
