import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { layoutClips, type PlacedClip } from "../lib/timeline";
import { allKeyframeTimes } from "../lib/keyframes";
import { transitionLabel } from "../lib/transitions";
import { tip } from "./Tooltip";

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const kbdDup = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘D" : "Ctrl+D";
const HUES = [205, 160, 35, 280, 340, 95, 15, 240];

/** Fits the whole timeline into the visible width. */
export function zoomToFit() {
  const el = document.querySelector<HTMLElement>(".timeline-scroll");
  const { clips, setZoom } = useStore.getState();
  const total = layoutClips(clips).total;
  if (!el || total <= 0) return;
  setZoom((el.clientWidth - 48) / total);
  el.scrollLeft = 0;
}

/** Runs `onMove(dx, ev)` while the pointer is held after a pointerdown. */
function dragPointer(e: React.PointerEvent, onMove: (dx: number, ev: PointerEvent) => void, onUp?: (moved: boolean) => void) {
  e.stopPropagation();
  const startX = e.clientX;
  let moved = false;
  const move = (ev: PointerEvent) => {
    if (Math.abs(ev.clientX - startX) > 3) moved = true;
    onMove(ev.clientX - startX, ev);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    onUp?.(moved);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

export function Timeline() {
  const clips = useStore((s) => s.clips);
  const zoom = useStore((s) => s.zoom);
  const setZoom = useStore((s) => s.setZoom);
  const currentTime = useStore((s) => s.currentTime);
  const layout = useMemo(() => layoutClips(clips), [clips]);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const playing = useStore((s) => s.playing);
  const mediaDrag = useStore((s) => s.mediaDrag);

  // Keep the playhead in view during playback.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    const x = currentTime * zoom;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - 40);
  }, [currentTime, zoom, playing]);
  /** Timeline position (seconds) of the reorder insertion marker. */
  const [dropAt, setDropAt] = useState<number | null>(null);

  // Leave room after the last clip, but never less than the visible width.
  const contentWidth = layout.total * zoom + 240;
  const step = TICK_STEPS.find((s) => s * zoom >= 70) ?? 600;
  const ticks: number[] = [];
  for (let t = 0; t * zoom < contentWidth; t += step) ticks.push(t);

  const timeFromClientX = (clientX: number) => {
    const rect = contentRef.current!.getBoundingClientRect();
    return (clientX - rect.left) / zoom;
  };

  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const st = useStore.getState();
    st.setPlaying(false);
    st.seek(timeFromClientX(e.clientX));
    dragPointer(e, (_dx, ev) => useStore.getState().seek(timeFromClientX(ev.clientX)));
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  };

  return (
    <section className={`timeline ${mediaDrag?.over ? "media-drop" : ""}`} data-drop-zone="timeline">
      <div className="timeline-header">
        <span className="panel-title">Timeline</span>
        <span className="muted small timeline-hint">
          Drag clips to reorder · drag edges to trim · click ⧉ between clips for a transition · Ctrl+scroll to zoom
        </span>
        <div className="zoom">
          <button className="icon-btn" onClick={zoomToFit} disabled={layout.total === 0} {...tip("Zoom so the whole edit fits the timeline", { kbd: "\\", label: "Zoom to fit" })}>
            ⤢
          </button>
          <input
            type="range"
            min={10}
            max={400}
            value={zoom}
            {...tip("Timeline zoom. You can also hold Ctrl (⌘ on Mac) and scroll over the timeline.")}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="timeline-scroll" onWheel={onWheel} ref={scrollRef}>
        <div className="timeline-content" ref={contentRef} style={{ width: contentWidth }}>
          <div className="ruler" onPointerDown={scrub} {...tip("Click or drag to move the playhead")}>
            {ticks.map((t) => (
              <div key={t} className="tick" style={{ left: t * zoom }}>
                <span>{t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}` : `${t}s`}</span>
              </div>
            ))}
          </div>

          <div className="track" onPointerDown={scrub}>
            {layout.items.length === 0 && <div className="track-empty">Drop videos here to add them to the timeline</div>}
            {layout.items.map((p) => (
              <ClipBlock
                key={p.clip.id}
                placed={p}
                next={layout.items[p.index + 1]}
                zoom={zoom}
                timeFromClientX={timeFromClientX}
                onDropAt={setDropAt}
              />
            ))}
            {layout.items.slice(1).map((p) => (
              <TransitionMarker key={`t-${p.clip.id}`} placed={p} zoom={zoom} />
            ))}
            {dropAt !== null && <div className="drop-indicator" style={{ left: dropAt * zoom }} />}
            {mediaDrag?.over && <div className="drop-indicator media" style={{ left: mediaDrag.at * zoom }} />}
          </div>

          <div className="playhead" style={{ left: currentTime * zoom }}>
            <div className="playhead-knob" onPointerDown={scrub} {...tip("Drag to scrub")} />
          </div>
        </div>
      </div>
    </section>
  );
}

function ClipBlock({
  placed,
  next,
  zoom,
  timeFromClientX,
  onDropAt,
}: {
  placed: PlacedClip;
  next?: PlacedClip;
  zoom: number;
  timeFromClientX: (x: number) => number;
  onDropAt: (t: number | null) => void;
}) {
  const { clip } = placed;
  const media = useStore((s) => s.media.find((m) => m.id === clip.mediaId));
  const mediaIndex = useStore((s) => s.media.findIndex((m) => m.id === clip.mediaId));
  const selected = useStore((s) => s.selection?.kind === "clip" && s.selection.clipId === clip.id);
  const [dragDx, setDragDx] = useState<number | null>(null);

  // Clips are drawn split at the middle of each transition overlap.
  const visStart = placed.start + placed.transIn / 2;
  const visEnd = placed.end - (next?.transIn ?? 0) / 2;
  const left = visStart * zoom;
  const width = Math.max(4, (visEnd - visStart) * zoom);
  const hue = HUES[mediaIndex % HUES.length];
  const kfTimes = allKeyframeTimes(clip);

  const onBodyDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    useStore.getState().select({ kind: "clip", clipId: clip.id });
    let target: number | null = null;
    dragPointer(
      e,
      (dx, ev) => {
        setDragDx(dx);
        // Insertion index among the other clips, judged by their midpoints.
        const t = timeFromClientX(ev.clientX);
        const shown = layoutClips(useStore.getState().clips).items;
        const others = shown.filter((o) => o.clip.id !== clip.id);
        target = others.filter((o) => (o.start + o.end) / 2 < t).length;
        const before = others[target];
        onDropAt(before ? before.start : (others[others.length - 1]?.end ?? 0));
      },
      (moved) => {
        setDragDx(null);
        onDropAt(null);
        if (moved && target !== null) useStore.getState().moveClip(clip.id, target);
      },
    );
  };

  const onTrim = (edge: "in" | "out") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    useStore.getState().select({ kind: "clip", clipId: clip.id });
    const { trimIn, trimOut } = clip;
    dragPointer(e, (dx) => {
      const d = dx / zoom;
      const st = useStore.getState();
      if (edge === "in") st.trimClip(clip.id, trimIn + d, trimOut);
      else st.trimClip(clip.id, trimIn, trimOut + d);
    });
  };

  return (
    <div
      className={`clip ${selected ? "selected" : ""} ${dragDx !== null ? "dragging" : ""} ${!media || media.status === "missing" ? "missing" : ""}`}
      style={{
        left,
        width,
        transform: dragDx !== null ? `translateX(${dragDx}px)` : undefined,
        ["--clip-hue" as string]: hue,
      }}
      onPointerDown={onBodyDown}
      {...tip(
        `${placed.duration.toFixed(2)}s · drag to reorder · drag the edges to trim · ${kbdDup} duplicate · Del removes`,
        { title: media?.name ?? "Missing media" },
      )}
    >
      <div className="trim-handle in" onPointerDown={onTrim("in")} {...tip("Drag to trim the start of the clip")} />
      <div className="clip-label">
        <span>{media?.name ?? "missing media"}</span>
        <span className="muted small">{placed.duration.toFixed(2)}s</span>
      </div>
      <div className="kf-row">
        {kfTimes.map((t) => (
          <span key={t} className="kf-dot" style={{ left: (placed.start + t - visStart) * zoom }} />
        ))}
      </div>
      <div className="trim-handle out" onPointerDown={onTrim("out")} {...tip("Drag to trim the end of the clip")} />
    </div>
  );
}

function TransitionMarker({ placed, zoom }: { placed: PlacedClip; zoom: number }) {
  const selected = useStore((s) => s.selection?.kind === "transition" && s.selection.clipId === placed.clip.id);
  const { type } = placed.clip.transitionIn;

  const select = (e: React.PointerEvent) => {
    e.stopPropagation();
    const st = useStore.getState();
    if (type === "cut") st.setTransition(placed.clip.id, { type: "crossfade", duration: placed.clip.transitionIn.duration || 1 });
    st.select({ kind: "transition", clipId: placed.clip.id });
  };

  if (placed.transIn <= 0) {
    return (
      <button
        className={`transition-add ${selected ? "selected" : ""}`}
        style={{ left: placed.start * zoom }}
        onPointerDown={select}
        {...tip("Add a transition between these two clips (starts as a 1s crossfade — change it in the inspector)", { title: "Add transition", label: "Add transition" })}
      >
        ⧉
      </button>
    );
  }
  return (
    <div
      className={`transition-chip ${selected ? "selected" : ""}`}
      style={{ left: placed.start * zoom, width: Math.max(18, placed.transIn * zoom) }}
      onPointerDown={select}
      {...tip("Click to change the type or length. Delete removes it.", { title: `${transitionLabel(type)} · ${placed.transIn.toFixed(2)}s` })}
    >
      <span>{transitionLabel(type)}</span>
    </div>
  );
}
