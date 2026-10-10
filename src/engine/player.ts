import { useStore } from "../store";
import type { AnimProp, Clip, MediaItem, Track } from "../types";
import { transformAt, valueAt } from "../lib/keyframes";
import { activeRange, clipDuration, timelineEnd, trackFrameAt } from "../lib/timeline";
import { renderTransition } from "../lib/transitions";

/** Seconds before a clip's start at which its media is pre-seeked during playback. */
const PREROLL = 0.4;
/** Allowed drift between the timeline clock and playing media before re-seeking. */
const MAX_DRIFT = 0.25;

/**
 * Preview engine.
 *
 * Owns one media element per clip — muted <video> for clips on video tracks
 * (so two clips of the same file can show different frames during a
 * transition), <audio> for clips on audio tracks — keeps them in sync with the
 * store's clock, composites video tracks bottom-to-top onto a canvas, and mixes
 * audio tracks (clip volume × fades × track mute/solo).
 */
class Player {
  private elements = new Map<string, HTMLMediaElement>();
  /** Decoded stills, keyed by URL. */
  private images = new Map<string, HTMLImageElement>();
  private host: HTMLDivElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private raf = 0;
  private last = 0;

  constructor() {
    // Media must stay in the DOM (and technically visible) or some webviews
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

  private elementFor(clip: Clip, media: MediaItem, audio: boolean): HTMLMediaElement {
    let el = this.elements.get(clip.id);
    const wanted = audio ? "AUDIO" : "VIDEO";
    if (el && el.tagName !== wanted) {
      // The clip moved between kinds of track (can't normally happen) — rebuild.
      this.dispose(clip.id, el);
      el = undefined;
    }
    if (!el) {
      if (audio) {
        el = document.createElement("audio");
      } else {
        const v = document.createElement("video");
        v.playsInline = true;
        v.width = 2;
        v.height = 2;
        // Sound comes from the clip's linked audio clip, never from the picture.
        v.muted = true;
        el = v;
      }
      el.preload = "auto";
      this.host.appendChild(el);
      this.elements.set(clip.id, el);
    }
    if (el.dataset.src !== media.src) {
      el.dataset.src = media.src;
      el.src = media.src;
    }
    return el;
  }

  private dispose(id: string, el: HTMLMediaElement) {
    el.pause();
    el.removeAttribute("src");
    el.load();
    el.remove();
    this.elements.delete(id);
  }

  private gc(clips: Clip[]) {
    const live = new Set(clips.map((c) => c.id));
    for (const [id, el] of this.elements) if (!live.has(id)) this.dispose(id, el);
  }

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

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;

    const state = useStore.getState();
    const total = timelineEnd(state.clips);
    let t = state.currentTime;
    if (state.playing) {
      t += dt;
      if (t >= total) {
        t = total;
        useStore.setState({ currentTime: t, playing: false });
      } else {
        useStore.setState({ currentTime: t });
      }
    }

    this.gc(state.clips);
    const media = new Map(state.media.map((m) => [m.id, m]));
    const tracks = new Map(state.tracks.map((tr) => [tr.id, tr]));
    this.sync(state.clips, tracks, t, useStore.getState().playing, media, state.settings.fps);
    this.draw(state.clips, state.tracks, t, state.settings.width, state.settings.height, media);
  };

  private sync(clips: Clip[], tracks: Map<string, Track>, t: number, playing: boolean, media: Map<string, MediaItem>, fps: number) {
    const anySolo = [...tracks.values()].some((tr) => tr.kind === "audio" && tr.solo);

    for (const c of clips) {
      const m = media.get(c.mediaId);
      const track = tracks.get(c.trackId);
      if (!m || !track || m.status !== "ready" || m.kind === "image") continue;
      const audio = track.kind === "audio";
      const el = this.elementFor(c, m, audio);

      const [from, to] = activeRange(clips, c);
      const silent = audio && (track.muted || (anySolo && !track.solo));
      const near = t >= from - (playing ? PREROLL : 0) && t < to && !(track.kind === "video" && track.hidden);
      if (!near) {
        if (!el.paused) el.pause();
        continue;
      }
      // Source time; transition handles may reach past the trim points, so clamp to the file.
      const maxT = Math.max(0, (m.duration || c.trimOut) - 0.001);
      const src = Math.min(maxT, Math.max(0, c.trimIn + (t - c.start)));

      if (audio) el.volume = silent ? 0 : audioGain(c, t);

      if (playing && t >= from) {
        if (el.paused) {
          el.currentTime = src;
          el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - src) > MAX_DRIFT) {
          el.currentTime = src;
        }
      } else {
        if (!el.paused) el.pause();
        if (!el.seeking && Math.abs(el.currentTime - src) > 0.5 / fps) el.currentTime = src;
      }
    }
  }

  private draw(clips: Clip[], tracks: Track[], t: number, w: number, h: number, media: Map<string, MediaItem>) {
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

    const drawer = (c: Clip) => (cx: CanvasRenderingContext2D, alpha: number) => {
      const m = media.get(c.mediaId);
      const tr = transformAt(c, t - c.start);
      if (m?.kind === "image") {
        if (m.status !== "ready") return;
        const img = this.imageFor(m);
        if (img.complete && img.naturalWidth) drawSource(cx, img, img.naturalWidth, img.naturalHeight, tr, alpha, w, h);
        return;
      }
      const v = this.elements.get(c.id) as HTMLVideoElement | undefined;
      if (v && v.readyState >= 2 && v.videoWidth) drawSource(cx, v, v.videoWidth, v.videoHeight, tr, alpha, w, h);
    };

    // Video tracks in creation order: V1 at the bottom, higher tracks on top.
    for (const track of tracks) {
      if (track.kind !== "video" || track.hidden) continue;
      const frame = trackFrameAt(clips, track.id, t);
      if (!frame.current) continue;
      if (frame.outgoing) {
        renderTransition(frame.current.transitionIn.type, ctx, drawer(frame.outgoing), drawer(frame.current), frame.progress, w, h);
      } else {
        drawer(frame.current)(ctx, 1);
      }
    }
  }
}

/** Clip volume (keyframeable) × fade in/out, at timeline time `t`. */
export function audioGain(c: Clip, t: number): number {
  const local = t - c.start;
  const dur = clipDuration(c);
  let g = Math.max(0, Math.min(1, valueAt(c, "volume", local) / 100));
  if (c.fadeIn > 0 && local < c.fadeIn) g *= Math.max(0, local / c.fadeIn);
  if (c.fadeOut > 0 && local > dur - c.fadeOut) g *= Math.max(0, (dur - local) / c.fadeOut);
  return g;
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
