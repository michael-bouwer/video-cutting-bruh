import { useStore } from "../store";
import type { Clip, Track } from "../types";
import { valueAt } from "./keyframes";
import { sourceTime } from "./speed";
import { clipDuration, clipEnd, timelineEnd } from "./timeline";
import { peakAt, useVisuals, type Waveform } from "./visuals";

/**
 * Audio gain of a clip at timeline time t: volume keyframes × fades × ducking.
 * Shared by the preview and both export modes so they sound the same.
 */
export function clipGain(c: Clip, t: number): number {
  return baseGain(c, t) * duckGain(c.trackId, t);
}

/** Volume (keyframeable) × fade in/out. */
export function baseGain(c: Clip, t: number): number {
  const local = t - c.start;
  const dur = clipDuration(c);
  let g = Math.max(0, Math.min(1, valueAt(c, "volume", local) / 100));
  if (c.fadeIn > 0 && local < c.fadeIn) g *= Math.max(0, local / c.fadeIn);
  if (c.fadeOut > 0 && local > dur - c.fadeOut) g *= Math.max(0, (dur - local) / c.fadeOut);
  return g;
}

// ---- Ducking ------------------------------------------------------------------------------
//
// Music tracks are turned down while the other audible tracks are loud. The
// envelope is computed from the waveforms (50 points/s), with a little
// look-ahead so speech isn't clipped, a quick attack and a slow release.

const RATE = 50;
/** Peak level (0–1) above which other audio counts as "playing" (≈ −24 dBFS). */
const THRESHOLD = 0.063;
const LOOKAHEAD = 0.1;
const ATTACK = 0.12;
const RELEASE = 0.6;

let cacheKey: unknown[] = [];
let envelopes = new Map<string, Float32Array>();

function compute(clips: Clip[], tracks: Track[], waves: Record<string, Waveform>) {
  const music = tracks.filter((t) => t.kind === "audio" && t.music);
  const out = new Map<string, Float32Array>();
  if (music.length === 0) return out;
  const total = timelineEnd(clips);
  const n = Math.ceil(total * RATE) + 1;
  const anySolo = tracks.some((t) => t.kind === "audio" && t.solo);
  const audible = (t: Track) => t.kind === "audio" && !t.music && !t.muted && (!anySolo || t.solo);
  const byId = new Map(tracks.map((t) => [t.id, t]));
  // Loudness of everything that isn't music.
  const level = new Float32Array(n);
  for (const c of clips) {
    const track = byId.get(c.trackId);
    const w = waves[c.mediaId];
    if (!track || !w || !audible(track)) continue;
    const from = Math.max(0, Math.floor(c.start * RATE));
    const to = Math.min(n - 1, Math.ceil(clipEnd(c) * RATE));
    for (let i = from; i <= to; i++) {
      const t = i / RATE;
      if (t < c.start || t >= clipEnd(c)) continue;
      level[i] = Math.max(level[i], peakAt(w, sourceTime(c, t - c.start)) * baseGain(c, t));
    }
  }
  const look = Math.round(LOOKAHEAD * RATE);
  const attack = 1 - Math.exp(-1 / (ATTACK * RATE));
  const release = 1 - Math.exp(-1 / (RELEASE * RATE));
  for (const m of music) {
    const duck = 10 ** ((m.duckDb ?? -12) / 20);
    const env = new Float32Array(n);
    let g = 1;
    for (let i = 0; i < n; i++) {
      let loud = false;
      for (let j = i; j <= Math.min(n - 1, i + look) && !loud; j++) loud = level[j] > THRESHOLD;
      const target = loud ? duck : 1;
      g += (target - g) * (target < g ? attack : release);
      env[i] = g;
    }
    out.set(m.id, env);
  }
  return out;
}

/** Ducking gain (0–1) of a track at timeline time t (1 for non-music tracks). */
export function duckGain(trackId: string, t: number): number {
  const { clips, tracks } = useStore.getState();
  const track = tracks.find((x) => x.id === trackId);
  if (!track?.music) return 1;
  const waves = useVisuals.getState().waves;
  const key = [clips, tracks, waves];
  if (key.some((k, i) => k !== cacheKey[i])) {
    envelopes = compute(clips, tracks, waves);
    cacheKey = key;
  }
  const env = envelopes.get(trackId);
  if (!env) return 1;
  const x = t * RATE;
  const i = Math.floor(x);
  if (i < 0) return env[0] ?? 1;
  if (i >= env.length - 1) return env[env.length - 1] ?? 1;
  return env[i] + (env[i + 1] - env[i]) * (x - i);
}
