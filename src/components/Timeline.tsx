import { useEffect, useRef, useState } from "react";
import { groupOf, useStore } from "../store";
import {
  clipDuration,
  clipEnd,
  orderedTracks,
  prevAdjacent,
  snap,
  snapPoints,
  timelineEnd,
  TOUCH_EPS,
  trackClips,
  transitionLength,
} from "../lib/timeline";
import { keyframeColor } from "../lib/keyframes";
import { KeyframeActions, KeyframeLanes } from "./KeyframeLanes";
import { transitionLabel } from "../lib/transitions";
import { ask } from "../lib/dialog";
import { tip } from "./Tooltip";
import { createScreenshot } from "../lib/screenshot";
import { onMarquee, startMarquee, type MarqueeBox } from "../lib/marquee";
import type { Clip, Track } from "../types";

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";
const ALT = isMac ? "⌥" : "Alt";
const HUES = [205, 160, 35, 280, 340, 95, 15, 240];
/** Width of the sticky track-header column (keep in sync with --track-header-w in CSS). */
export const HEADER_W = 132;
const SNAP_PX = 8;
const ROW_H = { video: 62, audio: 46 } as const;

/** Fits the whole timeline into the visible width. */
export function zoomToFit() {
  const el = document.querySelector<HTMLElement>(".timeline-scroll");
  const { clips, setZoom } = useStore.getState();
  const total = timelineEnd(clips);
  if (!el || total <= 0) return;
  setZoom((el.clientWidth - HEADER_W - 48) / total);
  el.scrollLeft = 0;
}

/** Timeline time under a viewport x coordinate. */
export function timeAtClientX(x: number): number {
  const content = document.querySelector<HTMLElement>(".timeline-content");
  if (!content) return 0;
  return Math.max(0, (x - content.getBoundingClientRect().left - HEADER_W) / useStore.getState().zoom);
}

/** Runs `onMove(dx, ev)` while the pointer is held after a pointerdown. */
function dragPointer(
  e: React.PointerEvent,
  onMove: (dx: number, ev: PointerEvent) => void,
  onUp?: (moved: boolean) => void,
) {
  e.stopPropagation();
  const startX = e.clientX;
  const startY = e.clientY;
  let moved = false;
  const move = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
    moved = true;
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

/** Snaps a moving clip by its start or end, whichever is closer to a snap point. */
function snapRange(start: number, dur: number, points: number[], zoom: number) {
  const a = snap(start, points, SNAP_PX / zoom);
  const b = snap(start + dur, points, SNAP_PX / zoom);
  const da = a.to === null ? Infinity : Math.abs(a.t - start);
  const db = b.to === null ? Infinity : Math.abs(b.t - (start + dur));
  if (da === Infinity && db === Infinity) return { start, line: null as number | null };
  return da <= db ? { start: a.t, line: a.to } : { start: b.t - dur, line: b.to };
}

export function Timeline() {
  const clips = useStore((s) => s.clips);
  const tracks = useStore((s) => s.tracks);
  const zoom = useStore((s) => s.zoom);
  const setZoom = useStore((s) => s.setZoom);
  const snapping = useStore((s) => s.snapping);
  const setSnapping = useStore((s) => s.setSnapping);
  const addTrack = useStore((s) => s.addTrack);
  const mediaDrag = useStore((s) => s.mediaDrag);
  const showKfActions = useStore((s) => s.kfSelection.length > 0 || Object.values(s.expandedTracks).some(Boolean));
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Vertical snap guide (seconds) while dragging. */
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null);
  useEffect(() => {
    onMarquee(setMarquee);
    return () => onMarquee(null);
  }, []);

  const total = timelineEnd(clips);
  const visibleSeconds = (scrollRef.current?.clientWidth ?? 1200) / zoom;
  const contentSeconds = Math.max(total + 10, visibleSeconds);
  const laneWidth = contentSeconds * zoom;
  const step = TICK_STEPS.find((s) => s * zoom >= 70) ?? 1200;
  const ticks: number[] = [];
  for (let t = 0; t <= contentSeconds; t += step) ticks.push(t);

  /** Empty timeline space: drag = box-select, click = move the playhead there and deselect. */
  const background = (e: React.PointerEvent) => {
    const t = timeAtClientX(e.clientX);
    startMarquee(e, () => {
      const st = useStore.getState();
      st.setPlaying(false);
      st.seek(t);
      st.select(null);
      st.selectKeyframes([]);
    });
  };

  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const st = useStore.getState();
    st.setPlaying(false);
    st.seek(timeAtClientX(e.clientX));
    dragPointer(e, (_dx, ev) => useStore.getState().seek(timeAtClientX(ev.clientX)));
  };

  // Ctrl/⌘ + wheel zooms around the pointer; plain wheel scrolls.
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const el = scrollRef.current!;
    const anchor = timeAtClientX(e.clientX);
    const offset = e.clientX - el.getBoundingClientRect().left - HEADER_W;
    const next = Math.max(5, Math.min(400, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    setZoom(next);
    requestAnimationFrame(() => (el.scrollLeft = Math.max(0, anchor * next - offset)));
  };

  const rows = orderedTracks(tracks);

  return (
    <section className={`timeline ${mediaDrag?.over ? "media-drop" : ""}`} data-drop-zone="timeline">
      <div className="timeline-header">
        <span className="panel-title">Timeline</span>
        <div className="timeline-actions">
          {showKfActions && <KeyframeActions />}
          <button
            className="split-btn"
            onClick={() => useStore.getState().splitAtPlayhead()}
            {...tip("Cut at the playhead: splits the selected clip (and its linked audio/video) — or, with nothing selected, every clip under the playhead on all tracks.", { title: "Split at playhead", kbd: "S", label: "Split at playhead" })}
          >
            ✂ Split
          </button>
          <button
            onClick={createScreenshot}
            {...tip("Save the current preview frame (with effects, at project resolution) as a PNG and add it to the media bin as an image.", { title: "Create screenshot", label: "Create screenshot" })}
          >
            📷 Screenshot
          </button>
        </div>
        <span className="muted small timeline-hint">
          Drag clips anywhere · drag on empty space to box-select · Shift-click adds · drag edges to trim · {ALT}: no snapping
        </span>
        <div className="timeline-tools">
          <button onClick={() => addTrack("video")} {...tip("Add a video track. Higher video tracks are drawn on top of lower ones.", { title: "Add video track" })}>
            + Video
          </button>
          <button onClick={() => addTrack("audio")} {...tip("Add an audio track. All audio tracks play mixed together.", { title: "Add audio track" })}>
            + Audio
          </button>
          <button
            className={`icon-btn ${snapping ? "active" : ""}`}
            aria-pressed={snapping}
            onClick={() => setSnapping(!snapping)}
            {...tip(`Snap clip edges to other clips, the playhead and 0 while dragging. Hold ${ALT} to drag freely.`, { title: `Snapping ${snapping ? "on" : "off"}`, label: "Snapping" })}
          >
            ⊞
          </button>
          <button className="icon-btn" onClick={zoomToFit} disabled={total === 0} {...tip("Zoom so the whole edit fits", { kbd: "\\", label: "Zoom to fit" })}>
            ⤢
          </button>
          <input
            type="range"
            min={5}
            max={400}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            {...tip(`Timeline zoom. You can also hold ${isMac ? "⌘" : "Ctrl"} and scroll over the timeline.`)}
          />
        </div>
      </div>

      <div className="timeline-scroll" ref={scrollRef} onWheel={onWheel}>
        <div
          className="timeline-content"
          style={{ width: HEADER_W + laneWidth }}
          // Empty space below the tracks also box-selects.
          onPointerDown={(e) => e.target === e.currentTarget && background(e)}
        >
          <div className="tl-row ruler-row">
            <div className="track-header corner">
              <TimecodeReadout />
            </div>
            <div className="ruler" style={{ width: laneWidth }} onPointerDown={scrub} {...tip("Click or drag to move the playhead")}>
              {ticks.map((t) => (
                <div key={t} className="tick" style={{ left: t * zoom }}>
                  <span>{t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}` : `${t}s`}</span>
                </div>
              ))}
            </div>
          </div>

          <NewTrackZone kind="video" width={laneWidth} />
          {rows.map((track) => (
            <TrackWithLanes key={track.id} track={track} clips={clips} zoom={zoom} laneWidth={laneWidth} onSnapLine={setSnapLine} onBackground={background} />
          ))}
          <NewTrackZone kind="audio" width={laneWidth} />
          {clips.length === 0 && !mediaDrag && (
            <div className="timeline-empty muted">Drop videos, images or audio here — or drag them from the media bin</div>
          )}

          {snapLine !== null && <div className="snap-line" style={{ left: HEADER_W + snapLine * zoom }} />}
          {marquee && <div className="marquee" style={marquee} />}
          <Playhead zoom={zoom} scrollRef={scrollRef} onScrub={scrub} />
        </div>
      </div>
    </section>
  );
}

function TimecodeReadout() {
  const t = useStore((s) => s.currentTime);
  const fps = useStore((s) => s.settings.fps);
  const m = Math.floor(t / 60);
  const sec = Math.floor(t % 60);
  const f = Math.floor((t % 1) * fps + 1e-6);
  return (
    <span className="tl-timecode">
      {String(m).padStart(2, "0")}:{String(sec).padStart(2, "0")}:{String(f).padStart(2, "0")}
    </span>
  );
}

/** Separate component so only the playhead re-renders 60×/s during playback. */
function Playhead({ zoom, scrollRef, onScrub }: { zoom: number; scrollRef: React.RefObject<HTMLDivElement | null>; onScrub: (e: React.PointerEvent) => void }) {
  const currentTime = useStore((s) => s.currentTime);
  const playing = useStore((s) => s.playing);
  // Keep the playhead in view during playback.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    const x = currentTime * zoom;
    const view = el.clientWidth - HEADER_W;
    if (x < el.scrollLeft || x > el.scrollLeft + view - 40) el.scrollLeft = Math.max(0, x - 40);
  }, [currentTime, zoom, playing, scrollRef]);
  return (
    <div className="playhead" style={{ left: HEADER_W + currentTime * zoom }}>
      <div className="playhead-knob" onPointerDown={onScrub} {...tip("Drag to scrub")} />
    </div>
  );
}

/**
 * Thin strip above the video tracks / below the audio tracks. Always in the
 * layout (so rows don't jump when a drag starts) but only visible while dragging.
 */
function NewTrackZone({ kind, width }: { kind: "video" | "audio"; width: number }) {
  const hot = useStore((s) => s.mediaDrag?.over && s.mediaDrag.kind === kind && s.mediaDrag.toNewTrack);
  return (
    <div className={`tl-row new-track-zone ${kind} ${hot ? "hot" : ""}`} data-new-track={kind}>
      <div className="track-header">+ {kind} track</div>
      <div className="lane" style={{ width }}>
        <span className="small">Drop here for a new {kind} track</span>
      </div>
    </div>
  );
}

// ---- Tracks ------------------------------------------------------------------------------------

/** A track row plus, when expanded, its keyframe lanes. */
function TrackWithLanes(props: Parameters<typeof TrackRow>[0]) {
  const expanded = useStore((s) => !!s.expandedTracks[props.track.id]);
  return (
    <>
      <TrackRow {...props} />
      {expanded && <KeyframeLanes track={props.track} laneWidth={props.laneWidth} zoom={props.zoom} onBackground={props.onBackground} />}
    </>
  );
}

function TrackRow({
  track,
  clips,
  zoom,
  laneWidth,
  onSnapLine,
  onBackground,
}: {
  track: Track;
  clips: Clip[];
  zoom: number;
  laneWidth: number;
  onSnapLine: (t: number | null) => void;
  onBackground: (e: React.PointerEvent) => void;
}) {
  const own = clips.filter((c) => c.trackId === track.id);
  const mediaDrag = useStore((s) => s.mediaDrag);
  const ghost = mediaDrag?.over && mediaDrag.trackId === track.id ? mediaDrag : null;

  const onLaneDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    onBackground(e);
  };

  return (
    <div
      className={`tl-row track-row ${track.kind} ${track.locked ? "locked" : ""} ${track.hidden || track.muted ? "dimmed" : ""}`}
      style={{ height: ROW_H[track.kind] }}
      data-track-id={track.id}
      data-track-kind={track.kind}
    >
      <TrackHeader track={track} count={own.length} />
      <div className="lane" style={{ width: laneWidth }} onPointerDown={onLaneDown}>
        {own.map((c) => (
          <ClipBlock key={c.id} clip={c} track={track} zoom={zoom} onSnapLine={onSnapLine} />
        ))}
        {track.kind === "video" &&
          !track.locked &&
          own.map((c) => (prevAdjacent(clips, c) ? <TransitionMarker key={`t-${c.id}`} clip={c} zoom={zoom} /> : null))}
        {ghost && <div className="drop-ghost" style={{ left: ghost.at * zoom, width: Math.max(4, ghost.duration * zoom) }} />}
      </div>
    </div>
  );
}

function TrackHeader({ track, count }: { track: Track; count: number }) {
  const update = useStore((s) => s.updateTrack);
  const removeTrack = useStore((s) => s.removeTrack);
  const lastOfKind = useStore((s) => s.tracks.filter((t) => t.kind === track.kind).length <= 1);

  const remove = async () => {
    if (count > 0) {
      const ok = await ask(
        `Delete track ${track.name}?`,
        `It contains ${count} clip${count === 1 ? "" : "s"}, which will be removed too. You can undo this.`,
        [
          { id: "cancel", label: "Cancel" },
          { id: "delete", label: "Delete track", kind: "danger" },
        ],
        "cancel",
      );
      if (ok !== "delete") return;
    }
    removeTrack(track.id);
  };

  const expanded = useStore((s) => !!s.expandedTracks[track.id]);
  const toggleExpanded = useStore((s) => s.toggleTrackExpanded);
  return (
    <div className="track-header">
      <button
        className={`track-btn expand ${expanded ? "on" : ""}`}
        aria-expanded={expanded}
        onClick={() => toggleExpanded(track.id)}
        {...tip(expanded ? "Hide keyframe lanes" : "Show this track's keyframes in lanes below it — drag them, copy & paste them", { label: "Toggle keyframe lanes" })}
      >
        {expanded ? "▾" : "▸"}
      </button>
      <span className={`track-name ${track.kind}`} {...tip(track.kind === "video" ? "Video track. Higher tracks are drawn on top." : "Audio track. All audio tracks are mixed together.")}>
        {track.name}
      </span>
      <div className="track-buttons">
        {track.kind === "video" ? (
          <button
            className={`track-btn ${track.hidden ? "off" : ""}`}
            aria-pressed={!track.hidden}
            onClick={() => update(track.id, { hidden: !track.hidden })}
            {...tip(track.hidden ? "Hidden — click to show this track in the preview" : "Visible — click to hide this track", { label: "Toggle visibility" })}
          >
            {track.hidden ? "◌" : "◉"}
          </button>
        ) : (
          <>
            <button
              className={`track-btn ${track.muted ? "on warn" : ""}`}
              aria-pressed={track.muted}
              onClick={() => update(track.id, { muted: !track.muted })}
              {...tip(track.muted ? "Muted — click to unmute" : "Mute this track", { label: "Mute" })}
            >
              M
            </button>
            <button
              className={`track-btn ${track.solo ? "on" : ""}`}
              aria-pressed={track.solo}
              onClick={() => update(track.id, { solo: !track.solo })}
              {...tip("Solo: while any track is soloed, only soloed tracks are heard", { label: "Solo" })}
            >
              S
            </button>
          </>
        )}
        <button
          className={`track-btn ${track.locked ? "on" : ""}`}
          aria-pressed={track.locked}
          onClick={() => update(track.id, { locked: !track.locked })}
          {...tip(track.locked ? "Locked — clips on this track can't be moved, trimmed or deleted" : "Lock this track against edits", { label: "Lock" })}
        >
          {track.locked ? "🔒" : "🔓"}
        </button>
        <button
          className="track-btn"
          disabled={lastOfKind}
          onClick={remove}
          {...tip(lastOfKind ? `The last ${track.kind} track can't be deleted` : "Delete this track", { label: "Delete track" })}
        >
          ×
        </button>
      </div>
    </div>
  );
}

// ---- Clips ------------------------------------------------------------------------------------

function ClipBlock({ clip, track, zoom, onSnapLine }: { clip: Clip; track: Track; zoom: number; onSnapLine: (t: number | null) => void }) {
  const media = useStore((s) => s.media.find((m) => m.id === clip.mediaId));
  const mediaIndex = useStore((s) => s.media.findIndex((m) => m.id === clip.mediaId));
  const selected = useStore((s) => s.clipSelection.includes(clip.id) || (s.selection?.kind === "clip" && s.selection.clipId === clip.id));
  // Gaps around this segment on its track (for the close-gap buttons).
  const gapLeft = useStore((s) => {
    const prevEnd = Math.max(0, ...trackClips(s.clips, clip.trackId).filter((c) => c.id !== clip.id && clipEnd(c) <= clip.start + TOUCH_EPS).map(clipEnd));
    return clip.start - prevEnd > TOUCH_EPS ? clip.start - prevEnd : 0;
  });
  const gapRight = useStore((s) => {
    const next = trackClips(s.clips, clip.trackId).find((c) => c.id !== clip.id && c.start >= clipEnd(clip) - TOUCH_EPS);
    return next && next.start - clipEnd(clip) > TOUCH_EPS ? next.start - clipEnd(clip) : 0;
  });
  const linkedSelected = useStore((s) => {
    if (!clip.linkId || s.selection?.kind !== "clip" || s.selection.clipId === clip.id) return false;
    return s.clips.find((c) => c.id === s.selection!.clipId)?.linkId === clip.linkId;
  });

  const dur = clipDuration(clip);
  const left = clip.start * zoom;
  const width = Math.max(4, dur * zoom);
  const hue = HUES[Math.max(0, mediaIndex) % HUES.length];
  // Every keyframe on the clip (transform + effects), in its own colour.
  const kfDots = [
    ...Object.values(clip.keyframes).flat(),
    ...clip.effects.flatMap((fx) => Object.values(fx.keyframes).flat()),
  ].filter((kf) => kf.t >= -1e-6 && kf.t <= dur + 1e-6);
  const editable = !track.locked;

  const pointsFor = () => {
    const s = useStore.getState();
    return snapPoints(s.clips, new Set(groupOf(s.clips, clip).map((c) => c.id)), s.currentTime);
  };

  const onBodyDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const st0 = useStore.getState();
    st0.selectKeyframes([]);
    // Shift/Ctrl/⌘-click adds or removes the clip from a multi-selection.
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      e.stopPropagation();
      st0.selectClips([clip.id], "toggle");
      return;
    }
    const multi = st0.clipSelection.length > 1 && st0.clipSelection.includes(clip.id);
    if (multi) useStore.setState({ selection: { kind: "clip", clipId: clip.id }, rightTab: "inspector" });
    else st0.select({ kind: "clip", clipId: clip.id });
    if (!editable) return e.stopPropagation();
    const origStart = clip.start;
    const points = pointsFor();

    if (multi) {
      // Move every selected clip by the same amount (no track changes for a group).
      const ids = [...st0.clipSelection];
      const groupPoints = snapPoints(st0.clips, new Set(ids.flatMap((id) => {
        const c = st0.clips.find((x) => x.id === id);
        return c ? groupOf(st0.clips, c).map((x) => x.id) : [];
      })), st0.currentTime);
      dragPointer(
        e,
        (dx, ev) => {
          const st = useStore.getState();
          let desired = origStart + dx / st.zoom;
          let line: number | null = null;
          if (st.snapping && !ev.altKey) ({ start: desired, line } = snapRange(desired, dur, groupPoints, st.zoom));
          onSnapLine(line);
          const now = st.clips.find((c) => c.id === clip.id)?.start ?? origStart;
          st.moveClipsBy(ids, desired - now);
          document.body.classList.add("dragging-clip");
        },
        () => {
          onSnapLine(null);
          document.body.classList.remove("dragging-clip");
        },
      );
      return;
    }
    dragPointer(
      e,
      (dx, ev) => {
        const st = useStore.getState();
        let desired = Math.max(0, origStart + dx / st.zoom);
        let line: number | null = null;
        if (st.snapping && !ev.altKey) ({ start: desired, line } = snapRange(desired, dur, points, st.zoom));
        onSnapLine(line);
        // Moving between tracks of the same kind follows the pointer vertically.
        const hit = document.elementFromPoint(ev.clientX, ev.clientY);
        const row = hit?.closest<HTMLElement>("[data-track-id]");
        let target = row && row.dataset.trackKind === track.kind ? row.dataset.trackId : undefined;
        // Dropping onto the "new track" strip creates a track for the clip.
        if (!target && hit?.closest<HTMLElement>("[data-new-track]")?.dataset.newTrack === track.kind) {
          target = st.addTrack(track.kind);
        }
        st.moveClip(clip.id, desired, target);
        document.body.classList.add("dragging-clip");
      },
      () => {
        onSnapLine(null);
        document.body.classList.remove("dragging-clip");
      },
    );
  };

  const onTrim = (edge: "in" | "out") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    useStore.getState().select({ kind: "clip", clipId: clip.id });
    if (!editable) return e.stopPropagation();
    const origEdge = edge === "in" ? clip.start : clipEnd(clip);
    const points = pointsFor();
    dragPointer(
      e,
      (dx, ev) => {
        const st = useStore.getState();
        let t = origEdge + dx / st.zoom;
        let line: number | null = null;
        if (st.snapping && !ev.altKey) {
          const s = snap(t, points, SNAP_PX / st.zoom);
          t = s.t;
          line = s.to;
        }
        onSnapLine(line);
        st.trimEdge(clip.id, edge, t);
      },
      () => onSnapLine(null),
    );
  };

  const onFade = (which: "fadeIn" | "fadeOut") => (e: React.PointerEvent) => {
    if (e.button !== 0 || !editable) return;
    const orig = clip[which];
    dragPointer(e, (dx) => {
      const st = useStore.getState();
      const d = (which === "fadeIn" ? dx : -dx) / st.zoom;
      st.setFades(clip.id, { [which]: Math.max(0, orig + d) });
    });
  };

  const isAudio = track.kind === "audio";
  return (
    <div
      data-clip-id={clip.id}
      className={`clip ${track.kind} ${selected ? "selected" : ""} ${linkedSelected ? "linked-selected" : ""} ${!media || media.status === "missing" ? "missing" : ""} ${editable ? "" : "locked"}`}
      style={{ left, width, ["--clip-hue" as string]: hue }}
      onPointerDown={onBodyDown}
      {...tip(
        `${dur.toFixed(2)}s at ${clip.start.toFixed(2)}s · drag to move (also onto other ${track.kind} tracks) · drag the edges to trim — dragging back restores the cut part · ${MOD}D duplicate · Del removes${clip.linkId ? ` · linked: moves and trims together with its ${isAudio ? "video" : "audio"}` : ""}`,
        { title: media?.name ?? "Missing media" },
      )}
    >
      {editable && gapLeft > 0 && (
        <button
          className="gap-btn left"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => useStore.getState().closeGap(clip.id, "left", e.shiftKey)}
          {...tip(`Close the ${gapLeft.toFixed(2)}s gap before this segment by moving it left. Shift+click also pulls everything after it along (ripple).`, { title: "Close gap", label: "Close gap before" })}
        >
          ⇤
        </button>
      )}
      {editable && gapRight > 0 && (
        <button
          className="gap-btn right"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => useStore.getState().closeGap(clip.id, "right")}
          {...tip(`Close the ${gapRight.toFixed(2)}s gap after this segment by moving it right, up to the next one.`, { title: "Close gap", label: "Close gap after" })}
        >
          ⇥
        </button>
      )}
      {editable && <div className="trim-handle in" onPointerDown={onTrim("in")} {...tip("Drag to trim the start. Drag back out to restore what was cut.")} />}
      <div className="clip-label">
        <span>
          {clip.linkId && <span className="link-icon" aria-label="Linked">⛓ </span>}
          {media?.name ?? "missing media"}
        </span>
        {width > 70 && <span className="muted small">{dur.toFixed(2)}s</span>}
      </div>
      {isAudio ? (
        <>
          <div className="audio-wave" aria-hidden />
          {clip.fadeIn > 0 && <div className="fade-shape in" style={{ width: clip.fadeIn * zoom }} />}
          {clip.fadeOut > 0 && <div className="fade-shape out" style={{ width: clip.fadeOut * zoom }} />}
          {editable && width > 30 && (
            <>
              <div className="fade-handle in" style={{ left: clip.fadeIn * zoom }} onPointerDown={onFade("fadeIn")} {...tip(`Fade in: ${clip.fadeIn.toFixed(2)}s — drag to change`)} />
              <div className="fade-handle out" style={{ right: clip.fadeOut * zoom }} onPointerDown={onFade("fadeOut")} {...tip(`Fade out: ${clip.fadeOut.toFixed(2)}s — drag to change`)} />
            </>
          )}
        </>
      ) : (
        <div className="kf-row">
          {kfDots.map((kf) => (
            <span key={kf.id} className="kf-dot" style={{ left: kf.t * zoom, background: keyframeColor(kf) }} />
          ))}
        </div>
      )}
      {editable && <div className="trim-handle out" onPointerDown={onTrim("out")} {...tip("Drag to trim the end. Drag back out to restore what was cut.")} />}
    </div>
  );
}

function TransitionMarker({ clip, zoom }: { clip: Clip; zoom: number }) {
  const clips = useStore((s) => s.clips);
  const selected = useStore((s) => s.selection?.kind === "transition" && s.selection.clipId === clip.id);
  const d = transitionLength(clips, clip);
  const { type } = clip.transitionIn;

  const select = (e: React.PointerEvent) => {
    e.stopPropagation();
    const st = useStore.getState();
    if (type === "cut") st.setTransition(clip.id, { type: "crossfade", duration: clip.transitionIn.duration || 1 });
    st.select({ kind: "transition", clipId: clip.id });
  };

  if (d <= 0) {
    return (
      <button
        className={`transition-add ${selected ? "selected" : ""}`}
        style={{ left: clip.start * zoom }}
        onPointerDown={select}
        {...tip("These clips touch: add a transition between them (starts as a 1s crossfade — change it in the inspector)", { title: "Add transition", label: "Add transition" })}
      >
        ⧉
      </button>
    );
  }
  return (
    <div
      className={`transition-chip ${selected ? "selected" : ""}`}
      style={{ left: (clip.start - d / 2) * zoom, width: Math.max(18, d * zoom) }}
      onPointerDown={select}
      {...tip("Centred on the cut. Click to change the type or length; Delete removes it.", { title: `${transitionLabel(type)} · ${d.toFixed(2)}s` })}
    >
      <span>{transitionLabel(type)}</span>
    </div>
  );
}
