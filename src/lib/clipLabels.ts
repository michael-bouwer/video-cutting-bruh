import type { Clip, MediaItem } from "../types";
import { titleSummary } from "./titles";

/** Colour labels for clips; stored on the clip by key. */
export const CLIP_COLORS: { key: string; label: string; hue: number }[] = [
  { key: "red", label: "Red", hue: 0 },
  { key: "orange", label: "Orange", hue: 28 },
  { key: "yellow", label: "Yellow", hue: 50 },
  { key: "green", label: "Green", hue: 120 },
  { key: "teal", label: "Teal", hue: 175 },
  { key: "blue", label: "Blue", hue: 212 },
  { key: "purple", label: "Purple", hue: 272 },
  { key: "pink", label: "Pink", hue: 320 },
];

export const colorHue = (key: string | undefined) => CLIP_COLORS.find((c) => c.key === key)?.hue;

/** What a clip is called on the timeline: its custom name, the text of a title, or the file name. */
export function clipName(c: Clip, m: MediaItem | undefined): string {
  if (c.label) return c.label;
  if (c.title) return `T  ${titleSummary(c.title)}`;
  return m?.name ?? "missing media";
}
