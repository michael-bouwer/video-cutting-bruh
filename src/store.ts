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
  Transition,
} from "./types";
import { defaultBase, emptyKeyframes, PROP_KEYS } from "./lib/props";
import { keyframeNear, sortKeyframes, valueAt } from "./lib/keyframes";
import { clipDuration, layoutClips } from "./lib/timeline";
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

const MIN_CLIP = 0.1;

interface State {
  media: MediaItem[];
  clips: Clip[];
  settings: ProjectSettings;
  currentTime: number;
  playing: boolean;
  selection: Selection;
  /** Timeline zoom in pixels per second. */
  zoom: number;
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

  appendClip: (mediaId: string) => void;
  /** Adds a clip of `mediaId` at timeline position `index` (end if omitted). */
  insertClip: (mediaId: string, index?: number) => void;
  duplicateClip: (id: string) => void;
  removeClip: (id: string) => void;
  moveClip: (id: string, toIndex: number) => void;
  trimClip: (id: string, trimIn: number, trimOut: number) => void;
  splitAtPlayhead: () => void;
  setTransition: (clipId: string, patch: Partial<Transition>) => void;

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
  setSettings: (patch: Partial<ProjectSettings>) => void;
  notify: (level: Notice["level"], text: string) => void;
  dismiss: (id: string) => void;
}

const mapClip = (clips: Clip[], id: string, fn: (c: Clip) => Clip) => clips.map((c) => (c.id === id ? fn(c) : c));

export const useStore = create<State>((set, get) => ({
  media: [],
  clips: [],
  settings: { width: 1920, height: 1080, fps: 30, allowHdr: false, proxyMode: "auto", proxyQuality: "full" },
  currentTime: 0,
  playing: false,
  selection: null,
  zoom: 80,
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
      const removed = new Set(s.clips.filter((c) => c.mediaId === id).map((c) => c.id));
      const selection = s.selection && removed.has(s.selection.clipId) ? null : s.selection;
      return { media: s.media.filter((m) => m.id !== id), clips, selection };
    }),

  appendClip: (mediaId) => get().insertClip(mediaId),

  insertClip: (mediaId, index) => {
    const m = get().media.find((x) => x.id === mediaId);
    // Proxying media can already be placed: its duration is known from the probe.
    if (!m || m.status === "error" || !(m.duration > 0)) return;
    const clip: Clip = {
      id: uid(),
      mediaId,
      trimIn: 0,
      trimOut: m.duration,
      transitionIn: { type: "cut", duration: 1 },
      base: defaultBase(),
      keyframes: emptyKeyframes(),
    };
    set((s) => {
      const clips = [...s.clips];
      clips.splice(index ?? clips.length, 0, clip);
      return { clips, selection: { kind: "clip", clipId: clip.id } };
    });
  },

  duplicateClip: (id) =>
    set((s) => {
      const idx = s.clips.findIndex((c) => c.id === id);
      if (idx < 0) return {};
      const src = s.clips[idx];
      const copy: Clip = {
        ...structuredClone(src),
        id: uid(),
        transitionIn: { ...src.transitionIn, type: "cut" },
      };
      for (const k of PROP_KEYS) copy.keyframes[k] = copy.keyframes[k].map((kf) => ({ ...kf, id: uid() }));
      const clips = [...s.clips];
      clips.splice(idx + 1, 0, copy);
      return { clips, selection: { kind: "clip", clipId: copy.id } };
    }),

  removeClip: (id) =>
    set((s) => ({
      clips: s.clips.filter((c) => c.id !== id),
      selection: s.selection?.clipId === id ? null : s.selection,
    })),

  moveClip: (id, toIndex) =>
    set((s) => {
      const from = s.clips.findIndex((c) => c.id === id);
      if (from < 0) return {};
      const clips = [...s.clips];
      const [c] = clips.splice(from, 1);
      clips.splice(Math.max(0, Math.min(clips.length, toIndex)), 0, c);
      return { clips };
    }),

  trimClip: (id, trimIn, trimOut) =>
    set((s) => ({
      clips: mapClip(s.clips, id, (c) => {
        const m = s.media.find((x) => x.id === c.mediaId);
        // Stills can be stretched to any length; videos are limited by the file.
        const max = m?.kind === "image" ? IMAGE_MAX_DURATION : (m?.duration ?? c.trimOut);
        const tin = Math.max(0, Math.min(trimIn, trimOut - MIN_CLIP));
        const tout = Math.min(max, Math.max(trimOut, tin + MIN_CLIP));
        // Keep keyframes pinned to the same source frame when the head is trimmed.
        const shift = c.trimIn - tin;
        const keyframes =
          shift === 0
            ? c.keyframes
            : (Object.fromEntries(
                PROP_KEYS.map((k) => [k, c.keyframes[k].map((kf) => ({ ...kf, t: kf.t + shift }))]),
              ) as Clip["keyframes"]);
        return { ...c, trimIn: tin, trimOut: tout, keyframes };
      }),
    })),

  splitAtPlayhead: () => {
    const { clips, currentTime, notify } = get();
    const layout = layoutClips(clips);
    // Prefer a clip that isn't mid-transition at this point.
    const hits = layout.items.filter((p) => currentTime > p.start && currentTime < p.end);
    const target = hits[hits.length - 1];
    if (!target) return notify("info", "Move the playhead over a clip to split it.");
    const local = currentTime - target.start;
    if (local < MIN_CLIP || target.duration - local < MIN_CLIP) return;

    const c = target.clip;
    const left: Clip = { ...c, trimOut: c.trimIn + local, keyframes: emptyKeyframes() };
    const right: Clip = {
      ...c,
      id: uid(),
      trimIn: c.trimIn + local,
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
    set((s) => {
      const idx = s.clips.findIndex((x) => x.id === c.id);
      const next = [...s.clips];
      next.splice(idx, 1, left, right);
      return { clips: next, selection: { kind: "clip", clipId: right.id } };
    });
  },

  setTransition: (clipId, patch) =>
    set((s) => ({ clips: mapClip(s.clips, clipId, (c) => ({ ...c, transitionIn: { ...c.transitionIn, ...patch } })) })),

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
    set((s) => ({ clips: mapClip(s.clips, clipId, (c) => ({ ...c, base: defaultBase(), keyframes: emptyKeyframes() })) })),

  seek: (t) => {
    const total = layoutClips(get().clips).total;
    set({ currentTime: Math.max(0, Math.min(total, t)) });
  },
  setPlaying: (playing) => {
    if (playing) {
      const { currentTime, clips } = get();
      const total = layoutClips(clips).total;
      if (total === 0) return;
      if (currentTime >= total - 1e-3) set({ currentTime: 0 });
    }
    set({ playing });
  },
  // Picking something on the timeline brings the inspector forward.
  select: (selection) => set(selection ? { selection, rightTab: "inspector" } : { selection }),
  setZoom: (zoom) => set({ zoom: Math.max(10, Math.min(400, zoom)) }),
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  notify: (level, text) => {
    const id = uid();
    set((s) => ({ notices: [...s.notices, { id, level, text }] }));
    setTimeout(() => get().dismiss(id), level === "error" ? 9000 : 6000);
  },
  dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
}));
