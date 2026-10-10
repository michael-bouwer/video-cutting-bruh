import type { Clip, Track, TrackKind } from "../types";

/**
 * Multi-track timeline helpers.
 *
 * Clips sit at an absolute `start` on a track; gaps are allowed and clips on
 * the same track never overlap. A transition belongs to the clip *after* a cut:
 * when two clips touch on a track, `clip.transitionIn` blends from the previous
 * one, centred on the cut (each side borrows up to half the transition from
 * beyond its trim points, holding the edge frame if the source runs out).
 */

/** Two clips closer than this are considered touching. */
export const TOUCH_EPS = 1 / 240;
export const MIN_CLIP = 0.1;

export const clipDuration = (c: Clip) => Math.max(0, c.trimOut - c.trimIn);
export const clipEnd = (c: Clip) => c.start + clipDuration(c);

export const timelineEnd = (clips: Clip[]) => clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);

export const trackClips = (clips: Clip[], trackId: string) =>
  clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);

/** The clip ending exactly where `clip` starts on the same track, if any. */
export function prevAdjacent(clips: Clip[], clip: Clip): Clip | undefined {
  return clips.find((c) => c.trackId === clip.trackId && c.id !== clip.id && Math.abs(clipEnd(c) - clip.start) < TOUCH_EPS);
}

/** Effective transition length into `clip` (0 if none or not touching a previous clip). */
export function transitionLength(clips: Clip[], clip: Clip): number {
  if (clip.transitionIn.type === "cut") return 0;
  const prev = prevAdjacent(clips, clip);
  if (!prev) return 0;
  return Math.max(0, Math.min(clip.transitionIn.duration, clipDuration(prev), clipDuration(clip)));
}

export interface TrackFrame {
  /** Clip on top (or the only clip). */
  current?: Clip;
  /** Outgoing clip while a transition is running. */
  outgoing?: Clip;
  /** 0..1 progress of the transition into `current`. */
  progress: number;
}

/** What a single track shows at time `t`. */
export function trackFrameAt(clips: Clip[], trackId: string, t: number): TrackFrame {
  const list = trackClips(clips, trackId);
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const next = list[i + 1];
    // Transition window around the cut into `next`.
    if (next) {
      const d = transitionLength(clips, next);
      if (d > 0 && t >= next.start - d / 2 && t < next.start + d / 2) {
        return { current: next, outgoing: c, progress: (t - (next.start - d / 2)) / d };
      }
    }
    if (t >= c.start && t < clipEnd(c)) return { current: c, progress: 1 };
  }
  return { progress: 1 };
}

/**
 * Time range during which a clip's media must be playing: its own span,
 * widened by any transitions it takes part in.
 */
export function activeRange(clips: Clip[], clip: Clip): [number, number] {
  let from = clip.start;
  let to = clipEnd(clip);
  const dIn = transitionLength(clips, clip);
  if (dIn > 0) from -= dIn / 2;
  const next = clips.find((c) => c.trackId === clip.trackId && c.id !== clip.id && Math.abs(c.start - to) < TOUCH_EPS);
  if (next) {
    const dOut = transitionLength(clips, next);
    if (dOut > 0) to += dOut / 2;
  }
  return [from, to];
}

// ---- Placement ------------------------------------------------------------------------

/** Free gaps on a track (ignoring `exclude`), as [from, to] with `to` possibly Infinity. */
export function gaps(clips: Clip[], trackId: string, exclude: Set<string>): [number, number][] {
  const list = trackClips(clips, trackId).filter((c) => !exclude.has(c.id));
  const out: [number, number][] = [];
  let cursor = 0;
  for (const c of list) {
    if (c.start > cursor + TOUCH_EPS) out.push([cursor, c.start]);
    cursor = Math.max(cursor, clipEnd(c));
  }
  out.push([cursor, Infinity]);
  return out;
}

/**
 * Closest start ≥ 0 to `desired` where a clip of `duration` fits on the track
 * without overlapping anything (except clips in `exclude`).
 */
export function fitStart(clips: Clip[], trackId: string, desired: number, duration: number, exclude: Set<string>): number {
  let best = Math.max(0, desired);
  let bestDist = Infinity;
  for (const [from, to] of gaps(clips, trackId, exclude)) {
    if (to - from < duration - TOUCH_EPS) continue;
    const s = Math.min(Math.max(desired, from), to - duration);
    const dist = Math.abs(s - desired);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return Math.max(0, best);
}

/** Does [start, start+duration) fit on the track without overlaps? */
export function fits(clips: Clip[], trackId: string, start: number, duration: number, exclude: Set<string>): boolean {
  if (start < -TOUCH_EPS) return false;
  return !clips.some(
    (c) => c.trackId === trackId && !exclude.has(c.id) && start < clipEnd(c) - TOUCH_EPS && start + duration > c.start + TOUCH_EPS,
  );
}

/**
 * Snaps `t` to the nearest point (clip edges on any track, the playhead, 0)
 * within `threshold` seconds. Returns the snapped value and what it snapped to.
 */
export function snapPoints(clips: Clip[], exclude: Set<string>, playhead: number): number[] {
  const pts = [0, playhead];
  for (const c of clips) {
    if (exclude.has(c.id)) continue;
    pts.push(c.start, clipEnd(c));
  }
  return pts;
}

export function snap(t: number, points: number[], threshold: number): { t: number; to: number | null } {
  let best: number | null = null;
  let bestD = threshold;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d <= bestD) {
      bestD = d;
      best = p;
    }
  }
  return best === null ? { t, to: null } : { t: best, to: best };
}

// ---- Tracks -----------------------------------------------------------------------------

/** Display order: video tracks top-down (highest first), then audio tracks. */
export function orderedTracks(tracks: Track[]): Track[] {
  const v = tracks.filter((t) => t.kind === "video").reverse();
  const a = tracks.filter((t) => t.kind === "audio");
  return [...v, ...a];
}

export const tracksOfKind = (tracks: Track[], kind: TrackKind) => tracks.filter((t) => t.kind === kind);

export function formatTime(t: number, fps: number): string {
  const total = Math.max(0, t);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const f = Math.floor((total % 1) * fps + 1e-6);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}
