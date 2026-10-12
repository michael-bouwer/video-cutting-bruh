import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { player, audioGain } from "../engine/player";
import { useStore } from "../store";
import { buildAudioEffect } from "./effects";
import { effectValueAt } from "./keyframes";
import { clipDuration, clipEnd, timelineEnd } from "./timeline";
import { audioTempo } from "./speed";

/**
 * Export = render every frame with the preview engine and stream the pixels to
 * ffmpeg (see src-tauri/src/export.rs), plus an audio mix rendered offline with
 * the same volume/fade/effect logic the preview uses.
 */

export type Codec = "h264" | "hevc" | "av1";
export type Quality = "high" | "balanced" | "small";

export interface EncoderInfo {
  codec: Codec;
  encoder: string;
  hardware: boolean;
}

export interface ExportSettings {
  path: string;
  /** Output size as a fraction of the project resolution. */
  scale: number;
  fps: number;
  codec: Codec;
  quality: Quality;
  audio: boolean;
  /** Part of the timeline to export (default: all of it). */
  range?: { start: number; end: number };
  /** 9:16 output: the centre of the frame, full height (Shorts / TikTok / Reels). */
  vertical?: boolean;
  /** Average video bitrate (kbit/s) instead of constant quality, e.g. to fit a size limit. */
  bitrateKbps?: number;
  audioKbps?: number;
}

/** The part of the timeline an export covers. */
export function exportRange(opts: Pick<ExportSettings, "range">, total: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(total, opts.range?.start ?? 0));
  const end = Math.max(start, Math.min(total, opts.range?.end ?? total));
  return { start, end };
}

/** Output size for the project size × scale (and 9:16 framing). */
export function outputSize(width: number, height: number, opts: Pick<ExportSettings, "scale" | "vertical">): { width: number; height: number } {
  const h = even(height * opts.scale);
  return { width: opts.vertical ? even((h * 9) / 16) : even(width * opts.scale), height: h };
}

export interface ExportProgress {
  phase: "audio" | "video" | "finishing";
  frame: number;
  frames: number;
  /** Frames rendered per second (video phase). */
  speed: number;
  /** Seconds remaining (estimate). */
  eta: number;
}

export const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export async function listEncoders(): Promise<EncoderInfo[]> {
  if (!isTauri()) return [];
  return invoke<EncoderInfo[]>("export_encoders");
}

// ---- Audio mix --------------------------------------------------------------------

/** 16-bit PCM WAV from a rendered buffer. */
function encodeWav(buf: AudioBuffer): Uint8Array {
  const channels = buf.numberOfChannels;
  const frames = buf.length;
  const data = new DataView(new ArrayBuffer(44 + frames * channels * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  data.setUint32(4, 36 + frames * channels * 2, true);
  str(8, "WAVEfmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, channels, true);
  data.setUint32(24, buf.sampleRate, true);
  data.setUint32(28, buf.sampleRate * channels * 2, true);
  data.setUint16(32, channels * 2, true);
  data.setUint16(34, 16, true);
  str(36, "data");
  data.setUint32(40, frames * channels * 2, true);
  const chans = [...Array(channels)].map((_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(data.buffer);
}

/**
 * Mixes every audible audio clip into one WAV, offline, using the same rules as
 * the preview (clip volume keyframes × fades × track mute/solo, audio effects).
 * Audio is taken from the original files, not the preview copies.
 */
async function renderAudioMix(range: { start: number; end: number }, isCancelled: () => boolean): Promise<Uint8Array | null> {
  const st = useStore.getState();
  const anySolo = st.tracks.some((t) => t.kind === "audio" && t.solo);
  const audible = st.clips.filter((c) => {
    const track = st.tracks.find((t) => t.id === c.trackId);
    const m = st.media.find((x) => x.id === c.mediaId);
    return (
      track?.kind === "audio" &&
      !track.muted &&
      (!anySolo || track.solo) &&
      m &&
      m.status !== "missing" &&
      m.status !== "error" &&
      clipEnd(c) > range.start &&
      c.start < range.end
    );
  });
  if (audible.length === 0) return null;

  const sampleRate = 48000;
  const total = range.end - range.start;
  // Timeline time → time in the mix.
  const at = (t: number) => Math.max(0, t - range.start);
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * sampleRate)), sampleRate);
  for (const c of audible) {
    if (isCancelled()) return null;
    const m = st.media.find((x) => x.id === c.mediaId)!;
    const dur = clipDuration(c);
    // ffmpeg retimes the audio for speed changes, so the WAV runs in timeline time.
    const tempo = audioTempo(c, `t${c.id}`);
    let wav: string;
    try {
      wav = await invoke<string>("export_audio_segment", {
        path: m.path,
        start: c.trimIn,
        duration: c.trimOut - c.trimIn,
        filters: tempo.filters,
        cmds: tempo.cmds ? [`t${c.id}.cmd`, tempo.cmds] : null,
      });
    } catch {
      continue; // no audio stream in that file
    }
    const decoded = await ctx.decodeAudioData(await (await fetch(convertFileSrc(wav))).arrayBuffer());
    const src = ctx.createBufferSource();
    src.buffer = decoded;

    let tail: AudioNode = src;
    for (const fx of c.effects.filter((f) => f.enabled)) {
      const nodes = buildAudioEffect(ctx, fx.type);
      if (!nodes) continue;
      const animated = Object.values(fx.keyframes).some((k) => k.length > 0);
      // Static effects need one update; animated ones are sampled 20× a second.
      for (let ts = Math.max(c.start, range.start); ts <= c.start + dur + 1e-6; ts += animated ? 0.05 : Infinity) {
        nodes.update((k) => effectValueAt(fx, k, ts - c.start), at(ts));
      }
      tail.connect(nodes.input);
      tail = nodes.output;
    }
    // Volume keyframes and fades, as a smooth gain envelope (100 points/s).
    const gain = ctx.createGain();
    const from = Math.max(c.start, range.start);
    gain.gain.setValueAtTime(audioGain(c, from), at(from));
    for (let ts = from + 0.01; ts < c.start + dur; ts += 0.01) gain.gain.linearRampToValueAtTime(audioGain(c, ts), at(ts));
    gain.gain.linearRampToValueAtTime(audioGain(c, c.start + dur), at(c.start + dur));
    tail.connect(gain).connect(ctx.destination);
    // Clips that start before the range begin part-way in.
    const skip = from - c.start;
    src.start(at(from), skip, Math.max(0, dur - skip));
  }
  if (isCancelled()) return null;
  return encodeWav(await ctx.startRendering());
}

// ---- Run ----------------------------------------------------------------------------------

export interface ExportHandle {
  cancel: () => void;
  done: Promise<string>;
}

export function startExport(opts: ExportSettings, encoder: string, onProgress: (p: ExportProgress) => void): ExportHandle {
  let cancelled = false;
  let jobId: string | null = null;
  const isCancelled = () => cancelled;

  const done = (async () => {
    const st = useStore.getState();
    const range = exportRange(opts, timelineEnd(st.clips));
    const total = range.end - range.start;
    if (total <= 0) throw new Error("Nothing to export in that range");
    const { width, height } = outputSize(st.settings.width, st.settings.height, opts);
    // The full frame is rendered at this size; vertical exports take its centre.
    const frameW = opts.vertical ? even(st.settings.width * opts.scale) : width;
    const frames = Math.max(1, Math.ceil(total * opts.fps - 1e-6));

    onProgress({ phase: "audio", frame: 0, frames, speed: 0, eta: 0 });
    const wav = opts.audio ? await renderAudioMix(range, isCancelled) : null;
    if (cancelled) throw new Error("cancelled");
    const audioPath = wav ? await invoke<string>("export_save_audio", wav) : null;

    jobId = await invoke<string>("export_begin", {
      opts: {
        path: opts.path,
        width,
        height,
        fps: opts.fps,
        encoder,
        codec: opts.codec,
        quality: opts.quality,
        audioPath,
        bitrateKbps: opts.bitrateKbps ?? null,
        audioKbps: opts.audioKbps ?? null,
      },
    });

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true })!;
    let frameCtx = ctx;
    if (frameW !== width) {
      const full = document.createElement("canvas");
      full.width = frameW;
      full.height = height;
      frameCtx = full.getContext("2d", { alpha: false })!;
    }

    player.beginExport();
    const started = performance.now();
    let inflight: Promise<unknown> | null = null;
    try {
      for (let i = 0; i < frames; i++) {
        if (cancelled) throw new Error("cancelled");
        await player.renderFrame(frameCtx, range.start + i / opts.fps, frameW, height);
        if (frameCtx !== ctx) ctx.drawImage(frameCtx.canvas, (frameW - width) / 2, 0, width, height, 0, 0, width, height);
        const pixels = new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer);
        // Keep one frame in flight: render the next while ffmpeg receives this one.
        if (inflight) await inflight;
        inflight = invoke("export_frame", pixels, { headers: { "x-export-id": jobId } });
        if (i % 3 === 0) player.showFrame(canvas);
        const elapsed = (performance.now() - started) / 1000;
        const speed = (i + 1) / Math.max(elapsed, 1e-3);
        onProgress({ phase: "video", frame: i + 1, frames, speed, eta: (frames - i - 1) / speed });
      }
      if (inflight) await inflight;
    } finally {
      player.endExport();
    }
    onProgress({ phase: "finishing", frame: frames, frames, speed: 0, eta: 0 });
    const out = await invoke<string>("export_end", { id: jobId });
    jobId = null;
    return out;
  })().catch(async (e) => {
    if (jobId) await invoke("export_cancel", { id: jobId }).catch(() => {});
    throw e instanceof Error ? e : new Error(String(e));
  });

  return {
    cancel: () => {
      cancelled = true;
    },
    done,
  };
}
