import { useEffect, useRef, useState } from "react";
import { MARKER_COLORS, useStore } from "../store";
import { openContextMenu } from "./ContextMenu";
import { MenuItem } from "./ui";
import { tip } from "./Tooltip";
import { formatTime } from "../lib/timeline";
import type { Marker } from "../types";

/** Adds a marker at the playhead (M). */
export function addMarkerAtPlayhead() {
  const s = useStore.getState();
  const fps = s.settings.fps;
  // Don't stack a second marker on the same frame.
  if (s.markers.some((m) => Math.abs(m.t - s.currentTime) < 0.5 / fps)) return;
  s.addMarker(s.currentTime);
}

/** Moves the playhead to the previous (-1) or next (+1) marker. */
export function jumpToMarker(dir: -1 | 1) {
  const s = useStore.getState();
  const eps = 0.5 / s.settings.fps;
  const target = dir > 0 ? s.markers.find((m) => m.t > s.currentTime + eps) : [...s.markers].reverse().find((m) => m.t < s.currentTime - eps);
  if (target) {
    s.setPlaying(false);
    s.seek(target.t);
  }
}

/** Marker flags in the ruler: drag to move, click to jump, double-click to rename, right-click for more. */
export function RulerMarkers({ zoom, timeAt }: { zoom: number; timeAt: (clientX: number) => number }) {
  const markers = useStore((s) => s.markers);
  const fps = useStore((s) => s.settings.fps);
  const [editing, setEditing] = useState<string | null>(null);

  const onDown = (m: Marker) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const x0 = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      useStore.getState().updateMarker(m.id, { t: timeAt(ev.clientX) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) {
        const s = useStore.getState();
        s.setPlaying(false);
        s.seek(m.t);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const menu = (m: Marker) => (e: React.MouseEvent) => {
    e.stopPropagation();
    openContextMenu(e, (close) => (
      <>
        <div className="menu-heading">{m.label}</div>
        <MenuItem label="Rename…" onClick={() => (close(), setEditing(m.id))} />
        <div className="swatch-row">
          {MARKER_COLORS.map((c) => (
            <button key={c} className={`swatch ${m.color === c ? "on" : ""}`} style={{ background: c }} onClick={() => (close(), useStore.getState().updateMarker(m.id, { color: c }))} aria-label={`Colour ${c}`} />
          ))}
        </div>
        <div className="menu-sep" />
        <MenuItem label="Delete marker" onClick={() => (close(), useStore.getState().removeMarker(m.id))} />
      </>
    ));
  };

  return (
    <>
      {markers.map((m) => (
        <div
          key={m.id}
          className="marker-flag"
          style={{ left: m.t * zoom, ["--marker-color" as string]: m.color }}
          onPointerDown={onDown(m)}
          onDoubleClick={(e) => (e.stopPropagation(), setEditing(m.id))}
          onContextMenu={menu(m)}
          {...tip("Click to jump here · drag to move · double-click to rename · right-click for colour/delete", { title: `${m.label} · ${formatTime(m.t, fps)}` })}
        >
          {editing === m.id ? <MarkerNameInput marker={m} onDone={() => setEditing(null)} /> : <span>{m.label}</span>}
        </div>
      ))}
    </>
  );
}

function MarkerNameInput({ marker, onDone }: { marker: Marker; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const label = ref.current?.value.trim();
    if (label) useStore.getState().updateMarker(marker.id, { label });
    onDone();
  };
  return (
    <input
      ref={ref}
      className="marker-input"
      defaultValue={marker.label}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onDone();
      }}
    />
  );
}

/** Thin marker lines through the tracks (behind clips' outlines, above lanes). */
export function MarkerLines({ zoom, offset }: { zoom: number; offset: number }) {
  const markers = useStore((s) => s.markers);
  return (
    <>
      {markers.map((m) => (
        <div key={m.id} className="marker-line" style={{ left: offset + m.t * zoom, background: m.color }} />
      ))}
    </>
  );
}
