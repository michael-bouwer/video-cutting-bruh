import { useStore } from "../store";
import type { AnimProp, Clip, MediaItem } from "../types";
import { transformAt } from "../lib/keyframes";
import { frameAt, layoutClips, type Layout, type PlacedClip } from "../lib/timeline";
import { renderTransition, transitionGains } from "../lib/transitions";

/** Seconds before a clip's start at which its video is pre-seeked during playback. */
const PREROLL = 0.4;
/** Allowed drift between the timeline clock and a playing video before re-seeking. */
const MAX_DRIFT = 0.25;

/**
 * Preview engine: owns one <video> per timeline clip (so two clips of the same
 * file can show different frames during a transition), keeps them in sync with
 * the store's clock and composites the current frame onto a canvas.
 */
class Player {
  private videos = new Map<string, HTMLVideoElement>();
  private host: HTMLDivElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private raf = 0;
  private last = 0;

  constructor() {
    // Videos must stay in the DOM (and technically visible) or some webviews
    // (WebKit in particular) stop decoding frames.
    this.host = document.createElement("div");
    Object.assign(this.host.style, {
      position: "fixed",
      right: "0",
      bottom: "0",
      width: "2px",
      height: "2px",
      opacity: "0.01",
      overflow: "hidden",
      pointerEvents: "none",
    });
    document.body.appendChild(this.host);
  }

  attach(canvas: HTMLCanvasElement, colorSpace: PredefinedColorSpace) {
    this.ctx = canvas.getContext("2d", { alpha: false, colorSpace }) as CanvasRenderingContext2D | null;
    if (this.ctx) {
      // Default smoothing is "low" (bilinear), which looks soft when frames are scaled.
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = "high";
    }
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  detach(canvas: HTMLCanvasElement) {
    if (this.ctx?.canvas === canvas) this.ctx = null;
  }

  private videoFor(clip: Clip, media: MediaItem): HTMLVideoElement {
    let v = this.videos.get(clip.id);
    if (!v) {
      v = document.createElement("video");
      v.preload = "auto";
      v.playsInline = true;
      v.width = 2;
      v.height = 2;
      this.host.appendChild(v);
      this.videos.set(clip.id, v);
    }
    if (v.dataset.src !== media.src) {
      v.dataset.src = media.src;
      v.src = media.src;
    }
    return v;
  }

  private gc(clips: Clip[]) {
    const live = new Set(clips.map((c) => c.id));
    for (const [id, v] of this.videos) {
      if (live.has(id)) continue;
      v.pause();
      v.removeAttribute("src");
      v.load();
      v.remove();
      this.videos.delete(id);
    }
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;

    const state = useStore.getState();
    const layout = layoutClips(state.clips);
    let t = state.currentTime;
    if (state.playing) {
      t += dt;
      if (t >= layout.total) {
        t = layout.total;
        useStore.setState({ currentTime: t, playing: false });
      } else {
        useStore.setState({ currentTime: t });
      }
    }

    this.gc(state.clips);
    const mediaById = new Map(state.media.map((m) => [m.id, m]));
    this.sync(layout, t, useStore.getState().playing, mediaById, state.settings.fps);
    this.draw(layout, t, state.settings.width, state.settings.height, mediaById);
  };

  private sync(layout: Layout, t: number, playing: boolean, media: Map<string, MediaItem>, fps: number) {
    const frame = frameAt(layout, t);
    const [gainOut, gainIn] = frame.outgoing
      ? transitionGains(frame.current!.clip.transitionIn.type, frame.progress)
      : [0, 1];

    for (const p of layout.items) {
      const m = media.get(p.clip.mediaId);
      if (!m || m.status !== "ready" || m.kind === "image") continue;
      const v = this.videoFor(p.clip, m);
      const near = t >= p.start - (playing ? PREROLL : 0) && t < p.end;
      if (!near) {
        if (!v.paused) v.pause();
        continue;
      }
      const local = Math.min(Math.max(0, t - p.start), p.duration - 0.001);
      const src = p.clip.trimIn + local;
      v.volume = p === frame.current ? gainIn : p === frame.outgoing ? gainOut : 0;

      if (playing && t >= p.start) {
        if (v.paused) {
          v.currentTime = src;
          v.play().catch(() => {});
        } else if (Math.abs(v.currentTime - src) > MAX_DRIFT) {
          v.currentTime = src;
        }
      } else {
        if (!v.paused) v.pause();
        if (!v.seeking && Math.abs(v.currentTime - src) > 0.5 / fps) v.currentTime = src;
      }
    }
  }

  /** Decoded stills, keyed by URL. */
  private images = new Map<string, HTMLImageElement>();

  private imageFor(m: MediaItem): HTMLImageElement {
    let img = this.images.get(m.src);
    if (!img) {
      img = new Image();
      img.decoding = "async";
      img.src = m.src;
      this.images.set(m.src, img);
    }
    return img;
  }

  private draw(layout: Layout, t: number, w: number, h: number, media: Map<string, MediaItem>) {
    const ctx = this.ctx;
    if (!ctx) return;
    const canvas = ctx.canvas;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      // Resizing a canvas resets its context state.
      ctx.imageSmoothingQuality = "high";
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    const frame = frameAt(layout, t);
    if (!frame.current) return;
    const drawer = (p: PlacedClip) => (c: CanvasRenderingContext2D, alpha: number) => {
      const m = media.get(p.clip.mediaId);
      if (m?.kind === "image") {
        if (m.status !== "ready") return;
        const img = this.imageFor(m);
        if (img.complete && img.naturalWidth) drawSource(c, img, img.naturalWidth, img.naturalHeight, transformAt(p.clip, t - p.start), alpha, w, h);
        return;
      }
      const v = this.videos.get(p.clip.id);
      if (v && v.readyState >= 2 && v.videoWidth) drawSource(c, v, v.videoWidth, v.videoHeight, transformAt(p.clip, t - p.start), alpha, w, h);
    };
    if (frame.outgoing) {
      renderTransition(frame.current.clip.transitionIn.type, ctx, drawer(frame.outgoing), drawer(frame.current), frame.progress, w, h);
    } else {
      drawer(frame.current)(ctx, 1);
    }
  }
}

/** Draws a video frame or still, fitted ("contain") into the frame, with the clip transform. */
function drawSource(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  tr: Record<AnimProp, number>,
  alpha: number,
  w: number,
  h: number,
) {
  const a = (tr.opacity / 100) * alpha;
  if (a <= 0) return;
  // Fit into the frame, then apply the clip transform around the frame centre.
  const fit = Math.min(w / sw, h / sh);
  const dw = sw * fit;
  const dh = sh * fit;
  const s = tr.scale / 100;
  ctx.save();
  ctx.globalAlpha = Math.min(1, a);
  ctx.translate(w / 2 + (tr.x / 100) * w, h / 2 + (tr.y / 100) * h);
  ctx.rotate((tr.rotation * Math.PI) / 180);
  ctx.scale(s, s);
  ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

export const player = new Player();
