import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { Clip, MediaItem } from "../types";
import { sourceTime } from "../lib/speed";
import { clipBeats } from "../lib/snapExtras";
import { useVisuals, type ThumbStrip, type Waveform } from "../lib/visuals";

/** Visible part of the timeline lanes (scroll position and width), updated by the Timeline. */
export const useLaneViewport = create<{ scrollLeft: number; width: number }>(() => ({ scrollLeft: 0, width: 1600 }));

const images = new Map<string, HTMLImageElement>();
/** Loads (once) an image for drawing; `onLoad` runs when it becomes ready. */
function imageFor(url: string, onLoad: () => void): HTMLImageElement | null {
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    images.set(url, img);
  }
  if (img.complete && img.naturalWidth) return img;
  img.addEventListener("load", onLoad, { once: true });
  return null;
}

/** Margin drawn beyond the visible area, so short scrolls don't show blank space. */
const MARGIN = 300;

/**
 * Canvas behind a clip's label: thumbnails (video/stills) or a waveform
 * (audio), plus beat ticks on music tracks. Only the part of the clip that's
 * on screen is drawn, so long clips at high zoom stay cheap.
 */
export function ClipVisual({
  clip,
  media,
  zoom,
  width,
  height,
  kind,
  beats,
}: {
  clip: Clip;
  media: MediaItem | undefined;
  zoom: number;
  width: number;
  height: number;
  kind: "video" | "audio";
  beats: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { scrollLeft, width: viewW } = useLaneViewport();
  const wave = useVisuals((s) => (media ? s.waves[media.id] : undefined));
  const thumbs = useVisuals((s) => (media ? s.thumbs[media.id] : undefined));
  const left = clip.start * zoom;
  const x0 = Math.max(0, Math.floor(scrollLeft - left - MARGIN));
  const x1 = Math.min(width, Math.ceil(scrollLeft + viewW - left + MARGIN));
  const w = Math.max(0, x1 - x0);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || w <= 0 || height <= 0) return;
    let cancelled = false;
    const draw = () => {
      if (cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, height);
      // Clip-local time at a canvas x.
      const localAt = (x: number) => (x0 + x) / zoom;
      if (kind === "video") {
        if (thumbs) drawThumbs(ctx, thumbs, clip, localAt, w, height, x0, draw);
        else if (media?.kind === "image" && media.status === "ready") drawStill(ctx, media.src, w, height, x0, draw);
      } else if (wave) {
        drawWave(ctx, wave, clip, localAt, w, height);
      }
      if (beats) {
        ctx.fillStyle = "rgba(255, 210, 80, 0.9)";
        for (const t of clipBeats(clip)) {
          const x = (t - clip.start) * zoom - x0;
          if (x >= 0 && x <= w) ctx.fillRect(Math.round(x), height - 7, 1.5, 7);
        }
      }
    };
    draw();
    return () => {
      cancelled = true;
    };
  }, [clip, media, zoom, x0, w, height, kind, wave, thumbs, beats]);

  if (w <= 0) return null;
  return <canvas ref={ref} className={`clip-visual ${kind}`} style={{ left: x0, width: w, height }} aria-hidden />;
}

function drawThumbs(
  ctx: CanvasRenderingContext2D,
  t: ThumbStrip,
  clip: Clip,
  localAt: (x: number) => number,
  w: number,
  h: number,
  x0: number,
  redraw: () => void,
) {
  const img = imageFor(t.url, redraw);
  if (!img) return;
  const tileW = (t.tileW / t.tileH) * h;
  // Tiles are laid out from the clip's start, so they don't swim while scrolling.
  const first = Math.floor(x0 / tileW);
  for (let k = first; (k - first) * tileW < w + tileW; k++) {
    const x = k * tileW - x0;
    // The frame at the middle of the tile.
    const src = sourceTime(clip, localAt(x + tileW / 2));
    const i = Math.max(0, Math.min(t.count - 1, Math.floor(src / t.interval)));
    const sx = (i % t.cols) * t.tileW;
    const sy = Math.floor(i / t.cols) * t.tileH;
    ctx.drawImage(img, sx, sy, t.tileW, t.tileH, x, 0, tileW, h);
  }
}

function drawStill(ctx: CanvasRenderingContext2D, url: string, w: number, h: number, x0: number, redraw: () => void) {
  const img = imageFor(url, redraw);
  if (!img) return;
  const tileW = (img.naturalWidth / img.naturalHeight) * h;
  const first = Math.floor(x0 / tileW);
  for (let k = first; (k - first) * tileW < w + tileW; k++) ctx.drawImage(img, k * tileW - x0, 0, tileW, h);
}

function drawWave(ctx: CanvasRenderingContext2D, wave: Waveform, clip: Clip, localAt: (x: number) => number, w: number, h: number) {
  const mid = h * 0.62;
  const amp = h * 0.36;
  ctx.fillStyle = getComputedStyle(ctx.canvas).color || "#9fe0b8";
  ctx.globalAlpha = 0.8;
  for (let x = 0; x < w; x++) {
    // Peak over the source covered by this pixel column (speed-aware).
    const a = Math.floor(sourceTime(clip, localAt(x)) * wave.rate);
    const b = Math.max(a + 1, Math.floor(sourceTime(clip, localAt(x + 1)) * wave.rate));
    let p = 0;
    for (let i = Math.max(0, a); i < Math.min(wave.peaks.length, b); i++) p = Math.max(p, wave.peaks[i]);
    if (p === 0) continue;
    // Square-root scale makes quiet passages visible without loud ones clipping.
    const y = Math.sqrt(p / 255) * amp;
    ctx.fillRect(x, mid - y, 1, y * 2);
  }
  ctx.globalAlpha = 1;
}
