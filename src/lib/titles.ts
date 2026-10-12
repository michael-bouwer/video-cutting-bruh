import type { TitleStyle } from "../types";

/** Font choices: stacks that resolve to something sensible on Windows, macOS and Linux. */
export const TITLE_FONTS: { label: string; value: string }[] = [
  { label: "Sans (system)", value: "Inter, system-ui, 'Segoe UI', Roboto, sans-serif" },
  { label: "Arial", value: "Arial, Helvetica, 'Liberation Sans', sans-serif" },
  { label: "Impact", value: "Impact, 'Arial Black', 'Haettenschweiler', sans-serif" },
  { label: "Trebuchet", value: "'Trebuchet MS', 'DejaVu Sans', sans-serif" },
  { label: "Georgia (serif)", value: "Georgia, 'Times New Roman', 'Liberation Serif', serif" },
  { label: "Mono", value: "Consolas, 'Courier New', 'DejaVu Sans Mono', monospace" },
  { label: "Comic", value: "'Comic Sans MS', 'Comic Neue', cursive" },
];

const cache = new Map<string, HTMLCanvasElement>();

/**
 * A text clip rendered onto a transparent frame-sized canvas (w×h), centred.
 * Sizes in the style are pixels at 1080p and scale with `h`. The clip's
 * transform (position, scale, rotation, opacity, crop) applies on top, exactly
 * like an image the size of the frame.
 */
export function renderTitle(style: TitleStyle, w: number, h: number): HTMLCanvasElement {
  const key = `${JSON.stringify(style)}|${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const k = h / 1080;
  const size = Math.max(1, style.size * k);
  ctx.font = `${style.italic ? "italic " : ""}${style.bold ? 700 : 400} ${size}px ${style.font}`;
  ctx.textBaseline = "middle";
  const lines = (style.text || " ").split("\n");
  const lineH = size * 1.2;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const blockW = Math.max(...widths);
  const blockH = lineH * lines.length;
  const left = (w - blockW) / 2;
  const top = (h - blockH) / 2;

  if (style.box) {
    const pad = size * 0.3;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, style.boxOpacity / 100));
    ctx.fillStyle = style.boxColor;
    const r = size * 0.15;
    ctx.beginPath();
    ctx.roundRect(left - pad, top - pad * 0.6, blockW + pad * 2, blockH + pad * 1.2, r);
    ctx.fill();
    ctx.restore();
  }

  lines.forEach((line, i) => {
    const lw = widths[i];
    const x = style.align === "left" ? left : style.align === "right" ? left + blockW - lw : (w - lw) / 2;
    const y = top + lineH * (i + 0.5);
    ctx.save();
    if (style.shadow) {
      ctx.shadowColor = "rgba(0,0,0,0.65)";
      ctx.shadowBlur = size * 0.12;
      ctx.shadowOffsetY = size * 0.05;
    }
    if (style.outline > 0) {
      ctx.lineJoin = "round";
      ctx.lineWidth = style.outline * k * 2;
      ctx.strokeStyle = style.outlineColor;
      ctx.strokeText(line, x, y);
      // The fill shouldn't cast a second shadow over the outline.
      ctx.shadowColor = "transparent";
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, x, y);
    ctx.restore();
  });

  if (cache.size > 24) cache.delete(cache.keys().next().value!);
  cache.set(key, canvas);
  return canvas;
}

/** PNG bytes of a rendered title (for the original-files export). */
export async function titlePng(style: TitleStyle, w: number, h: number): Promise<Uint8Array> {
  const canvas = renderTitle(style, w, h);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't render text"))), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

/** One-line summary of a title for labels. */
export const titleSummary = (style: TitleStyle) => style.text.split("\n")[0].trim() || "Text";
