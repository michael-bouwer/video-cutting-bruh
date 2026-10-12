import { create } from "zustand";
import { useStore, type AttributePart } from "../store";
import type { Clip } from "../types";

/**
 * Copy / paste attributes: copy one clip, then paste chosen groups of its
 * settings (transform, crop, speed, effects, volume & fades, colour label)
 * onto other clips. Pasting opens a small dialog to pick the groups.
 */

interface AttrState {
  /** A snapshot of the copied clip (later edits to it don't change the clipboard). */
  copied: Clip | null;
  /** Clips the paste dialog will apply to; null = closed. */
  pasteTargets: string[] | null;
}

export const useAttributes = create<AttrState>(() => ({ copied: null, pasteTargets: null }));

export const ATTRIBUTE_PARTS: { key: AttributePart; label: string; hint: string }[] = [
  { key: "transform", label: "Transform", hint: "Position, scale, rotation and opacity (with keyframes)" },
  { key: "crop", label: "Crop", hint: "Crop edges (with keyframes)" },
  { key: "speed", label: "Speed", hint: "Speed and speed ramps (changes the clip's length)" },
  { key: "effects", label: "Effects", hint: "The whole effect stack (replaces the target's effects)" },
  { key: "volume", label: "Volume & fades", hint: "Audio volume keyframes and fade in/out" },
  { key: "color", label: "Colour label", hint: "The clip's colour on the timeline" },
];

const selectedIds = () => {
  const s = useStore.getState();
  if (s.clipSelection.length) return s.clipSelection;
  return s.selection?.kind === "clip" ? [s.selection.clipId] : [];
};

export function copyAttributes(clipId?: string) {
  const s = useStore.getState();
  const id = clipId ?? (s.selection?.kind === "clip" ? s.selection.clipId : undefined);
  const clip = id ? s.clips.find((c) => c.id === id) : undefined;
  if (!clip) return s.notify("info", "Select a clip to copy its attributes.");
  useAttributes.setState({ copied: structuredClone(clip) });
  s.notify("info", "Attributes copied — select other clips and paste them (Ctrl/⌘+Alt+V).");
}

/** Opens the paste dialog for the selected clips (or `ids`). */
export function pasteAttributes(ids?: string[]) {
  const { copied } = useAttributes.getState();
  const targets = ids ?? selectedIds();
  if (!copied) return useStore.getState().notify("info", "Copy a clip's attributes first (right-click a clip → Copy attributes).");
  if (!targets.length) return useStore.getState().notify("info", "Select the clips to paste attributes onto.");
  useAttributes.setState({ pasteTargets: targets });
}
