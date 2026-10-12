import { useStore } from "../store";
import type { AnimProp, Clip, MediaItem, Track } from "../types";
import { effectValueAt, transformAt } from "../lib/keyframes";
import { buildAudioEffect, canvasFiltersSupported, cssFilter, drawOverlays, type AudioEffectNodes } from "../lib/effects";
import { activeRange, timelineEnd, trackFrameAt } from "../lib/timeline";
import { clipGain } from "../lib/gain";
import { sourceTime, timeMap } from "../lib/speed";
import { renderTitle } from "../lib/titles";
import { easedProgress, renderTransition } from "../lib/transitions";

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
/** Per audio clip: element → effect chain → clip gain → master. */
interface AudioChain {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  /** Effect ids/types/enabled, to know when the chain must be rebuilt. */
  signature: string;
  fx: { id: string; nodes: AudioEffectNodes }[];
}

class Player {
  private elements = new Map<string, HTMLMediaElement>();
  private audioCtx: AudioContext | null = null;
  private master: GainNode | null = null;
  private chains = new Map<string, AudioChain>();
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

    // Browsers only let audio start from a user gesture, so the Web Audio engine is
    // created (or resumed) inside one. Creating it any other time (e.g. from a frame
    // update after recovering a project) leaves it suspended, i.e. silent.
    const unlock = () => {
      if (!this.audioCtx) this.audioGraph();
      else if (this.audioCtx.state === "suspended") this.audioCtx.resume().catch(() => {});
    };
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
  }

  /** Web Audio graph for audio effects; null if unavailable (plain element volume is used then). */
  private audioGraph(): { ctx: AudioContext; master: GainNode } | null {
    if (this.audioCtx && this.master) return { ctx: this.audioCtx, master: this.master };
    try {
      this.audioCtx = new AudioContext();
      this.master = this.audioCtx.createGain();
      this.master.connect(this.audioCtx.destination);
      return { ctx: this.audioCtx, master: this.master };
    } catch {
      return null;
    }
  }

  /**
   * Connects (or rebuilds) an audio clip's effect chain.
   *
   * Clips only enter Web Audio when they have audio effects and the engine is
   * running: once an element is routed into Web Audio its sound only comes out
   * through the engine, so routing into a suspended engine would mute it.
   * Everything else plays straight from the element.
   */
  private chainFor(clip: Clip, el: HTMLMediaElement): AudioChain | null {
    let chain = this.chains.get(clip.id);
    const wantsEffects = clip.effects.some((fx) => fx.enabled);
    if (!chain && !wantsEffects) return null;
    if (!chain && this.audioCtx?.state !== "running") return null;
    const ctx = this.audioCtx!;
    const master = this.master!;
    if (!chain) {
      let source: MediaElementAudioSourceNode;
      try {
        source = ctx.createMediaElementSource(el);
      } catch {
        return null;
      }
      const gain = ctx.createGain();
      gain.connect(master);
      chain = { source, gain, signature: "", fx: [] };
      this.chains.set(clip.id, chain);
    }
    const active = clip.effects.filter((fx) => fx.enabled);
    const signature = active.map((fx) => `${fx.id}:${fx.type}`).join("|");
    if (signature !== chain.signature) {
      chain.source.disconnect();
      chain.fx.forEach(({ nodes }) => nodes.output.disconnect());
      chain.fx = active
        .map((fx) => ({ id: fx.id, nodes: buildAudioEffect(ctx, fx.type) }))
        .filter((x): x is { id: string; nodes: AudioEffectNodes } => !!x.nodes);
      let tail: AudioNode = chain.source;
      for (const { nodes } of chain.fx) {
        tail.connect(nodes.input);
        tail = nodes.output;
      }
      tail.connect(chain.gain);
      chain.signature = signature;
    }
    return chain;
  }

  /** PNG of the current preview frame, at project resolution. */
  capture(): Promise<Blob> {
    const canvas = this.ctx?.canvas;
    if (!canvas) return Promise.reject(new Error("The preview isn't ready"));
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't encode the frame"))), "image/png"),
    );
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
      // Tauri's asset protocol sends Access-Control-Allow-Origin, so CORS-mode loading works and
      // keeps the canvas readable (screenshots) and audio usable by Web Audio (effects).
      el.crossOrigin = "anonymous";
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
    const chain = this.chains.get(id);
    if (chain) {
      chain.source.disconnect();
      chain.fx.forEach(({ nodes }) => nodes.output.disconnect());
      chain.gain.disconnect();
      this.chains.delete(id);
    }
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
      img.crossOrigin = "anonymous";
      img.src = m.src;
      this.images.set(m.src, img);
    }
    return img;
  }

  /** While exporting, the live preview loop stands still (export drives rendering). */
  private exporting = false;

  beginExport() {
    this.exporting = true;
    useStore.setState({ playing: false });
    for (const el of this.elements.values()) el.pause();
  }

  endExport() {
    this.exporting = false;
  }

  /** Shows an exported frame in the preview while exporting. */
  showFrame(source: HTMLCanvasElement) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(source, 0, 0, ctx.canvas.width, ctx.canvas.height);
  }

  /**
   * Renders the frame at exact timeline time `t` into `ctx` (w×h), waiting until
   * every visible video has seeked to the right frame and every still is decoded.
   */
  async renderFrame(ctx: CanvasRenderingContext2D, t: number, w: number, h: number) {
    const state = useStore.getState();
    const media = new Map(state.media.map((m) => [m.id, m]));
    const visible: Clip[] = [];
    for (const track of state.tracks) {
      if (track.kind !== "video" || track.hidden) continue;
      const frame = trackFrameAt(state.clips, track.id, t);
      if (frame.current) visible.push(frame.current);
      if (frame.outgoing) visible.push(frame.outgoing);
    }
    await Promise.all(visible.map((c) => this.prepareExact(c, media.get(c.mediaId), t)));
    this.compose(ctx, state.clips, state.tracks, t, w, h, media);
  }

  private async prepareExact(c: Clip, m: MediaItem | undefined, t: number) {
    if (!m || m.status !== "ready") return;
    if (m.kind === "image") {
      const img = this.imageFor(m);
      if (!img.complete || !img.naturalWidth) await img.decode().catch(() => {});
      return;
    }
    const el = this.elementFor(c, m, false) as HTMLVideoElement;
    if (!el.paused) el.pause();
    const maxT = Math.max(0, (m.duration || c.trimOut) - 0.001);
    // A hair past the exact time so float rounding never lands on the previous frame.
    const src = Math.min(maxT, Math.max(0, sourceTime(c, t - c.start)) + 1e-4);
    const once = (ev: string, ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          el.removeEventListener(ev, done);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, ms);
        el.addEventListener(ev, done);
      });
    if (el.readyState < 1) await once("loadedmetadata", 5000);
    if (Math.abs(el.currentTime - src) > 1e-3 || el.readyState < 2) {
      const seeked = once("seeked", 5000);
      el.currentTime = src;
      await seeked;
    }
    if (el.readyState < 2) await once("canplay", 5000);
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.exporting) return;

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
      const src = Math.min(maxT, Math.max(0, sourceTime(c, t - c.start)));
      // Speed changes play through the element's rate (pitch preserved for audio).
      const rate = Math.min(16, Math.max(0.0625, timeMap(c).speedAt(t - c.start)));
      if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = rate;

      if (audio) {
        const gain = silent ? 0 : clipGain(c, t);
        const chain = this.chainFor(c, el);
        if (chain) {
          el.volume = 1;
          const ac = this.audioCtx!;
          chain.gain.gain.setTargetAtTime(gain, ac.currentTime, 0.015);
          const local = t - c.start;
          for (const { id, nodes } of chain.fx) {
            const fx = c.effects.find((e) => e.id === id);
            if (fx) nodes.update((k) => effectValueAt(fx, k, local));
          }
          if (playing && ac.state === "suspended") ac.resume().catch(() => {});
        } else {
          el.volume = gain;
        }
      }

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
    this.compose(ctx, clips, tracks, t, w, h, media);
  }

  /** Composites all visible video tracks at time `t` (shared by the preview and export). */
  private compose(ctx: CanvasRenderingContext2D, clips: Clip[], tracks: Track[], t: number, w: number, h: number, media: Map<string, MediaItem>) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    const drawer = (c: Clip) => (cx: CanvasRenderingContext2D, alpha: number) => {
      const m = media.get(c.mediaId);
      const local = t - c.start;
      const tr = transformAt(c, local);
      if (c.title) {
        // Text is rendered at frame size, so it fits 1:1 like a full-frame image.
        drawSource(cx, renderTitle(c.title, w, h), w, h, tr, alpha, w, h, c, local);
        return;
      }
      if (m?.kind === "image") {
        if (m.status !== "ready") return;
        const img = this.imageFor(m);
        if (img.complete && img.naturalWidth) drawSource(cx, img, img.naturalWidth, img.naturalHeight, tr, alpha, w, h, c, local);
        return;
      }
      const v = this.elements.get(c.id) as HTMLVideoElement | undefined;
      if (v && v.readyState >= 2 && v.videoWidth) drawSource(cx, v, v.videoWidth, v.videoHeight, tr, alpha, w, h, c, local);
    };

    // Video tracks in creation order: V1 at the bottom, higher tracks on top.
    for (const track of tracks) {
      if (track.kind !== "video" || track.hidden) continue;
      const frame = trackFrameAt(clips, track.id, t);
      if (!frame.current) continue;
      if (frame.outgoing) {
        const tr = frame.current.transitionIn;
        renderTransition(tr.type, ctx, drawer(frame.outgoing), drawer(frame.current), easedProgress(tr, frame.progress), w, h);
      } else {
        drawer(frame.current)(ctx, 1);
      }
    }
  }
}

/** Clip gain at timeline time `t`: volume keyframes × fades × music ducking (see lib/gain.ts). */
export const audioGain = clipGain;

/** Draws a video frame, still or text, fitted ("contain") into the frame, with the clip's crop and transform. */
function drawSource(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  tr: Record<AnimProp, number>,
  alpha: number,
  w: number,
  h: number,
  clip: Clip,
  local: number,
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
  if (canvasFiltersSupported) {
    // Combine with a filter set by a transition (e.g. blur dissolve).
    const outer = ctx.filter && ctx.filter !== "none" ? ctx.filter : "";
    const own = cssFilter(clip, local, h);
    ctx.filter = [outer, own === "none" ? "" : own].filter(Boolean).join(" ") || "none";
  }
  // Crop removes edges; what's left stays where it was.
  const cl = Math.min(0.99, Math.max(0, tr.cropLeft / 100));
  const cr = Math.min(0.99 - cl, Math.max(0, tr.cropRight / 100));
  const ct = Math.min(0.99, Math.max(0, tr.cropTop / 100));
  const cb = Math.min(0.99 - ct, Math.max(0, tr.cropBottom / 100));
  const fx = 1 - cl - cr;
  const fy = 1 - ct - cb;
  if (fx > 0 && fy > 0) {
    const x0 = -dw / 2 + dw * cl;
    const y0 = -dh / 2 + dh * ct;
    ctx.drawImage(src, sw * cl, sh * ct, sw * fx, sh * fy, x0, y0, dw * fx, dh * fy);
    drawOverlays(ctx, clip, local, x0, y0, dw * fx, dh * fy);
  }
  ctx.restore();
}

export const player = new Player();
