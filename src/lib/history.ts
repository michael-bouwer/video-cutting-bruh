import { useStore } from "../store";
import type { Clip } from "../types";

/**
 * Undo/redo for timeline edits (clips, transitions, keyframes).
 *
 * Rather than instrumenting every store action, we watch the `clips` array:
 * each new reference is an edit. Continuous gestures (dragging a trim handle,
 * scrubbing a slider) produce many updates, so changes made while the same
 * pointer press is held — or in quick succession from the keyboard, like typing
 * a number — are coalesced into a single undo step.
 *
 * Media bin contents and project settings are intentionally not part of history.
 */

const LIMIT = 200;
const COALESCE_MS = 400;

let past: Clip[][] = [];
let future: Clip[][] = [];
let applying = false;
let pointerDown = false;
let gestureRecorded = false;
let lastChange = 0;

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
    if (applying || s.clips === prev.clips) return;
    const now = performance.now();
    const coalesce = pointerDown ? gestureRecorded : now - lastChange < COALESCE_MS;
    lastChange = now;
    if (pointerDown) gestureRecorded = true;
    if (coalesce) return;
    past.push(prev.clips);
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

function apply(clips: Clip[]) {
  applying = true;
  const s = useStore.getState();
  // Media removed since the snapshot can't come back, so drop its clips.
  const live = new Set(s.media.map((m) => m.id));
  const next = clips.filter((c) => live.has(c.mediaId));
  const selection = s.selection && next.some((c) => c.id === s.selection!.clipId) ? s.selection : null;
  useStore.setState({ clips: next, selection });
  applying = false;
  lastChange = 0;
}

export function undo() {
  const prev = past.pop();
  if (!prev) return;
  future.push(useStore.getState().clips);
  apply(prev);
  publish();
}

export function redo() {
  const next = future.pop();
  if (!next) return;
  past.push(useStore.getState().clips);
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
