import { useStore } from "../store";
import type { Clip, Marker, Track } from "../types";

/**
 * Undo/redo for timeline edits (clips, tracks, markers, transitions, keyframes).
 *
 * Rather than instrumenting every store action, we watch the `clips`,
 * `tracks` and `markers` arrays: each new reference is an edit. Continuous gestures (dragging
 * a clip or trim handle, scrubbing a slider) produce many updates, so changes
 * made while the same pointer press is held — or in quick succession from the
 * keyboard, like typing a number — are coalesced into a single undo step.
 *
 * Media bin contents and project settings are intentionally not part of history.
 */

interface Snapshot {
  clips: Clip[];
  tracks: Track[];
  markers: Marker[];
}

const LIMIT = 200;
const COALESCE_MS = 400;

let past: Snapshot[] = [];
let future: Snapshot[] = [];
let applying = false;
let pointerDown = false;
let gestureRecorded = false;
let lastChange = 0;

const snapshot = (): Snapshot => {
  const s = useStore.getState();
  return { clips: s.clips, tracks: s.tracks, markers: s.markers };
};

function publish() {
  useStore.setState({ canUndo: past.length > 0, canRedo: future.length > 0 });
}

export function installHistory(): () => void {
  const down = () => {
    pointerDown = true;
    gestureRecorded = false;
  };
  const up = () => (pointerDown = false);
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);

  const unsubscribe = useStore.subscribe((s, prev) => {
    if (applying || (s.clips === prev.clips && s.tracks === prev.tracks && s.markers === prev.markers)) return;
    const now = performance.now();
    const coalesce = pointerDown ? gestureRecorded : now - lastChange < COALESCE_MS;
    lastChange = now;
    if (pointerDown) gestureRecorded = true;
    if (coalesce) return;
    past.push({ clips: prev.clips, tracks: prev.tracks, markers: prev.markers });
    if (past.length > LIMIT) past.shift();
    future = [];
    publish();
  });
  return () => {
    unsubscribe();
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
  };
}

function apply(snap: Snapshot) {
  applying = true;
  const s = useStore.getState();
  // Media removed since the snapshot can't come back, so drop its clips (text clips have no media).
  const live = new Set(s.media.map((m) => m.id));
  const clips = snap.clips.filter((c) => c.title || live.has(c.mediaId));
  const selection = s.selection && clips.some((c) => c.id === s.selection!.clipId) ? s.selection : null;
  useStore.setState({ clips, tracks: snap.tracks, markers: snap.markers, selection });
  applying = false;
  lastChange = 0;
}

export function undo() {
  const prev = past.pop();
  if (!prev) return;
  future.push(snapshot());
  apply(prev);
  publish();
}

export function redo() {
  const next = future.pop();
  if (!next) return;
  past.push(snapshot());
  apply(next);
  publish();
}

/** Clears history, e.g. after opening or creating a project. */
export function resetHistory() {
  past = [];
  future = [];
  publish();
}

/** Runs `fn` without recording history (used when loading projects). */
export function withoutHistory(fn: () => void) {
  applying = true;
  try {
    fn();
  } finally {
    applying = false;
  }
}
