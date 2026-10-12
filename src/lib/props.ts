import type { AnimProp, Keyframe, TrackKind } from "../types";

export interface PropDef {
  key: AnimProp;
  label: string;
  unit: string;
  default: number;
  min: number;
  max: number;
  step: number;
  /** Which kind of clip shows this property. */
  track: TrackKind | "both";
  /** Shown in this inspector section. */
  group: "transform" | "crop" | "speed" | "volume";
  /** Not for stills and text (e.g. speed). */
  mediaOnly?: boolean;
}

/**
 * Registry of animatable properties. To add a new one: extend `AnimProp`,
 * add an entry here, and apply it in `engine/player.ts`.
 */
export const PROPS: PropDef[] = [
  { key: "x", label: "Position X", unit: "%", default: 0, min: -100, max: 100, step: 0.1, track: "video", group: "transform" },
  { key: "y", label: "Position Y", unit: "%", default: 0, min: -100, max: 100, step: 0.1, track: "video", group: "transform" },
  { key: "scale", label: "Scale", unit: "%", default: 100, min: 0, max: 400, step: 0.5, track: "video", group: "transform" },
  { key: "rotation", label: "Rotation", unit: "°", default: 0, min: -360, max: 360, step: 0.5, track: "video", group: "transform" },
  { key: "opacity", label: "Opacity", unit: "%", default: 100, min: 0, max: 100, step: 1, track: "video", group: "transform" },
  { key: "cropLeft", label: "Left", unit: "%", default: 0, min: 0, max: 99, step: 0.1, track: "video", group: "crop" },
  { key: "cropRight", label: "Right", unit: "%", default: 0, min: 0, max: 99, step: 0.1, track: "video", group: "crop" },
  { key: "cropTop", label: "Top", unit: "%", default: 0, min: 0, max: 99, step: 0.1, track: "video", group: "crop" },
  { key: "cropBottom", label: "Bottom", unit: "%", default: 0, min: 0, max: 99, step: 0.1, track: "video", group: "crop" },
  { key: "volume", label: "Volume", unit: "%", default: 100, min: 0, max: 100, step: 1, track: "audio", group: "volume" },
  { key: "speed", label: "Speed", unit: "%", default: 100, min: 10, max: 400, step: 1, track: "both", group: "speed", mediaOnly: true },
];

export const PROP_KEYS = PROPS.map((p) => p.key);
export const propsFor = (kind: TrackKind) => PROPS.filter((p) => p.track === kind || p.track === "both");
/** Keyframe-all (K) and similar shortcuts skip these. */
export const TRANSFORM_KEYS: AnimProp[] = ["x", "y", "scale", "rotation", "opacity"];
/** Speed limits (%): the slider covers 10–400, typing allows this range. */
export const SPEED_MIN = 5;
export const SPEED_MAX = 1600;

export function defaultBase(): Record<AnimProp, number> {
  return Object.fromEntries(PROPS.map((p) => [p.key, p.default])) as Record<AnimProp, number>;
}

export function emptyKeyframes(): Record<AnimProp, Keyframe[]> {
  return Object.fromEntries(PROPS.map((p) => [p.key, []])) as unknown as Record<AnimProp, Keyframe[]>;
}
