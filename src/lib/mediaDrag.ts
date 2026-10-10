import { useStore } from "../store";
import { layoutClips } from "./timeline";

/**
 * Dragging media from the bin onto the timeline.
 *
 * Built on pointer events rather than HTML5 drag & drop: with Tauri's native
 * file drop enabled (needed for real file paths), WebView2 on Windows doesn't
 * deliver HTML5 drag events inside the page.
 */
export interface MediaDrag {
  mediaId: string;
  name: string;
  x: number;
  y: number;
  /** Over the timeline? */
  over: boolean;
  /** Insertion index among the timeline's clips. */
  index: number;
  /** Timeline position (seconds) of the insertion marker. */
  at: number;
}

const DRAG_THRESHOLD = 5;
const EDGE_SCROLL = 48;

function timelineTarget(x: number, y: number): { index: number; at: number } | null {
  const hit = document.elementFromPoint(x, y)?.closest(".timeline");
  const content = document.querySelector<HTMLElement>(".timeline-content");
  if (!hit || !content) return null;
  const { clips, zoom } = useStore.getState();
  const t = (x - content.getBoundingClientRect().left) / zoom;
  const items = layoutClips(clips).items;
  const index = items.filter((p) => (p.start + p.end) / 2 < t).length;
  const at = items[index]?.start ?? items[items.length - 1]?.end ?? 0;
  return { index, at };
}

/** Scrolls the timeline when dragging near its left/right edge. */
function edgeScroll(x: number) {
  const el = document.querySelector<HTMLElement>(".timeline-scroll");
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (x < r.left + EDGE_SCROLL) el.scrollLeft -= 16;
  else if (x > r.right - EDGE_SCROLL) el.scrollLeft += 16;
}

/** Call from a media item's pointerdown. A click (no movement) does nothing. */
export function startMediaDrag(e: React.PointerEvent, mediaId: string) {
  if (e.button !== 0) return;
  const m = useStore.getState().media.find((x) => x.id === mediaId);
  // Same rule as the "+" button: it must have a known length.
  if (!m || !(m.status === "ready" || m.status === "proxying") || !(m.duration > 0)) return;

  const sx = e.clientX;
  const sy = e.clientY;
  let active = false;

  const update = (x: number, y: number) => {
    const target = timelineTarget(x, y);
    if (target) edgeScroll(x);
    useStore.setState({
      mediaDrag: { mediaId, name: m.name, x, y, over: !!target, index: target?.index ?? 0, at: target?.at ?? 0 },
    });
  };
  const move = (ev: PointerEvent) => {
    if (!active) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return;
      active = true;
      document.body.classList.add("dragging-media");
    }
    ev.preventDefault();
    update(ev.clientX, ev.clientY);
  };
  const end = (commit: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key, true);
    document.body.classList.remove("dragging-media");
    const drag = useStore.getState().mediaDrag;
    useStore.setState({ mediaDrag: null });
    if (commit && active && drag?.over) useStore.getState().insertClip(mediaId, drag.index);
  };
  const up = () => end(true);
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", key, true);
}
