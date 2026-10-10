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
  track: TrackKind;
}

/**
 * Registry of animatable properties. To add a new one: extend `AnimProp`,
 * add an entry here, and apply it in `engine/player.ts`.
 */
export const PROPS: PropDef[] = [
  { key: "x", label: "Position X", unit: "%", default: 0, min: -100, max: 100, step: 0.1, track: "video" },
  { key: "y", label: "Position Y", unit: "%", default: 0, min: -100, max: 100, step: 0.1, track: "video" },
  { key: "scale", label: "Scale", unit: "%", default: 100, min: 0, max: 400, step: 0.5, track: "video" },
  { key: "rotation", label: "Rotation", unit: "°", default: 0, min: -360, max: 360, step: 0.5, track: "video" },
  { key: "opacity", label: "Opacity", unit: "%", default: 100, min: 0, max: 100, step: 1, track: "video" },
  { key: "volume", label: "Volume", unit: "%", default: 100, min: 0, max: 100, step: 1, track: "audio" },
];

export const PROP_KEYS = PROPS.map((p) => p.key);
export const propsFor = (kind: TrackKind) => PROPS.filter((p) => p.track === kind);

export function defaultBase(): Record<AnimProp, number> {
  return Object.fromEntries(PROPS.map((p) => [p.key, p.default])) as Record<AnimProp, number>;
}

export function emptyKeyframes(): Record<AnimProp, Keyframe[]> {
  return Object.fromEntries(PROPS.map((p) => [p.key, []])) as unknown as Record<AnimProp, Keyframe[]>;
}
