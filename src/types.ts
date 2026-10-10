// ---- Media -----------------------------------------------------------------

export type HdrKind = "PQ" | "HLG" | "DolbyVision";

export interface ColorInfo {
  primaries: number | null;
  transfer: number | null;
  matrix: number | null;
  fullRange: boolean | null;
}

/** Mirrors `MediaProbe` in src-tauri/src/probe.rs. */
export interface MediaProbe {
  path: string;
  fileName: string;
  size: number;
  container: string;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  bitDepth: number | null;
  color: ColorInfo | null;
  hdr: HdrKind | null;
  dolbyVision: boolean;
  hdrMetadata: boolean;
  /** Whether the file has an audio track (null = unknown). */
  hasAudio: boolean | null;
}

export interface ProxyState {
  status: "generating" | "ready" | "error";
  /** 0..1 while generating. */
  progress: number;
  /** Encode job id (unique per attempt) — used for progress events and cancelling. */
  job?: string;
  path?: string;
  /** How it was made, e.g. "GPU (Vulkan) · h264_nvenc" or "cached". */
  method?: string;
  /** Pixel height of the proxy. */
  height?: number;
  error?: string;
}

/** Kind of media. Images become still clips (default 5 s, any length); audio goes on audio tracks. */
export type MediaKind = "video" | "image" | "audio";

export interface MediaItem {
  id: string;
  kind: MediaKind;
  /** When it was added to the project (ms since epoch) — for sorting. */
  addedAt: number;
  name: string;
  /** Original file — always used for export. */
  path: string;
  /** URL the preview loads: the proxy when one is in use, else the original. */
  src: string;
  probe: MediaProbe | null;
  /** "missing": the file referenced by a project couldn't be found (can be relinked). */
  status: "loading" | "proxying" | "ready" | "error" | "missing";
  error?: string;
  proxy?: ProxyState;
  duration: number;
  width: number;
  height: number;
}

// ---- Timeline ----------------------------------------------------------------

export type TransitionType =
  | "cut"
  | "crossfade"
  | "dipToBlack"
  | "wipeLeft"
  | "wipeRight"
  | "slideLeft"
  | "slideUp"
  | "iris";

export interface Transition {
  type: TransitionType;
  /** Requested duration in seconds; the effective one is clamped by clip lengths. */
  duration: number;
}

export type Easing = "linear" | "easeIn" | "easeOut" | "easeInOut" | "hold";

export interface Keyframe {
  id: string;
  /** Clip-local time in seconds (0 = first visible frame of the clip). */
  t: number;
  v: number;
  /** Easing used from this keyframe to the next one. */
  ease: Easing;
}

/** Animatable property keys. Add new ones in `lib/props.ts`. */
export type AnimProp = "x" | "y" | "scale" | "rotation" | "opacity" | "volume";

export type TrackKind = "video" | "audio";

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  /** Video: hidden from the output. */
  hidden: boolean;
  /** Audio: silenced. */
  muted: boolean;
  /** Audio: only soloed tracks are heard (if any track is soloed). */
  solo: boolean;
  /** Locked tracks can't be edited. */
  locked: boolean;
}

export interface Clip {
  id: string;
  mediaId: string;
  trackId: string;
  /** Position on the timeline in seconds (clips can be placed anywhere; gaps are allowed). */
  start: number;
  /** Source in/out points in seconds. The visible length is trimOut - trimIn. */
  trimIn: number;
  trimOut: number;
  /** Clips sharing a linkId (a video and its audio) move, trim, split and delete together. */
  linkId: string | null;
  /** Transition from the clip that ends where this one starts on the same track. */
  transitionIn: Transition;
  /** Audio only: fade lengths in seconds. */
  fadeIn: number;
  fadeOut: number;
  /** Static value used when a property has no keyframes. */
  base: Record<AnimProp, number>;
  keyframes: Record<AnimProp, Keyframe[]>;
}

/**
 * auto:   proxy only files the webview can't play, plus HDR (for proper tone mapping)
 * always: proxy everything (smoother scrubbing of heavy high-res/high-fps footage)
 * off:    always play originals
 */
export type ProxyMode = "auto" | "always" | "off";

/** Max proxy height; "full" keeps the source resolution. */
export type ProxyQuality = "full" | "1080" | "720";

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  allowHdr: boolean;
  proxyMode: ProxyMode;
  proxyQuality: ProxyQuality;
}

/** Mirrors `FfmpegStatus` in src-tauri/src/ffmpeg.rs. */
export interface FfmpegStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  canTonemap: boolean;
  /** Detected hardware support (null if ffmpeg is missing). */
  caps: { gpuFilters: boolean; encoder: string; zscale: boolean } | null;
}

export type Selection =
  | { kind: "clip"; clipId: string }
  | { kind: "transition"; clipId: string }
  | null;

export interface Notice {
  id: string;
  level: "info" | "warn" | "error";
  text: string;
}
