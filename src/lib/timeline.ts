import type { Clip } from "../types";

export interface PlacedClip {
  clip: Clip;
  index: number;
  /** Timeline start/end in seconds. */
  start: number;
  end: number;
  duration: number;
  /** Effective (clamped) transition overlap with the previous clip. */
  transIn: number;
}

export interface Layout {
  items: PlacedClip[];
  total: number;
}

export const clipDuration = (c: Clip) => Math.max(0, c.trimOut - c.trimIn);

/**
 * Lays clips out sequentially on a single track. A transition makes the
 * incoming clip overlap the tail of the previous one. Overlaps are clamped to
 * half of either clip, so no more than two clips are ever visible at once.
 */
export function layoutClips(clips: Clip[]): Layout {
  const items: PlacedClip[] = [];
  let cursor = 0;
  clips.forEach((clip, index) => {
    const duration = clipDuration(clip);
    const prev = items[index - 1];
    let transIn = 0;
    if (prev && clip.transitionIn.type !== "cut") {
      transIn = Math.max(0, Math.min(clip.transitionIn.duration, prev.duration / 2, duration / 2));
    }
    const start = Math.max(0, cursor - transIn);
    const end = start + duration;
    items.push({ clip, index, start, end, duration, transIn });
    cursor = end;
  });
  return { items, total: cursor };
}

export interface Frame {
  /** Clip on top (or the only clip). */
  current?: PlacedClip;
  /** Outgoing clip while a transition is running. */
  outgoing?: PlacedClip;
  /** 0..1 progress of the transition into `current`. */
  progress: number;
}

export function frameAt(layout: Layout, t: number): Frame {
  const active = layout.items.filter((p) => t >= p.start && t < p.end);
  if (active.length === 0) {
    // Hold the very last frame when parked at the end.
    const last = layout.items[layout.items.length - 1];
    if (last && t >= last.end && t <= last.end + 1e-6) return { current: last, progress: 1 };
    return { progress: 1 };
  }
  const current = active[active.length - 1];
  const outgoing = active.length > 1 ? active[active.length - 2] : undefined;
  const progress = outgoing && current.transIn > 0 ? (t - current.start) / current.transIn : 1;
  return { current, outgoing, progress: Math.min(1, Math.max(0, progress)) };
}

/** Topmost clip under `t`. */
export function clipAt(layout: Layout, t: number): PlacedClip | undefined {
  return frameAt(layout, t).current;
}

export function formatTime(t: number, fps: number): string {
  const total = Math.max(0, t);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const f = Math.floor((total % 1) * fps + 1e-6);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}
