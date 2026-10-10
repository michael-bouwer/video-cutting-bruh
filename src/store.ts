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
  Effect,
  EffectType,
  KeyframeRef,
} from "./types";
import { defaultBase, emptyKeyframes, PROP_KEYS } from "./lib/props";
import { interpolate, keyframeNear, randomKeyframeColor, sortKeyframes } from "./lib/keyframes";
import { effectDef, newEffect } from "./lib/effects";
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
  /** Tracks whose keyframe lanes are expanded in the timeline (UI only, not saved). */
  expandedTracks: Record<string, boolean>;
  toggleTrackExpanded: (trackId: string) => void;
  /** Keyframes selected in the timeline's keyframe lanes. */
  kfSelection: KeyframeRef[];
  selectKeyframes: (refs: KeyframeRef[], mode?: "replace" | "toggle" | "add") => void;
  /** Sets clip-local times of keyframes (clamped to their clip); used when dragging in lanes. */
  setKeyframeTimes: (updates: { ref: KeyframeRef; t: number }[]) => void;
  deleteKeyframes: (refs: KeyframeRef[]) => void;
  rerollKeyframeColor: (ref: KeyframeRef) => void;
  /** Inserts keyframes (replacing any at the same time) and returns their refs. */
  insertKeyframes: (items: { clipId: string; fx: string | null; key: string; t: number; v: number; ease: Easing }[]) => KeyframeRef[];
  /** Effects pop-out panel (left of the inspector) is open. */
  effectsOpen: boolean;
  setEffectsOpen: (open: boolean) => void;
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
  /** Removes several clips (with their linked clips). */
  removeClips: (ids: string[]) => void;
  /** All selected clips (the primary one is `selection`); used for multi-select. */
  clipSelection: string[];
  selectClips: (ids: string[], mode?: "replace" | "toggle" | "add") => void;
  /** Moves several clips (and their linked clips) by the same amount, if they all fit. Returns the delta applied. */
  moveClipsBy: (ids: string[], delta: number) => number;
  /** Closes the gap before (`left`) or after (`right`) a clip. `ripple` (left only) also pulls every later clip on the track. */
  closeGap: (id: string, side: "left" | "right", ripple?: boolean) => void;
  /** Splits the selected clip (or every clip) under the playhead. */
  splitAtPlayhead: () => void;
  unlinkClip: (id: string) => void;
  setTransition: (clipId: string, patch: Partial<Transition>) => void;
  setFades: (clipId: string, patch: { fadeIn?: number; fadeOut?: number }) => void;

  // Effects
  addEffect: (clipId: string, type: EffectType) => void;
  removeEffect: (clipId: string, fxId: string) => void;
  setEffectEnabled: (clipId: string, fxId: string, enabled: boolean) => void;
  moveEffect: (clipId: string, fxId: string, dir: -1 | 1) => void;
  resetEffect: (clipId: string, fxId: string) => void;
  /** Sets a parameter at clip-local time (keyframe if animated, else the static value). */
  setEffectParam: (clipId: string, fxId: string, key: string, localT: number, v: number) => void;
  toggleEffectKeyframe: (clipId: string, fxId: string, key: string, localT: number) => void;
  setEffectKeyframeEase: (clipId: string, fxId: string, key: string, kfId: string, ease: Easing) => void;

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

function shiftKeyframes(c: Clip, by: number): Pick<Clip, "keyframes" | "effects"> {
  if (by === 0) return { keyframes: c.keyframes, effects: c.effects };
  const shift = (kfs: Keyframe[]) => kfs.map((kf) => ({ ...kf, t: kf.t + by }));
  return {
    keyframes: Object.fromEntries(PROP_KEYS.map((k) => [k, shift(c.keyframes[k])])) as Clip["keyframes"],
    effects: c.effects.map((fx) => ({
      ...fx,
      keyframes: Object.fromEntries(Object.entries(fx.keyframes).map(([k, kfs]) => [k, shift(kfs)])),
    })),
  };
}

// Keyframe track edits shared by transform properties and effect parameters.

/** Sets a value at `t`: updates/creates a keyframe if the track is animated, else the static value. */
function kfSet(kfs: Keyframe[], base: number, t: number, v: number, fps: number): { kfs: Keyframe[]; base: number } {
  if (kfs.length === 0) return { kfs, base: v };
  const hit = keyframeNear(kfs, t, fps);
  const next = hit ? kfs.map((k) => (k.id === hit.id ? { ...k, v, split: undefined } : k)) : sortKeyframes([...kfs, { id: uid(), t, v, ease: "linear" as Easing, color: randomKeyframeColor() }]);
  return { kfs: next, base };
}

/** Adds a keyframe at `t` (with the current value), or removes the one there. */
function kfToggle(kfs: Keyframe[], base: number, t: number, fps: number): { kfs: Keyframe[]; base: number } {
  const hit = keyframeNear(kfs, t, fps);
  if (hit) {
    const rest = kfs.filter((k) => k.id !== hit.id);
    // Removing the last keyframe bakes its value into the static value.
    return { kfs: rest, base: rest.length === 0 ? hit.v : base };
  }
  return { kfs: sortKeyframes([...kfs, { id: uid(), t, v: interpolate(kfs, base, t), ease: "linear", color: randomKeyframeColor() }]), base };
}

/** Splits one keyframe track at clip-local `at`, pinning the value there on both sides. */
function kfSplit(kfs: Keyframe[], base: number, at: number): [Keyframe[], Keyframe[]] {
  if (kfs.length === 0) return [[], []];
  const v = interpolate(kfs, base, at);
  const exact = kfs.find((kf) => Math.abs(kf.t - at) < 1e-4);
  const ease: Easing = exact?.ease ?? kfs.filter((kf) => kf.t < at).pop()?.ease ?? "linear";
  return [
    // A keyframe that already sat exactly on the cut is real, so its copies aren't marked as split-created.
    [...kfs.filter((kf) => kf.t < at - 1e-4), { id: uid(), t: at, v, ease, color: exact?.color ?? randomKeyframeColor(), split: !exact || undefined }],
    [
      { id: uid(), t: 0, v, ease, color: exact?.color ?? randomKeyframeColor(), split: !exact || undefined },
      ...kfs.filter((kf) => kf.t > at + 1e-4).map((kf) => ({ ...kf, id: uid(), t: kf.t - at })),
    ],
  ];
}

/** Applies `fn` to each keyframe track named by `refs` (transform props or effect params) on a clip. */
function updateTracks(c: Clip, refs: KeyframeRef[], fn: (kfs: Keyframe[], ref: KeyframeRef) => Keyframe[]): Clip {
  let next = c;
  for (const ref of refs) {
    if (ref.fx) {
      next = mapEffect(next, ref.fx, (fx) => ({ ...fx, keyframes: { ...fx.keyframes, [ref.key]: fn(fx.keyframes[ref.key] ?? [], ref) } }));
    } else {
      const key = ref.key as AnimProp;
      next = { ...next, keyframes: { ...next.keyframes, [key]: fn(next.keyframes[key], ref) } };
    }
  }
  return next;
}

/** Removes split-created keyframes at clip-local time `at` (keeping the value as static if a track empties). */
function dropSplitPins(c: Clip, at: number): Clip {
  const strip = (kfs: Keyframe[], base: number) => {
    const pin = kfs.find((k) => k.split && Math.abs(k.t - at) < 1e-3);
    if (!pin) return { kfs, base };
    const rest = kfs.filter((k) => k !== pin);
    return { kfs: rest, base: rest.length ? base : pin.v };
  };
  const keyframes = { ...c.keyframes };
  const base = { ...c.base };
  for (const k of PROP_KEYS) {
    const r = strip(c.keyframes[k], c.base[k]);
    keyframes[k] = r.kfs;
    base[k] = r.base;
  }
  const effects = c.effects.map((fx) => {
    const kf = { ...fx.keyframes };
    const params = { ...fx.params };
    for (const [key, kfs] of Object.entries(fx.keyframes)) {
      const r = strip(kfs, fx.params[key]);
      kf[key] = r.kfs;
      params[key] = r.base;
    }
    return { ...fx, keyframes: kf, params };
  });
  return { ...c, keyframes, base, effects };
}

const mapEffect = (c: Clip, fxId: string, fn: (fx: Effect) => Effect): Clip => ({
  ...c,
  effects: c.effects.map((fx) => (fx.id === fxId ? fn(fx) : fx)),
});

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
    effects: [],
  };
}

export const useStore = create<State>((set, get) => {
  const isLocked = (trackId: string) => get().tracks.find((t) => t.id === trackId)?.locked ?? false;
  const isImage = (c: Clip) => get().media.find((x) => x.id === c.mediaId)?.kind === "image";
  const maxDuration = (c: Clip) => {
    const m = get().media.find((x) => x.id === c.mediaId);
    return m?.kind === "image" ? IMAGE_MAX_DURATION : (m?.duration || c.trimOut);
  };

  /**
   * Removes clips. Neighbours that were split from a removed clip lose the
   * keyframe the split pinned at their shared cut (it only existed to keep the
   * motion continuous into the removed segment).
   */
  const removeSet = (gone: Set<string>) =>
    set((s) => {
      const removed = s.clips.filter((c) => gone.has(c.id));
      const clips = s.clips
        .filter((c) => !gone.has(c.id))
        .map((c) => {
          let next = c;
          for (const r of removed) {
            if (r.trackId !== c.trackId || r.mediaId !== c.mediaId) continue;
            // Was `c` the left half of a split with `r`? Then drop pins at c's end; right half → pins at 0.
            const leftOf = Math.abs(clipEnd(c) - r.start) < TOUCH_EPS && Math.abs(c.trimOut - r.trimIn) < 1e-3;
            const rightOf = Math.abs(clipEnd(r) - c.start) < TOUCH_EPS && Math.abs(r.trimOut - c.trimIn) < 1e-3;
            if (!leftOf && !rightOf) continue;
            const at = leftOf ? clipDuration(c) : 0;
            next = dropSplitPins(next, at);
          }
          return next;
        });
      const live = new Set(clips.map((c) => c.id));
      return {
        clips,
        selection: s.selection && !live.has(s.selection.clipId) ? null : s.selection,
        clipSelection: s.clipSelection.filter((id) => live.has(id)),
        kfSelection: s.kfSelection.filter((r) => live.has(r.clipId)),
      };
    });

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
    expandedTracks: {},
    toggleTrackExpanded: (trackId) => set((s) => ({ expandedTracks: { ...s.expandedTracks, [trackId]: !s.expandedTracks[trackId] } })),
    kfSelection: [],
    selectKeyframes: (refs, mode = "replace") =>
      set((s) => {
        const same = (a: KeyframeRef, b: KeyframeRef) => a.kfId === b.kfId && a.clipId === b.clipId && a.key === b.key && a.fx === b.fx;
        if (mode === "replace") return { kfSelection: refs };
        if (mode === "add") return { kfSelection: [...s.kfSelection, ...refs.filter((r) => !s.kfSelection.some((x) => same(x, r)))] };
        const next = [...s.kfSelection];
        for (const r of refs) {
          const i = next.findIndex((x) => same(x, r));
          if (i >= 0) next.splice(i, 1);
          else next.push(r);
        }
        return { kfSelection: next };
      }),

    setKeyframeTimes: (updates) =>
      set((s) => {
        const byClip = new Map<string, { ref: KeyframeRef; t: number }[]>();
        for (const u of updates) byClip.set(u.ref.clipId, [...(byClip.get(u.ref.clipId) ?? []), u]);
        return {
          clips: s.clips.map((c) => {
            const ups = byClip.get(c.id);
            if (!ups) return c;
            const dur = clipDuration(c);
            return updateTracks(c, ups.map((u) => u.ref), (kfs, ref) => {
              const u = ups.find((x) => x.ref === ref)!;
              return sortKeyframes(kfs.map((k) => (k.id === ref.kfId ? { ...k, t: Math.max(0, Math.min(dur, u.t)), split: undefined } : k)));
            });
          }),
        };
      }),

    deleteKeyframes: (refs) =>
      set((s) => {
        const ids = new Set(refs.map((r) => r.kfId));
        const clips = s.clips.map((c) => {
          const mine = refs.filter((r) => r.clipId === c.id);
          if (!mine.length) return c;
          // Like toggling off: if a track loses its last keyframe, keep that value as the static one.
          let next = c;
          for (const r of mine) {
            if (r.fx) {
              next = mapEffect(next, r.fx, (fx) => {
                const kfs = fx.keyframes[r.key] ?? [];
                const rest = kfs.filter((k) => !ids.has(k.id));
                const last = kfs.find((k) => k.id === r.kfId);
                return { ...fx, params: rest.length === 0 && last ? { ...fx.params, [r.key]: last.v } : fx.params, keyframes: { ...fx.keyframes, [r.key]: rest } };
              });
            } else {
              const key = r.key as AnimProp;
              const kfs = next.keyframes[key];
              const rest = kfs.filter((k) => !ids.has(k.id));
              const last = kfs.find((k) => k.id === r.kfId);
              next = { ...next, base: rest.length === 0 && last ? { ...next.base, [key]: last.v } : next.base, keyframes: { ...next.keyframes, [key]: rest } };
            }
          }
          return next;
        });
        return { clips, kfSelection: s.kfSelection.filter((r) => !ids.has(r.kfId)) };
      }),

    rerollKeyframeColor: (ref) =>
      set((s) => ({
        clips: s.clips.map((c) =>
          c.id !== ref.clipId ? c : updateTracks(c, [ref], (kfs) => kfs.map((k) => (k.id === ref.kfId ? { ...k, color: randomKeyframeColor() } : k))),
        ),
      })),

    insertKeyframes: (items) => {
      const refs: KeyframeRef[] = [];
      const fps = get().settings.fps;
      set((s) => ({
        clips: s.clips.map((c) => {
          const mine = items.filter((it) => it.clipId === c.id);
          if (!mine.length) return c;
          const dur = clipDuration(c);
          let next = c;
          for (const it of mine) {
            const t = Math.max(0, Math.min(dur, it.t));
            const kf: Keyframe = { id: uid(), t, v: it.v, ease: it.ease, color: randomKeyframeColor() };
            const add = (kfs: Keyframe[]) => {
              const hit = keyframeNear(kfs, t, fps);
              return sortKeyframes([...kfs.filter((k) => k !== hit), kf]);
            };
            if (it.fx) next = mapEffect(next, it.fx, (fx) => ({ ...fx, keyframes: { ...fx.keyframes, [it.key]: add(fx.keyframes[it.key] ?? []) } }));
            else next = { ...next, keyframes: { ...next.keyframes, [it.key]: add(next.keyframes[it.key as AnimProp]) } };
            refs.push({ clipId: c.id, fx: it.fx, key: it.key, kfId: kf.id });
          }
          return next;
        }),
      }));
      return refs;
    },
    effectsOpen: (() => {
      try {
        return localStorage.getItem("vcb.effectsOpen") === "1";
      } catch {
        return false;
      }
    })(),
    setEffectsOpen: (effectsOpen) => {
      try {
        localStorage.setItem("vcb.effectsOpen", effectsOpen ? "1" : "0");
      } catch {
        /* per-device preference */
      }
      set({ effectsOpen });
    },
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
            ...shiftKeyframes(c, -delta),
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

    removeClip: (id, single = false) => {
      const clip = get().clips.find((c) => c.id === id);
      if (!clip) return;
      if (single) {
        if (!isLocked(clip.trackId)) removeSet(new Set([clip.id]));
      } else get().removeClips([id]);
    },

    removeClips: (ids) => {
      const { clips } = get();
      const gone = new Set<string>();
      for (const id of ids) {
        const clip = clips.find((c) => c.id === id);
        if (clip) for (const c of groupOf(clips, clip)) if (!isLocked(c.trackId)) gone.add(c.id);
      }
      if (gone.size) removeSet(gone);
    },

    clipSelection: [],
    selectClips: (ids, mode = "replace") =>
      set((s) => {
        let next: string[];
        if (mode === "replace") next = [...new Set(ids)];
        else if (mode === "add") next = [...new Set([...s.clipSelection, ...ids])];
        else {
          next = [...s.clipSelection];
          for (const id of ids) next = next.includes(id) ? next.filter((x) => x !== id) : [...next, id];
        }
        // The inspector shows the last-added clip.
        const primary = next.length ? next[next.length - 1] : null;
        return {
          clipSelection: next,
          selection: primary ? { kind: "clip", clipId: primary } : s.selection?.kind === "transition" ? s.selection : null,
          ...(primary ? { rightTab: "inspector" as const } : {}),
        };
      }),

    moveClipsBy: (ids, delta) => {
      const { clips } = get();
      const moving = new Set<string>();
      for (const id of ids) {
        const clip = clips.find((c) => c.id === id);
        if (clip) for (const c of groupOf(clips, clip)) moving.add(c.id);
      }
      const group = clips.filter((c) => moving.has(c.id));
      if (!group.length || group.some((c) => isLocked(c.trackId))) return 0;
      // Never past 0, and stop at the first collision along the way.
      let d = Math.max(delta, -Math.min(...group.map((c) => c.start)));
      const ok = (dd: number) => group.every((c) => fits(clips, c.trackId, c.start + dd, clipDuration(c), moving));
      if (!ok(d)) {
        // Back off towards 0 in small steps until everything fits.
        const steps = 60;
        let found = 0;
        for (let i = steps - 1; i >= 0; i--) {
          const dd = (d * i) / steps;
          if (ok(dd)) {
            found = dd;
            break;
          }
        }
        d = found;
      }
      if (Math.abs(d) < 1e-9) return 0;
      set((s) => ({ clips: s.clips.map((c) => (moving.has(c.id) ? { ...c, start: c.start + d } : c)) }));
      return d;
    },

    closeGap: (id, side, ripple = false) => {
      const { clips } = get();
      const clip = clips.find((c) => c.id === id);
      if (!clip || isLocked(clip.trackId)) return;
      const others = trackClips(clips, clip.trackId).filter((c) => c.id !== clip.id);
      if (side === "left") {
        const prevEnd = Math.max(0, ...others.filter((c) => clipEnd(c) <= clip.start + TOUCH_EPS).map(clipEnd));
        const gap = clip.start - prevEnd;
        if (gap <= TOUCH_EPS) return;
        if (ripple) {
          // This clip and everything after it on the track slide left together.
          const later = others.filter((c) => c.start >= clip.start - TOUCH_EPS).map((c) => c.id);
          get().moveClipsBy([clip.id, ...later], -gap);
        } else {
          get().moveClipsBy([clip.id], -gap);
        }
      } else {
        const next = others.filter((c) => c.start >= clipEnd(clip) - TOUCH_EPS).sort((a, b) => a.start - b.start)[0];
        if (!next) return;
        const gap = next.start - clipEnd(clip);
        if (gap > TOUCH_EPS) get().moveClipsBy([clip.id], gap);
      }
    },

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
        const left: Clip = { ...c, trimOut: c.trimIn + local, fadeOut: 0, keyframes: emptyKeyframes(), effects: [] };
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
          effects: [],
        };
        // Pin animated values at the split point on both sides so motion is continuous.
        for (const k of PROP_KEYS) [left.keyframes[k], right.keyframes[k]] = kfSplit(c.keyframes[k], c.base[k], local);
        for (const fx of c.effects) {
          const l: Effect = { ...fx, keyframes: {} };
          const rt: Effect = { ...fx, id: uid(), keyframes: {} };
          for (const [k, kfs] of Object.entries(fx.keyframes)) [l.keyframes[k], rt.keyframes[k]] = kfSplit(kfs, fx.params[k], local);
          left.effects.push(l);
          right.effects.push(rt);
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

    // ---- Effects ---------------------------------------------------------------------------

    addEffect: (clipId, type) =>
      set((s) => ({ clips: mapClip(s.clips, clipId, (c) => ({ ...c, effects: [...c.effects, newEffect(type, uid())] })) })),

    removeEffect: (clipId, fxId) =>
      set((s) => ({ clips: mapClip(s.clips, clipId, (c) => ({ ...c, effects: c.effects.filter((fx) => fx.id !== fxId) })) })),

    setEffectEnabled: (clipId, fxId, enabled) =>
      set((s) => ({ clips: mapClip(s.clips, clipId, (c) => mapEffect(c, fxId, (fx) => ({ ...fx, enabled }))) })),

    moveEffect: (clipId, fxId, dir) =>
      set((s) => ({
        clips: mapClip(s.clips, clipId, (c) => {
          const i = c.effects.findIndex((fx) => fx.id === fxId);
          const j = i + dir;
          if (i < 0 || j < 0 || j >= c.effects.length) return c;
          const effects = [...c.effects];
          [effects[i], effects[j]] = [effects[j], effects[i]];
          return { ...c, effects };
        }),
      })),

    resetEffect: (clipId, fxId) =>
      set((s) => ({
        clips: mapClip(s.clips, clipId, (c) => mapEffect(c, fxId, (fx) => ({ ...newEffect(fx.type, fx.id), enabled: fx.enabled }))),
      })),

    setEffectParam: (clipId, fxId, key, localT, v) =>
      set((s) => ({
        clips: mapClip(s.clips, clipId, (c) =>
          mapEffect(c, fxId, (fx) => {
            const def = effectDef(fx.type).params.find((p) => p.key === key);
            const clamped = def ? Math.max(def.min, Math.min(def.max, v)) : v;
            const r = kfSet(fx.keyframes[key] ?? [], fx.params[key], localT, clamped, s.settings.fps);
            return { ...fx, params: { ...fx.params, [key]: r.base }, keyframes: { ...fx.keyframes, [key]: r.kfs } };
          }),
        ),
      })),

    toggleEffectKeyframe: (clipId, fxId, key, localT) =>
      set((s) => ({
        clips: mapClip(s.clips, clipId, (c) =>
          mapEffect(c, fxId, (fx) => {
            const r = kfToggle(fx.keyframes[key] ?? [], fx.params[key], localT, s.settings.fps);
            return { ...fx, params: { ...fx.params, [key]: r.base }, keyframes: { ...fx.keyframes, [key]: r.kfs } };
          }),
        ),
      })),

    setEffectKeyframeEase: (clipId, fxId, key, kfId, ease) =>
      set((s) => ({
        clips: mapClip(s.clips, clipId, (c) =>
          mapEffect(c, fxId, (fx) => ({
            ...fx,
            keyframes: { ...fx.keyframes, [key]: (fx.keyframes[key] ?? []).map((k) => (k.id === kfId ? { ...k, ease } : k)) },
          })),
        ),
      })),

    // ---- Keyframes ------------------------------------------------------------------------

    setPropValue: (clipId, prop, localT, v) =>
      set((s) => ({
        clips: mapClip(s.clips, clipId, (c) => {
          const r = kfSet(c.keyframes[prop], c.base[prop], localT, v, s.settings.fps);
          return { ...c, base: { ...c.base, [prop]: r.base }, keyframes: { ...c.keyframes, [prop]: r.kfs } };
        }),
      })),

    toggleKeyframe: (clipId, prop, localT) =>
      set((s) => ({
        clips: mapClip(s.clips, clipId, (c) => {
          const r = kfToggle(c.keyframes[prop], c.base[prop], localT, s.settings.fps);
          return { ...c, base: { ...c.base, [prop]: r.base }, keyframes: { ...c.keyframes, [prop]: r.kfs } };
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
    select: (selection) =>
      set(
        selection
          ? { selection, rightTab: "inspector", clipSelection: selection.kind === "clip" ? [selection.clipId] : [] }
          : { selection, clipSelection: [] },
      ),
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
