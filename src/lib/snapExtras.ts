import { useStore } from "../store";
import type { Clip } from "../types";
import { timeMap } from "./speed";
import { clipEnd } from "./timeline";
import { beatsOf, useVisuals } from "./visuals";

/** Beats of a clip on the timeline (timeline seconds), for clips on music tracks. */
export function clipBeats(c: Clip): number[] {
  const w = useVisuals.getState().waves[c.mediaId];
  if (!w) return [];
  const tm = timeMap(c);
  const end = clipEnd(c);
  const out: number[] = [];
  for (const b of beatsOf(w)) {
    if (b < c.trimIn || b > c.trimOut) continue;
    const t = c.start + tm.local(b - c.trimIn);
    if (t >= c.start && t <= end) out.push(t);
  }
  return out;
}

let key: unknown[] = [];
let cached: number[] = [];

/** Extra snap points: markers, and beats in clips on music tracks. */
export function snapExtras(): number[] {
  const { clips, tracks, markers } = useStore.getState();
  const waves = useVisuals.getState().waves;
  const k = [clips, tracks, markers, waves];
  if (k.some((x, i) => x !== key[i])) {
    const music = new Set(tracks.filter((t) => t.music).map((t) => t.id));
    cached = [...markers.map((m) => m.t), ...clips.filter((c) => music.has(c.trackId)).flatMap(clipBeats)];
    key = k;
  }
  return cached;
}

