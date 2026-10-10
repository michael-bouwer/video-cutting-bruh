import type { TransitionType } from "../types";
import { ease } from "./keyframes";

export const TRANSITIONS: { key: TransitionType; label: string }[] = [
  { key: "cut", label: "Cut (none)" },
  { key: "crossfade", label: "Crossfade" },
  { key: "dipToBlack", label: "Dip to black" },
  { key: "wipeLeft", label: "Wipe left" },
  { key: "wipeRight", label: "Wipe right" },
  { key: "slideLeft", label: "Slide left" },
  { key: "slideUp", label: "Slide up" },
  { key: "iris", label: "Iris" },
];

export const transitionLabel = (t: TransitionType) => TRANSITIONS.find((x) => x.key === t)?.label ?? t;

/** Draws a clip. `alpha` multiplies the clip's own opacity. */
export type DrawFn = (ctx: CanvasRenderingContext2D, alpha: number) => void;

/**
 * Composites the outgoing clip `a` into the incoming clip `b` at progress `p` (0..1).
 * The canvas is expected to be cleared to black beforehand.
 */
export function renderTransition(
  type: TransitionType,
  ctx: CanvasRenderingContext2D,
  a: DrawFn,
  b: DrawFn,
  p: number,
  w: number,
  h: number,
) {
  switch (type) {
    case "cut":
      b(ctx, 1);
      return;
    case "crossfade":
      a(ctx, 1);
      b(ctx, p);
      return;
    case "dipToBlack":
      if (p < 0.5) a(ctx, 1 - p * 2);
      else b(ctx, (p - 0.5) * 2);
      return;
    case "wipeLeft":
    case "wipeRight": {
      a(ctx, 1);
      const edge = w * p;
      ctx.save();
      ctx.beginPath();
      if (type === "wipeLeft") ctx.rect(w - edge, 0, edge, h);
      else ctx.rect(0, 0, edge, h);
      ctx.clip();
      b(ctx, 1);
      ctx.restore();
      return;
    }
    case "slideLeft":
    case "slideUp": {
      const e = ease("easeInOut", p);
      const [dx, dy] = type === "slideLeft" ? [w, 0] : [0, h];
      ctx.save();
      ctx.translate(-dx * e, -dy * e);
      a(ctx, 1);
      ctx.restore();
      ctx.save();
      ctx.translate(dx * (1 - e), dy * (1 - e));
      b(ctx, 1);
      ctx.restore();
      return;
    }
    case "iris": {
      a(ctx, 1);
      ctx.save();
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, (Math.hypot(w, h) / 2) * ease("easeInOut", p), 0, Math.PI * 2);
      ctx.clip();
      b(ctx, 1);
      ctx.restore();
      return;
    }
  }
}

/** Audio gains for (outgoing, incoming) during a transition. */
export function transitionGains(type: TransitionType, p: number): [number, number] {
  if (type === "cut") return [0, 1];
  if (type === "dipToBlack") return p < 0.5 ? [1 - p * 2, 0] : [0, (p - 0.5) * 2];
  return [1 - p, p];
}
