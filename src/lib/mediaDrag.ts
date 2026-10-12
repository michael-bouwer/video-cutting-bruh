import { snapExtras } from "./snapExtras";
import { useStore } from "../store";
import { fitStart, snap, snapPoints } from "./timeline";
import { timeAtClientX } from "../components/Timeline";
import type { TrackKind } from "../types";

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
  /** Track the clip would land on (null: a new track, see `toNewTrack`). */
  trackId: string | null;
  /** Pointer is over the "new track" drop zone. */
  toNewTrack: boolean;
  /** Kind of track this media goes on. */
  kind: TrackKind;
  /** Where the clip would start (seconds), after snapping and avoiding overlaps. */
  at: number;
  duration: number;
}

const DRAG_THRESHOLD = 5;
const EDGE_SCROLL = 48;
const SNAP_PX = 8;

function target(x: number, y: number, kind: TrackKind, duration: number) {
  const hit = document.elementFromPoint(x, y);
  if (!hit?.closest(".timeline")) return null;
  const { tracks, clips, zoom, currentTime, snapping } = useStore.getState();

  let start = timeAtClientX(x);
  if (snapping) start = snap(start, snapPoints(clips, new Set(), currentTime, snapExtras()), SNAP_PX / zoom).t;

  const zone = hit.closest<HTMLElement>("[data-new-track]");
  if (zone?.dataset.newTrack === kind) return { trackId: null, toNewTrack: true, at: start };

  const row = hit.closest<HTMLElement>("[data-track-id]");
  const hovered = row && row.dataset.trackKind === kind ? tracks.find((t) => t.id === row.dataset.trackId && !t.locked) : undefined;
  // Wrong kind of track (or the ruler): fall back to the first track that can take it.
  const track = hovered ?? tracks.find((t) => t.kind === kind && !t.locked);
  if (!track) return { trackId: null, toNewTrack: true, at: start };
  return { trackId: track.id, toNewTrack: false, at: fitStart(clips, track.id, start, duration, new Set()) };
}

/** Scrolls the timeline when dragging near its edges. */
function edgeScroll(x: number, y: number) {
  const el = document.querySelector<HTMLElement>(".timeline-scroll");
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (x < r.left + EDGE_SCROLL) el.scrollLeft -= 16;
  else if (x > r.right - EDGE_SCROLL) el.scrollLeft += 16;
  if (y > r.bottom - 24) el.scrollTop += 10;
  else if (y < r.top + 24) el.scrollTop -= 10;
}

/** Call from a media item's pointerdown. A click (no movement) does nothing. */
export function startMediaDrag(e: React.PointerEvent, mediaId: string) {
  if (e.button !== 0) return;
  const m = useStore.getState().media.find((x) => x.id === mediaId);
  // Same rule as the "+" button: it must have a known length.
  if (!m || !(m.status === "ready" || m.status === "proxying") || !(m.duration > 0)) return;
  const kind: TrackKind = m.kind === "audio" ? "audio" : "video";

  const sx = e.clientX;
  const sy = e.clientY;
  let active = false;

  const update = (x: number, y: number) => {
    const t = target(x, y, kind, m.duration);
    if (t) edgeScroll(x, y);
    useStore.setState({
      mediaDrag: {
        mediaId,
        name: m.name,
        x,
        y,
        over: !!t,
        trackId: t?.trackId ?? null,
        toNewTrack: t?.toNewTrack ?? false,
        kind,
        at: t?.at ?? 0,
        duration: m.duration,
      },
    });
  };
  const move = (ev: PointerEvent) => {
    if (!active) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return;
      active = true;
      document.body.classList.add("dragging-media");
      // Hide any tooltip that was showing when the drag started.
      window.dispatchEvent(new Event("blur"));
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
    if (!commit || !active || !drag?.over) return;
    const st = useStore.getState();
    const trackId = drag.toNewTrack || !drag.trackId ? st.addTrack(kind) : drag.trackId;
    st.placeMedia(mediaId, { trackId, start: drag.at });
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
