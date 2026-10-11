import type { Transition, TransitionType } from "../types";
import { applyEasing } from "./easing";

export const TRANSITIONS: { key: TransitionType; label: string; group: string }[] = [
  { key: "cut", label: "Cut (none)", group: "Basic" },
  { key: "crossfade", label: "Crossfade", group: "Basic" },
  { key: "blurDissolve", label: "Blur dissolve", group: "Basic" },
  { key: "dipToBlack", label: "Dip to black", group: "Basic" },
  { key: "dipToWhite", label: "Dip to white", group: "Basic" },
  { key: "wipeLeft", label: "Wipe left", group: "Wipe" },
  { key: "wipeRight", label: "Wipe right", group: "Wipe" },
  { key: "wipeUp", label: "Wipe up", group: "Wipe" },
  { key: "wipeDown", label: "Wipe down", group: "Wipe" },
  { key: "diagonal", label: "Diagonal wipe", group: "Wipe" },
  { key: "clockWipe", label: "Clock wipe", group: "Wipe" },
  { key: "barnDoorH", label: "Barn doors (open sideways)", group: "Wipe" },
  { key: "barnDoorV", label: "Barn doors (open up/down)", group: "Wipe" },
  { key: "iris", label: "Iris", group: "Wipe" },
  { key: "slideLeft", label: "Push left", group: "Motion" },
  { key: "slideRight", label: "Push right", group: "Motion" },
  { key: "slideUp", label: "Push up", group: "Motion" },
  { key: "slideDown", label: "Push down", group: "Motion" },
  { key: "coverLeft", label: "Cover from right", group: "Motion" },
  { key: "coverRight", label: "Cover from left", group: "Motion" },
  { key: "revealLeft", label: "Reveal (slide out left)", group: "Motion" },
  { key: "revealRight", label: "Reveal (slide out right)", group: "Motion" },
  { key: "zoomIn", label: "Zoom in", group: "Motion" },
  { key: "zoomOut", label: "Zoom out", group: "Motion" },
];

export const transitionLabel = (t: TransitionType) => TRANSITIONS.find((x) => x.key === t)?.label ?? t;

/** Transition progress after its timing curve (default ease in-out). */
export function easedProgress(tr: Transition, p: number): number {
  return applyEasing(tr.ease ?? "easeInOut", Math.min(1, Math.max(0, p)), tr.curve);
}

/** Draws a clip. `alpha` multiplies the clip's own opacity. */
export type DrawFn = (ctx: CanvasRenderingContext2D, alpha: number) => void;

const withClip = (ctx: CanvasRenderingContext2D, path: () => void, draw: () => void) => {
  ctx.save();
  ctx.beginPath();
  path();
  ctx.clip();
  draw();
  ctx.restore();
};

const withTransform = (ctx: CanvasRenderingContext2D, fn: () => void, draw: () => void) => {
  ctx.save();
  fn();
  draw();
  ctx.restore();
};

/** Scales around the frame centre. */
const zoomAround = (ctx: CanvasRenderingContext2D, w: number, h: number, s: number) => {
  ctx.translate(w / 2, h / 2);
  ctx.scale(s, s);
  ctx.translate(-w / 2, -h / 2);
};

const veil = (ctx: CanvasRenderingContext2D, color: string, alpha: number, w: number, h: number) => {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
};

/**
 * Composites the outgoing clip `a` into the incoming clip `b` at (already eased)
 * progress `p`. Eased progress can overshoot 0..1 with "back" curves; each
 * transition copes with that (motion overshoots, opacity is clamped).
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
  const c = Math.max(0, Math.min(1, p)); // clamped, for opacity and masks
  switch (type) {
    case "cut":
      b(ctx, 1);
      return;
    case "crossfade":
      a(ctx, 1);
      b(ctx, c);
      return;
    case "blurDissolve": {
      // Both blur towards the middle while crossfading.
      const radius = Math.sin(c * Math.PI) * Math.max(w, h) * 0.012;
      ctx.save();
      ctx.filter = `blur(${radius.toFixed(2)}px)`;
      a(ctx, 1);
      b(ctx, c);
      ctx.restore();
      return;
    }
    case "dipToBlack":
    case "dipToWhite": {
      const color = type === "dipToBlack" ? "#000" : "#fff";
      if (c < 0.5) {
        a(ctx, 1);
        veil(ctx, color, c * 2, w, h);
      } else {
        b(ctx, 1);
        veil(ctx, color, (1 - c) * 2, w, h);
      }
      return;
    }
    case "wipeLeft":
      a(ctx, 1);
      return withClip(ctx, () => ctx.rect(w * (1 - c), 0, w * c, h), () => b(ctx, 1));
    case "wipeRight":
      a(ctx, 1);
      return withClip(ctx, () => ctx.rect(0, 0, w * c, h), () => b(ctx, 1));
    case "wipeUp":
      a(ctx, 1);
      return withClip(ctx, () => ctx.rect(0, h * (1 - c), w, h * c), () => b(ctx, 1));
    case "wipeDown":
      a(ctx, 1);
      return withClip(ctx, () => ctx.rect(0, 0, w, h * c), () => b(ctx, 1));
    case "diagonal": {
      // A diagonal edge sweeping from the top-left corner to the bottom-right.
      a(ctx, 1);
      const d = (w + h) * c;
      return withClip(
        ctx,
        () => {
          ctx.moveTo(0, 0);
          ctx.lineTo(Math.min(d, w), 0);
          if (d > w) ctx.lineTo(w, d - w);
          ctx.lineTo(Math.max(0, d - h), Math.min(d, h));
          if (d > h) ctx.lineTo(0, h);
          ctx.closePath();
        },
        () => b(ctx, 1),
      );
    }
    case "clockWipe": {
      a(ctx, 1);
      const r = Math.hypot(w, h);
      const start = -Math.PI / 2;
      return withClip(
        ctx,
        () => {
          ctx.moveTo(w / 2, h / 2);
          ctx.arc(w / 2, h / 2, r, start, start + Math.PI * 2 * c);
          ctx.closePath();
        },
        () => b(ctx, 1),
      );
    }
    case "barnDoorH":
      a(ctx, 1);
      return withClip(ctx, () => ctx.rect(w / 2 - (w / 2) * c, 0, w * c, h), () => b(ctx, 1));
    case "barnDoorV":
      a(ctx, 1);
      return withClip(ctx, () => ctx.rect(0, h / 2 - (h / 2) * c, w, h * c), () => b(ctx, 1));
    case "iris":
      a(ctx, 1);
      return withClip(ctx, () => ctx.arc(w / 2, h / 2, (Math.hypot(w, h) / 2) * c, 0, Math.PI * 2), () => b(ctx, 1));
    case "slideLeft":
    case "slideRight":
    case "slideUp":
    case "slideDown": {
      // Push: both clips move together.
      const [dx, dy] = { slideLeft: [-w, 0], slideRight: [w, 0], slideUp: [0, -h], slideDown: [0, h] }[type];
      withTransform(ctx, () => ctx.translate(dx * p, dy * p), () => a(ctx, 1));
      withTransform(ctx, () => ctx.translate(-dx * (1 - p), -dy * (1 - p)), () => b(ctx, 1));
      return;
    }
    case "coverLeft":
    case "coverRight": {
      // The new clip slides in over the old one, which stays put.
      const from = type === "coverLeft" ? w : -w;
      a(ctx, 1);
      withTransform(ctx, () => ctx.translate(from * (1 - p), 0), () => b(ctx, 1));
      return;
    }
    case "revealLeft":
    case "revealRight": {
      // The old clip slides away, uncovering the new one underneath.
      const to = type === "revealLeft" ? -w : w;
      b(ctx, 1);
      withTransform(ctx, () => ctx.translate(to * p, 0), () => a(ctx, 1));
      return;
    }
    case "zoomIn": {
      // Old clip grows and fades out; new clip settles in from slightly smaller.
      withTransform(ctx, () => zoomAround(ctx, w, h, 1 + p * 0.6), () => a(ctx, 1 - c));
      withTransform(ctx, () => zoomAround(ctx, w, h, 0.7 + p * 0.3), () => b(ctx, c));
      return;
    }
    case "zoomOut": {
      withTransform(ctx, () => zoomAround(ctx, w, h, 1 - p * 0.4), () => a(ctx, 1 - c));
      withTransform(ctx, () => zoomAround(ctx, w, h, 1.4 - p * 0.4), () => b(ctx, c));
      return;
    }
  }
}
