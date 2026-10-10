import { useStore } from "../store";
import { effectDef } from "../lib/effects";
import { keyframeColor } from "../lib/keyframes";
import { PROPS } from "../lib/props";
import { clipDuration, snap } from "../lib/timeline";
import { copyKeyframes, pasteKeyframes, hasCopiedKeyframes } from "../lib/keyframeClipboard";
import { tip } from "./Tooltip";
import type { Clip, Keyframe, KeyframeRef, Track } from "../types";

const SNAP_PX = 8;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

interface LaneItem {
  clip: Clip;
  fx: string | null;
  key: string;
  kf: Keyframe;
}

interface Lane {
  id: string;
  label: string;
  items: LaneItem[];
}

/** One lane per animated property (transform/volume, or effect parameter) used on the track. */
function lanesFor(clips: Clip[]): Lane[] {
  const lanes = new Map<string, Lane>();
  const add = (id: string, label: string, item: LaneItem) => {
    if (!lanes.has(id)) lanes.set(id, { id, label, items: [] });
    lanes.get(id)!.items.push(item);
  };
  for (const clip of clips) {
    const dur = clipDuration(clip);
    for (const def of PROPS) {
      for (const kf of clip.keyframes[def.key] ?? []) {
        if (kf.t >= -1e-6 && kf.t <= dur + 1e-6) add(`prop:${def.key}`, def.label, { clip, fx: null, key: def.key, kf });
      }
    }
    for (const fx of clip.effects) {
      const def = effectDef(fx.type);
      for (const p of def.params) {
        for (const kf of fx.keyframes[p.key] ?? []) {
          if (kf.t >= -1e-6 && kf.t <= dur + 1e-6) add(`fx:${fx.type}:${p.key}`, def.params.length > 1 ? `${def.label} · ${p.label}` : def.label, { clip, fx: fx.id, key: p.key, kf });
        }
      }
    }
  }
  // Transform first (in registry order), then effects.
  const order = (id: string) => (id.startsWith("prop:") ? PROPS.findIndex((p) => `prop:${p.key}` === id) : 100);
  return [...lanes.values()].sort((a, b) => order(a.id) - order(b.id) || a.label.localeCompare(b.label));
}

const sameRef = (a: KeyframeRef, b: KeyframeRef) => a.kfId === b.kfId && a.clipId === b.clipId && a.key === b.key && a.fx === b.fx;

/** Expanded keyframe lanes under a track. */
export function KeyframeLanes({
  track,
  laneWidth,
  zoom,
  onBackground,
}: {
  track: Track;
  laneWidth: number;
  zoom: number;
  onBackground: (e: React.PointerEvent) => void;
}) {
  const clips = useStore((s) => s.clips);
  const own = clips.filter((c) => c.trackId === track.id);
  const lanes = lanesFor(own);

  if (lanes.length === 0) {
    return (
      <div className="tl-row kf-lane empty">
        <div className="track-header kf-lane-header muted small">No keyframes</div>
        <div className="lane" style={{ width: laneWidth }}>
          <span className="muted small kf-lane-hint">Animate a property with ◆ in the inspector or effects panel and its keyframes appear here.</span>
        </div>
      </div>
    );
  }
  return (
    <>
      {lanes.map((lane) => (
        <LaneRow key={lane.id} lane={lane} laneWidth={laneWidth} zoom={zoom} own={own} locked={track.locked} onBackground={onBackground} />
      ))}
    </>
  );
}

function LaneRow({
  lane,
  laneWidth,
  zoom,
  own,
  locked,
  onBackground,
}: {
  lane: Lane;
  laneWidth: number;
  zoom: number;
  own: Clip[];
  locked: boolean;
  onBackground: (e: React.PointerEvent) => void;
}) {
  const kfSelection = useStore((s) => s.kfSelection);

  // Empty lane space: box-select (or click to move the playhead and deselect).
  const onLaneDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains("kf-clip-span")) return;
    onBackground(e);
  };

  return (
    <div className="tl-row kf-lane">
      <div className="track-header kf-lane-header" {...tip(`Keyframes of “${lane.label}”. Click to select (Shift/${MOD}click adds), drag to move, ${MOD}C / ${MOD}V to copy and paste at the playhead, Delete to remove.`)}>
        <span className="kf-lane-name">{lane.label}</span>
        <span className="muted small">{lane.items.length}</span>
      </div>
      <div className="lane" style={{ width: laneWidth }} onPointerDown={onLaneDown}>
        {/* Clip extents, so it's clear which clip each keyframe belongs to. */}
        {own.map((c) => (
          <div key={c.id} className="kf-clip-span" style={{ left: c.start * zoom, width: Math.max(2, clipDuration(c) * zoom) }} />
        ))}
        {lane.items.map((it) => {
          const ref: KeyframeRef = { clipId: it.clip.id, fx: it.fx, key: it.key, kfId: it.kf.id };
          return (
            <Diamond
              key={`${it.clip.id}:${it.fx}:${it.kf.id}`}
              item={it}
              refObj={ref}
              selected={kfSelection.some((r) => sameRef(r, ref))}
              zoom={zoom}
              locked={locked}
            />
          );
        })}
      </div>
    </div>
  );
}

function Diamond({ item, refObj, selected, zoom, locked }: { item: LaneItem; refObj: KeyframeRef; selected: boolean; zoom: number; locked: boolean }) {
  const color = keyframeColor(item.kf);
  const abs = item.clip.start + item.kf.t;

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const st = useStore.getState();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (additive) st.selectKeyframes([refObj], "toggle");
    else if (!selected) st.selectKeyframes([refObj]);
    // Show the clip in the inspector too (without clearing the keyframe selection).
    useStore.setState({ selection: { kind: "clip", clipId: item.clip.id }, rightTab: "inspector" });
    if (locked) return;

    // Drag every selected keyframe by the same amount.
    const selection = useStore.getState().kfSelection;
    if (!selection.some((r) => sameRef(r, refObj))) return;
    const originals = selection
      .map((ref) => {
        const clip = st.clips.find((c) => c.id === ref.clipId);
        const kfs = ref.fx ? clip?.effects.find((f) => f.id === ref.fx)?.keyframes[ref.key] : clip?.keyframes[ref.key as keyof Clip["keyframes"]];
        const kf = kfs?.find((k) => k.id === ref.kfId);
        return clip && kf ? { ref, t0: kf.t, dur: clipDuration(clip), start: clip.start } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);

    // Snap targets: playhead, clip edges, and unselected keyframes.
    const points = [st.currentTime];
    for (const c of st.clips) {
      points.push(c.start, c.start + clipDuration(c));
      const unselected = (kfs: Keyframe[], fx: string | null, key: string) =>
        kfs.filter((k) => !selection.some((r) => r.kfId === k.id && r.clipId === c.id && r.fx === fx && r.key === key)).forEach((k) => points.push(c.start + k.t));
      for (const [key, kfs] of Object.entries(c.keyframes)) unselected(kfs, null, key);
      for (const fx of c.effects) for (const [key, kfs] of Object.entries(fx.keyframes)) unselected(kfs, fx.id, key);
    }

    const startX = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      document.body.classList.add("dragging-kf");
      let delta = dx / zoom;
      if (useStore.getState().snapping && !ev.altKey) {
        const s = snap(abs + delta, points, SNAP_PX / zoom);
        delta = s.t - abs;
      }
      // Keep the whole group inside each keyframe's clip.
      const lo = Math.max(...originals.map((o) => -o.t0));
      const hi = Math.min(...originals.map((o) => o.dur - o.t0));
      delta = Math.max(lo, Math.min(hi, delta));
      useStore.getState().setKeyframeTimes(originals.map((o) => ({ ref: o.ref, t: o.t0 + delta })));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("dragging-kf");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <button
      data-kf-id={item.kf.id}
      data-kf-clip={item.clip.id}
      data-kf-fx={item.fx ?? ""}
      data-kf-key={item.key}
      className={`kf-diamond ${selected ? "selected" : ""}`}
      style={{ left: abs * zoom, ["--kf-color" as string]: color }}
      onPointerDown={onDown}
      onDoubleClick={() => useStore.getState().seek(abs)}
      {...tip(
        `${item.kf.v.toFixed(2)} at ${item.kf.t.toFixed(2)}s into the clip · ${item.kf.ease}\nDrag to move · double-click to jump the playhead here · ${MOD}C copy, ${MOD}V paste at playhead, Delete removes`,
        { label: "Keyframe" },
      )}
    />
  );
}

/** Toolbar actions shown in an expanded track header. */
export function KeyframeActions() {
  const count = useStore((s) => s.kfSelection.length);
  return (
    <span className="kf-actions">
      <button className="track-btn" disabled={!count} onClick={() => copyKeyframes()} {...tip(`Copy selected keyframes (${MOD}C)`, { label: "Copy keyframes" })}>
        ⧉
      </button>
      <button className="track-btn" disabled={!hasCopiedKeyframes()} onClick={() => pasteKeyframes()} {...tip(`Paste keyframes at the playhead into the selected clip (${MOD}V)`, { label: "Paste keyframes" })}>
        ⎘
      </button>
      <button className="track-btn" disabled={!count} onClick={() => useStore.getState().deleteKeyframes(useStore.getState().kfSelection)} {...tip("Delete selected keyframes (Delete)", { label: "Delete keyframes" })}>
        ⌫
      </button>
    </span>
  );
}
