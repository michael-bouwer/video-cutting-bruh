import { create } from "zustand";
import type {
  AnimProp,
  Clip,
  Easing,
  FfmpegStatus,
  Keyframe,
  MediaItem,
  Notice,
  ProjectSettings,
  Selection,
  Track,
  TrackKind,
  Transition,
} from "./types";
import { defaultBase, emptyKeyframes, PROP_KEYS } from "./lib/props";
import { keyframeNear, sortKeyframes, valueAt } from "./lib/keyframes";
import { clipDuration, clipEnd, fitStart, fits, MIN_CLIP, timelineEnd, TOUCH_EPS, trackClips } from "./lib/timeline";
import type { MediaDrag } from "./lib/mediaDrag";

// Kept here (not imported from lib/media) to avoid a circular import.
const IMAGE_MAX_DURATION = 3600;

export interface DialogButton {
  id: string;
  label: string;
  kind?: "primary" | "danger";
}

export interface DialogRequest {
  title: string;
  message: string;
  buttons: DialogButton[];
  /** Button id returned on Escape / clicking outside. */
  cancelId: string;
  resolve: (id: string) => void;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export function newTrack(kind: TrackKind, n: number): Track {
  return { id: uid(), kind, name: `${kind === "video" ? "V" : "A"}${n}`, hidden: false, muted: false, solo: false, locked: false };
}
export const defaultTracks = (): Track[] => [newTrack("video", 1), newTrack("audio", 1)];

/** Which track kind a media item's main clip goes on. */
const trackKindFor = (m: MediaItem): TrackKind => (m.kind === "audio" ? "audio" : "video");
/** Videos get a linked audio clip unless we know they're silent. */
const wantsAudio = (m: MediaItem) => m.kind === "video" && m.probe?.hasAudio !== false;

export interface PlaceOptions {
  trackId?: string;
  start?: number;
}

interface State {
  media: MediaItem[];
  tracks: Track[];
  clips: Clip[];
  settings: ProjectSettings;
  currentTime: number;
  playing: boolean;
  selection: Selection;
  /** Timeline zoom in pixels per second. */
  zoom: number;
  /** Snap clip edges to other edges / the playhead while dragging. */
  snapping: boolean;
  notices: Notice[];
  /** null until checked (or when not running in Tauri). */
  ffmpeg: FfmpegStatus | null;
  /** Path of the open project file, null for an unsaved project. */
  projectPath: string | null;
  /** Unsaved changes since the last save/open. */
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  dialog: DialogRequest | null;
  /** Bumped when the recent-projects list changes, so menus re-read it. */
  recentVersion: number;
  /** Media being dragged from the bin (see lib/mediaDrag.ts). */
  mediaDrag: MediaDrag | null;
  /** Which tab the right-hand panel shows. */
  rightTab: "inspector" | "project";
  setRightTab: (t: "inspector" | "project") => void;
  newProjectDialog: { resolve: (choice: { name: string; folder: string } | null) => void } | null;

  addMedia: (m: MediaItem) => void;
  updateMedia: (id: string, patch: Partial<MediaItem>) => void;
  removeMedia: (id: string) => void;

  // Tracks
  addTrack: (kind: TrackKind) => string;
  updateTrack: (id: string, patch: Partial<Omit<Track, "id" | "kind">>) => void;
  removeTrack: (id: string) => void;

  // Clips
  /** Places media on the timeline (with linked audio for videos). Default: end of the first suitable track. */
  placeMedia: (mediaId: string, opts?: PlaceOptions) => void;
  appendClip: (mediaId: string) => void;
  /** Moves a clip (and its linked clips) so it starts near `start`, optionally onto another track of the same kind. */
  moveClip: (id: string, start: number, trackId?: string) => void;
  /** Drags a clip edge to timeline time `t`; dragging back restores trimmed media. */
  trimEdge: (id: string, edge: "in" | "out", t: number) => void;
  /** Sets source in/out points (inspector fields). */
  trimClip: (id: string, trimIn: number, trimOut: number) => void;
  duplicateClip: (id: string) => void;
  /** Removes a clip and its linked clips (`single`: only this one). */
  removeClip: (id: string, single?: boolean) => void;
  /** Splits the selected clip (or every clip) under the playhead. */
  splitAtPlayhead: () => void;
  unlinkClip: (id: string) => void;
  setTransition: (clipId: string, patch: Partial<Transition>) => void;
  setFades: (clipId: string, patch: { fadeIn?: number; fadeOut?: number }) => void;

  /** Sets a property at clip-local time: writes a keyframe if the prop is animated, else the base value. */
  setPropValue: (clipId: string, prop: AnimProp, localT: number, v: number) => void;
  toggleKeyframe: (clipId: string, prop: AnimProp, localT: number) => void;
  updateKeyframe: (clipId: string, prop: AnimProp, kfId: string, patch: Partial<Pick<Keyframe, "t" | "v" | "ease">>) => void;
  removeKeyframe: (clipId: string, prop: AnimProp, kfId: string) => void;
  resetTransform: (clipId: string) => void;

  seek: (t: number) => void;
  setPlaying: (p: boolean) => void;
  select: (s: Selection) => void;
  setZoom: (z: number) => void;
  setSnapping: (on: boolean) => void;
  setSettings: (patch: Partial<ProjectSettings>) => void;
  notify: (level: Notice["level"], text: string) => void;
  dismiss: (id: string) => void;
}

const mapClip = (clips: Clip[], id: string, fn: (c: Clip) => Clip) => clips.map((c) => (c.id === id ? fn(c) : c));

/** A clip plus everything linked to it. */
export const groupOf = (clips: Clip[], clip: Clip) => (clip.linkId ? clips.filter((c) => c.linkId === clip.linkId) : [clip]);

function shiftKeyframes(c: Clip, by: number): Clip["keyframes"] {
  if (by === 0) return c.keyframes;
  return Object.fromEntries(PROP_KEYS.map((k) => [k, c.keyframes[k].map((kf) => ({ ...kf, t: kf.t + by }))])) as Clip["keyframes"];
}

function makeClip(mediaId: string, trackId: string, start: number, duration: number, linkId: string | null): Clip {
  return {
    id: uid(),
    mediaId,
    trackId,
    start,
    trimIn: 0,
    trimOut: duration,
    linkId,
    transitionIn: { type: "cut", duration: 1 },
    fadeIn: 0,
    fadeOut: 0,
    base: defaultBase(),
    keyframes: emptyKeyframes(),
  };
}

export const useStore = create<State>((set, get) => {
  const isLocked = (trackId: string) => get().tracks.find((t) => t.id === trackId)?.locked ?? false;
  const isImage = (c: Clip) => get().media.find((x) => x.id === c.mediaId)?.kind === "image";
  const maxDuration = (c: Clip) => {
    const m = get().media.find((x) => x.id === c.mediaId);
    return m?.kind === "image" ? IMAGE_MAX_DURATION : (m?.duration || c.trimOut);
  };

  /** First track of `kind` where [start, start+dur) is free, creating one if needed. */
  const trackWithRoom = (kind: TrackKind, start: number, dur: number, exclude: Set<string>): string => {
    const { tracks, clips } = get();
    const hit = tracks.find((t) => t.kind === kind && !t.locked && fits(clips, t.id, start, dur, exclude));
    return hit ? hit.id : get().addTrack(kind);
  };

  return {
    media: [],
    tracks: defaultTracks(),
    clips: [],
    settings: { width: 1920, height: 1080, fps: 30, allowHdr: false, proxyMode: "auto", proxyQuality: "full" },
    currentTime: 0,
    playing: false,
    selection: null,
    zoom: 80,
    snapping: true,
    notices: [],
    ffmpeg: null,
    projectPath: null,
    dirty: false,
    canUndo: false,
    canRedo: false,
    dialog: null,
    recentVersion: 0,
    newProjectDialog: null,
    rightTab: "inspector",
    mediaDrag: null,
    setRightTab: (rightTab) => set({ rightTab }),

    addMedia: (m) => set((s) => ({ media: [...s.media, m] })),
    updateMedia: (id, patch) => set((s) => ({ media: s.media.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
    removeMedia: (id) =>
      set((s) => {
        const clips = s.clips.filter((c) => c.mediaId !== id);
        const live = new Set(clips.map((c) => c.id));
        const selection = s.selection && !live.has(s.selection.clipId) ? null : s.selection;
        return { media: s.media.filter((m) => m.id !== id), clips, selection };
      }),

    // ---- Tracks ----------------------------------------------------------------------

    addTrack: (kind) => {
      const n = get().tracks.filter((t) => t.kind === kind).length + 1;
      const track = newTrack(kind, n);
      set((s) => ({ tracks: [...s.tracks, track] }));
      return track.id;
    },
    updateTrack: (id, patch) => set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
    removeTrack: (id) =>
      set((s) => {
        const track = s.tracks.find((t) => t.id === id);
        // Keep at least one track of each kind.
        if (!track || s.tracks.filter((t) => t.kind === track.kind).length <= 1) return {};
        const clips = s.clips.filter((c) => c.trackId !== id);
        const live = new Set(clips.map((c) => c.id));
        return {
          tracks: s.tracks.filter((t) => t.id !== id),
          clips,
          selection: s.selection && !live.has(s.selection.clipId) ? null : s.selection,
        };
      }),

    // ---- Placing & editing clips -----------------------------------------------------------

    placeMedia: (mediaId, opts = {}) => {
      const m = get().media.find((x) => x.id === mediaId);
      // Proxying media can already be placed: its duration is known from the probe.
      if (!m || m.status === "error" || m.status === "missing" || !(m.duration > 0)) return;
      const kind = trackKindFor(m);
      const { tracks, clips } = get();
      let trackId = opts.trackId && tracks.find((t) => t.id === opts.trackId && t.kind === kind && !t.locked)?.id;
      trackId ??= tracks.find((t) => t.kind === kind && !t.locked)?.id ?? get().addTrack(kind);
      const dur = m.duration;
      const desired = opts.start ?? timelineEnd(trackClips(clips, trackId));
      const start = fitStart(get().clips, trackId, desired, dur, new Set());
      const linkId = wantsAudio(m) ? uid() : null;
      const main = makeClip(mediaId, trackId, start, dur, linkId);
      const added = [main];
      if (linkId) {
        const audioTrack = trackWithRoom("audio", start, dur, new Set());
        added.push(makeClip(mediaId, audioTrack, start, dur, linkId));
      }
      set((s) => ({ clips: [...s.clips, ...added], selection: { kind: "clip", clipId: main.id } }));
    },

    appendClip: (mediaId) => get().placeMedia(mediaId),

    moveClip: (id, desired, trackId) => {
      const { clips, tracks } = get();
      const clip = clips.find((c) => c.id === id);
      if (!clip || isLocked(clip.trackId)) return;
      const group = groupOf(clips, clip);
      if (group.some((c) => isLocked(c.trackId))) return;
      const exclude = new Set(group.map((c) => c.id));
      const target =
        trackId && tracks.find((t) => t.id === trackId && !t.locked && t.kind === tracks.find((x) => x.id === clip.trackId)?.kind)
          ? trackId
          : clip.trackId;
      const dur = clipDuration(clip);

      // The dragged clip decides the timing: nearest spot on its target track.
      const start = fits(clips, target, Math.max(0, desired), dur, exclude)
        ? Math.max(0, desired)
        : fitStart(clips, target, desired, dur, exclude);
      const delta = start - clip.start;
      if (Math.abs(delta) < 1e-9 && target === clip.trackId) return;

      // Linked partners follow in time; if their own track is busy there, they hop to
      // another track of the same kind with room (or a new one) instead of blocking the move.
      const kindOf = (trackId: string) => tracks.find((t) => t.id === trackId)!.kind;
      const placed = new Map<string, string>([[id, target]]);
      for (const c of group) {
        if (c.id === id) continue;
        const s0 = c.start + delta;
        if (s0 < -TOUCH_EPS) return;
        const d = clipDuration(c);
        const others = [...clips.filter((x) => !exclude.has(x.id))];
        const ok = (tid: string) => fits(others, tid, s0, d, new Set());
        let tid: string | undefined = ok(c.trackId) ? c.trackId : undefined;
        tid ??= get().tracks.find((t) => t.kind === kindOf(c.trackId) && !t.locked && ok(t.id))?.id;
        tid ??= get().addTrack(kindOf(c.trackId));
        placed.set(c.id, tid);
      }
      set((s) => ({
        clips: s.clips.map((c) => (placed.has(c.id) ? { ...c, start: Math.max(0, c.start + delta), trackId: placed.get(c.id)! } : c)),
      }));
    },

    trimEdge: (id, edge, t) => {
      const { clips } = get();
      const clip = clips.find((c) => c.id === id);
      if (!clip) return;
      const group = groupOf(clips, clip);
      if (group.some((c) => isLocked(c.trackId))) return;
      const ids = new Set(group.map((c) => c.id));

      // Allowed range of delta, intersected over the linked group so they stay in sync.
      let lo = -Infinity;
      let hi = Infinity;
      for (const c of group) {
        const neighbours = trackClips(clips, c.trackId).filter((x) => !ids.has(x.id));
        if (edge === "in") {
          const prevEnd = Math.max(0, ...neighbours.filter((x) => clipEnd(x) <= c.start + TOUCH_EPS).map(clipEnd));
          // Can't reveal before the source's first frame (stills have no start) or overlap the previous clip.
          lo = Math.max(lo, isImage(c) ? -Infinity : -c.trimIn, prevEnd - c.start);
          hi = Math.min(hi, c.trimOut - MIN_CLIP - c.trimIn);
        } else {
          const nextStart = Math.min(Infinity, ...neighbours.filter((x) => x.start >= clipEnd(c) - TOUCH_EPS).map((x) => x.start));
          lo = Math.max(lo, c.trimIn + MIN_CLIP - c.trimOut);
          hi = Math.min(hi, maxDuration(c) - c.trimOut, nextStart - clipEnd(c));
        }
      }
      if (lo > hi) return;
      const want = edge === "in" ? t - clip.start : t - clipEnd(clip);
      const delta = Math.min(hi, Math.max(lo, want));
      if (Math.abs(delta) < 1e-6) return;
      set((s) => ({
        clips: s.clips.map((c) => {
          if (!ids.has(c.id)) return c;
          if (edge === "out") {
            const trimOut = c.trimOut + delta;
            const dur = trimOut - c.trimIn;
            return { ...c, trimOut, fadeIn: Math.min(c.fadeIn, dur), fadeOut: Math.min(c.fadeOut, dur) };
          }
          // Head trim: start and in-point move together, so the rest stays put in time.
          let trimIn = c.trimIn + delta;
          let trimOut = c.trimOut;
          if (trimIn < 0) {
            // Stills: lengthen from the front by moving the out-point instead.
            trimOut -= trimIn;
            trimIn = 0;
          }
          const dur = trimOut - trimIn;
          return {
            ...c,
            start: c.start + delta,
            trimIn,
            trimOut,
            keyframes: shiftKeyframes(c, -delta),
            fadeIn: Math.min(c.fadeIn, dur),
            fadeOut: Math.min(c.fadeOut, dur),
          };
        }),
      }));
    },

    trimClip: (id, trimIn, trimOut) => {
      const c = get().clips.find((x) => x.id === id);
      if (!c) return;
      if (trimIn !== c.trimIn) get().trimEdge(id, "in", c.start + (trimIn - c.trimIn));
      const after = get().clips.find((x) => x.id === id)!;
      if (trimOut !== after.trimOut) get().trimEdge(id, "out", clipEnd(after) + (trimOut - after.trimOut));
    },

    duplicateClip: (id) => {
      const { clips } = get();
      const clip = clips.find((c) => c.id === id);
      if (!clip) return;
      const group = groupOf(clips, clip);
      const groupEnd = Math.max(...group.map(clipEnd));
      const offset = groupEnd - Math.min(...group.map((c) => c.start));
      const linkId = clip.linkId ? uid() : null;
      const copies = group.map((c) => {
        const copy: Clip = { ...structuredClone(c), id: uid(), linkId, transitionIn: { ...c.transitionIn, type: "cut" } };
        for (const k of PROP_KEYS) copy.keyframes[k] = copy.keyframes[k].map((kf) => ({ ...kf, id: uid() }));
        copy.start = c.start + offset;
        return copy;
      });
      // Place right after the original if there's room, otherwise in the nearest gap (or a new track).
      let working = [...clips];
      for (const copy of copies) {
        const dur = clipDuration(copy);
        if (!fits(working, copy.trackId, copy.start, dur, new Set())) {
          const kind = get().tracks.find((t) => t.id === copy.trackId)!.kind;
          copy.trackId = trackWithRoom(kind, copy.start, dur, new Set());
        }
        working = [...working, copy];
      }
      const main = copies[group.indexOf(clip)];
      set({ clips: working, selection: { kind: "clip", clipId: main.id } });
    },

    removeClip: (id, single = false) =>
      set((s) => {
        const clip = s.clips.find((c) => c.id === id);
        if (!clip || isLocked(clip.trackId)) return {};
        const gone = new Set((single ? [clip] : groupOf(s.clips, clip)).filter((c) => !isLocked(c.trackId)).map((c) => c.id));
        return {
          clips: s.clips.filter((c) => !gone.has(c.id)),
          selection: s.selection && gone.has(s.selection.clipId) ? null : s.selection,
        };
      }),

    splitAtPlayhead: () => {
      const { clips, currentTime: t, selection, notify } = get();
      const under = (c: Clip) => t > c.start + MIN_CLIP && t < clipEnd(c) - MIN_CLIP && !isLocked(c.trackId);
      const selected = selection?.kind === "clip" ? clips.find((c) => c.id === selection.clipId) : undefined;
      // The selected clip (with its links) if it's under the playhead, else everything under it.
      const targets = selected && under(selected) ? groupOf(clips, selected).filter(under) : clips.filter(under);
      if (targets.length === 0) return notify("info", "Move the playhead over a clip to split it.");

      const newLinks = new Map<string, string>();
      let next = [...clips];
      let selectId: string | null = null;
      for (const c of targets) {
        const local = t - c.start;
        const left: Clip = { ...c, trimOut: c.trimIn + local, fadeOut: 0, keyframes: emptyKeyframes() };
        const linkId = c.linkId ? (newLinks.get(c.linkId) ?? newLinks.set(c.linkId, uid()).get(c.linkId)!) : null;
        const right: Clip = {
          ...c,
          id: uid(),
          start: t,
          trimIn: c.trimIn + local,
          linkId,
          fadeIn: 0,
          transitionIn: { type: "cut", duration: c.transitionIn.duration },
          keyframes: emptyKeyframes(),
        };
        for (const k of PROP_KEYS) {
          const kfs = c.keyframes[k];
          if (kfs.length === 0) continue;
          // Pin the value at the split point on both sides so motion is continuous.
          const v = valueAt(c, k, local);
          const at = kfs.find((kf) => Math.abs(kf.t - local) < 1e-4);
          const ease: Easing = at?.ease ?? kfs.filter((kf) => kf.t < local).pop()?.ease ?? "linear";
          left.keyframes[k] = [...kfs.filter((kf) => kf.t < local - 1e-4), { id: uid(), t: local, v, ease }];
          right.keyframes[k] = [
            { id: uid(), t: 0, v, ease },
            ...kfs.filter((kf) => kf.t > local + 1e-4).map((kf) => ({ ...kf, id: uid(), t: kf.t - local })),
          ];
        }
        next = next.flatMap((x) => (x.id === c.id ? [left, right] : [x]));
        if (c.id === selected?.id || (!selectId && !selected)) selectId = right.id;
      }
      set({ clips: next, selection: selectId ? { kind: "clip", clipId: selectId } : selection });
    },

    unlinkClip: (id) =>
      set((s) => {
        const clip = s.clips.find((c) => c.id === id);
        if (!clip?.linkId) return {};
        return { clips: s.clips.map((c) => (c.linkId === clip.linkId ? { ...c, linkId: null } : c)) };
      }),

    setTransition: (clipId, patch) =>
      set((s) => ({ clips: mapClip(s.clips, clipId, (c) => ({ ...c, transitionIn: { ...c.transitionIn, ...patch } })) })),

    setFades: (clipId, patch) =>
      set((s) => ({
        clips: mapClip(s.clips, clipId, (c) => {
          const dur = clipDuration(c);
          const fadeIn = Math.max(0, Math.min(dur, patch.fadeIn ?? c.fadeIn));
          const fadeOut = Math.max(0, Math.min(dur - fadeIn, patch.fadeOut ?? c.fadeOut));
          return { ...c, fadeIn, fadeOut };
        }),
      })),

    // ---- Keyframes ------------------------------------------------------------------------

    setPropValue: (clipId, prop, localT, v) =>
      set((s) => ({
        clips: mapClip(s.clips, clipId, (c) => {
          const kfs = c.keyframes[prop];
          if (kfs.length === 0) return { ...c, base: { ...c.base, [prop]: v } };
          const hit = keyframeNear(kfs, localT, s.settings.fps);
          const next = hit
            ? kfs.map((k) => (k.id === hit.id ? { ...k, v } : k))
            : sortKeyframes([...kfs, { id: uid(), t: localT, v, ease: "linear" as Easing }]);
          return { ...c, keyframes: { ...c.keyframes, [prop]: next } };
        }),
      })),

    toggleKeyframe: (clipId, prop, localT) =>
      set((s) => ({
        clips: mapClip(s.clips, clipId, (c) => {
          const kfs = c.keyframes[prop];
          const hit = keyframeNear(kfs, localT, s.settings.fps);
          if (hit) {
            const rest = kfs.filter((k) => k.id !== hit.id);
            // Removing the last keyframe bakes its value into the static base.
            const base = rest.length === 0 ? { ...c.base, [prop]: hit.v } : c.base;
            return { ...c, base, keyframes: { ...c.keyframes, [prop]: rest } };
          }
          const v = valueAt(c, prop, localT);
          const kf: Keyframe = { id: uid(), t: localT, v, ease: "linear" };
          return { ...c, keyframes: { ...c.keyframes, [prop]: sortKeyframes([...kfs, kf]) } };
        }),
      })),

    updateKeyframe: (clipId, prop, kfId, patch) =>
      set((s) => ({
        clips: mapClip(s.clips, clipId, (c) => {
          const dur = clipDuration(c);
          const next = c.keyframes[prop].map((k) =>
            k.id === kfId ? { ...k, ...patch, t: Math.max(0, Math.min(dur, patch.t ?? k.t)) } : k,
          );
          return { ...c, keyframes: { ...c.keyframes, [prop]: sortKeyframes(next) } };
        }),
      })),

    removeKeyframe: (clipId, prop, kfId) =>
      set((s) => ({
        clips: mapClip(s.clips, clipId, (c) => {
          const kfs = c.keyframes[prop];
          const gone = kfs.find((k) => k.id === kfId);
          const rest = kfs.filter((k) => k.id !== kfId);
          const base = rest.length === 0 && gone ? { ...c.base, [prop]: gone.v } : c.base;
          return { ...c, base, keyframes: { ...c.keyframes, [prop]: rest } };
        }),
      })),

    resetTransform: (clipId) =>
      set((s) => ({
        clips: mapClip(s.clips, clipId, (c) => ({ ...c, base: defaultBase(), keyframes: emptyKeyframes(), fadeIn: 0, fadeOut: 0 })),
      })),

    // ---- Transport & UI ----------------------------------------------------------------------

    seek: (t) => {
      const total = timelineEnd(get().clips);
      set({ currentTime: Math.max(0, Math.min(total, t)) });
    },
    setPlaying: (playing) => {
      if (playing) {
        const { currentTime, clips } = get();
        const total = timelineEnd(clips);
        if (total === 0) return;
        if (currentTime >= total - 1e-3) set({ currentTime: 0 });
      }
      set({ playing });
    },
    // Picking something on the timeline brings the inspector forward.
    select: (selection) => set(selection ? { selection, rightTab: "inspector" } : { selection }),
    setZoom: (zoom) => set({ zoom: Math.max(5, Math.min(400, zoom)) }),
    setSnapping: (snapping) => set({ snapping }),
    setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
    notify: (level, text) => {
      const id = uid();
      set((s) => ({ notices: [...s.notices, { id, level, text }] }));
      setTimeout(() => get().dismiss(id), level === "error" ? 9000 : 6000);
    },
    dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
  };
});
