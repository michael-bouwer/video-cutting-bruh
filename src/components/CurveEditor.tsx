import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { bezierOf, cssTiming, EASING_PRESETS, easingLabel, type Bezier } from "../lib/easing";
import { NumberField } from "./NumberField";
import { tip } from "./Tooltip";
import type { Easing } from "../types";

/**
 * CSS-style timing-curve editor (like the browser devtools cubic-bezier editor):
 * preset thumbnails on the left, a graph with two draggable control points,
 * an animated preview of the timing and the exact cubic-bezier() numbers.
 */

const SIZE = 180; // graph box (the 0..1 square)
const PAD_Y = 30; // minimum room above/below the box
const MARGIN = 14; // extra room around a handle that overshoots
const PAD_Y_DEFAULT = 60;

/** Vertical padding above/below the 0..1 box so overshooting handles stay visible. */
function paddingFor(pts: number[]) {
  const top = Math.max(PAD_Y, (Math.max(pts[1], pts[3]) - 1) * SIZE + MARGIN);
  const bottom = Math.max(PAD_Y, -Math.min(pts[1], pts[3]) * SIZE + MARGIN);
  return { top, bottom, height: SIZE + top + bottom };
}
const r2 = (n: number) => Math.round(n * 100) / 100;

function curvePath(b: Bezier | null, size = SIZE, padY = PAD_Y_DEFAULT): string {
  const m = (x: number, y: number) => `${(x * size).toFixed(1)} ${(padY + (1 - y) * size).toFixed(1)}`;
  if (!b) return `M ${m(0, 0)} L ${m(1, 0)} L ${m(1, 1)}`; // hold: flat, then jump
  return `M ${m(0, 0)} C ${m(b[0], b[1])} ${m(b[2], b[3])} ${m(1, 1)}`;
}

/** Small thumbnail of a curve (used on buttons and presets). */
export function CurveThumb({ ease, curve, size = 22 }: { ease: Easing; curve?: Bezier; size?: number }) {
  const pad = size * 0.22;
  const b = bezierOf(ease, curve);
  return (
    <svg className="curve-thumb" viewBox={`-2 -2 ${size + 4} ${size + pad * 2 + 4}`} width={size} height={size} aria-hidden>
      <path d={curvePath(b, size, pad)} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}

export function CurveEditor({
  ease,
  curve,
  onChange,
}: {
  ease: Easing;
  curve?: Bezier;
  onChange: (ease: Easing, curve?: Bezier) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const b = bezierOf(ease, curve);
  // Hold has no handles; editing starts from linear.
  const pts = [...(b ?? [0, 0, 1, 1])] as Bezier;
  const pad = paddingFor(pts);
  const toSvg = (x: number, y: number) => [x * SIZE, pad.top + (1 - y) * SIZE] as const;

  const drag = (which: 0 | 1) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const svg = svgRef.current!;
    (e.target as Element).setPointerCapture(e.pointerId);
    // Local copy: the latest points during this drag (never mutate shared preset arrays).
    let cur = [...pts] as Bezier;
    const move = (ev: PointerEvent) => {
      // Read the graph's current geometry (it grows when handles overshoot).
      const rect = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const sx = vb.x + ((ev.clientX - rect.left) / rect.width) * vb.width;
      const sy = vb.y + ((ev.clientY - rect.top) / rect.height) * vb.height;
      const top = Number(svg.dataset.padTop);
      let x = sx / SIZE;
      let y = 1 - (sy - top) / SIZE;
      // x must stay within 0..1 (time can't go backwards); y may overshoot.
      x = Math.min(1, Math.max(0, x));
      y = Math.min(2, Math.max(-1, y));
      cur = which === 0 ? [r2(x), r2(y), cur[2], cur[3]] : [cur[0], cur[1], r2(x), r2(y)];
      onChange("custom", cur);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const [p1x, p1y] = toSvg(pts[0], pts[1]);
  const [p2x, p2y] = toSvg(pts[2], pts[3]);
  const [ox, oy] = toSvg(0, 0);
  const [ex, ey] = toSvg(1, 1);
  const setPoint = (i: number, v: number) => {
    const next = [...pts] as Bezier;
    next[i] = i % 2 === 0 ? Math.min(1, Math.max(0, v)) : Math.min(2, Math.max(-1, v));
    onChange("custom", next);
  };

  return (
    <div className="curve-editor">
      <div className="curve-presets" role="listbox" aria-label="Easing presets">
        {EASING_PRESETS.map((p) => (
          <button
            key={p.key}
            role="option"
            aria-selected={ease === p.key}
            className={`curve-preset ${ease === p.key ? "active" : ""}`}
            onClick={() => onChange(p.key, undefined)}
            {...tip(p.curve ? `cubic-bezier(${p.curve.join(", ")})` : "Keep the value until the next keyframe, then jump", { title: p.label })}
          >
            <CurveThumb ease={p.key} size={26} />
            <span>{p.label}</span>
          </button>
        ))}
      </div>
      <div className="curve-main">
        {/* Animated preview: the dot moves with this timing curve. */}
        <div className="curve-preview" aria-hidden>
          <span className="curve-dot" style={{ animationTimingFunction: cssTiming(ease, curve) }} />
        </div>
        <svg
          ref={svgRef}
          className="curve-graph"
          viewBox={`-8 0 ${SIZE + 16} ${pad.height}`}
          data-pad-top={pad.top}
          role="img"
          aria-label="Timing curve"
        >
          {/* 0..1 box and grid */}
          <rect x={0} y={pad.top} width={SIZE} height={SIZE} className="curve-box" />
          {[0.25, 0.5, 0.75].map((g) => (
            <g key={g} className="curve-grid">
              <line x1={g * SIZE} y1={pad.top} x2={g * SIZE} y2={pad.top + SIZE} />
              <line x1={0} y1={pad.top + g * SIZE} x2={SIZE} y2={pad.top + g * SIZE} />
            </g>
          ))}
          <line x1={ox} y1={oy} x2={ex} y2={ey} className="curve-diagonal" />
          {b && (
            <>
              <line x1={ox} y1={oy} x2={p1x} y2={p1y} className="curve-arm" />
              <line x1={ex} y1={ey} x2={p2x} y2={p2y} className="curve-arm" />
            </>
          )}
          <path d={curvePath(b, SIZE, pad.top)} className="curve-line" />
          <circle cx={ox} cy={oy} r={3} className="curve-end" />
          <circle cx={ex} cy={ey} r={3} className="curve-end" />
          {b && (
            <>
              <circle cx={p1x} cy={p1y} r={7} className="curve-handle" onPointerDown={drag(0)} {...tip("Drag: start of the curve (x = time, y = progress; up/down past the box overshoots)")} />
              <circle cx={p2x} cy={p2y} r={7} className="curve-handle" onPointerDown={drag(1)} {...tip("Drag: end of the curve")} />
            </>
          )}
        </svg>
        <div className="curve-label">
          {easingLabel(ease)}
          <span className="muted small"> · {b ? `cubic-bezier(${pts.map((n) => +n.toFixed(2)).join(", ")})` : "step"}</span>
        </div>
        {b && (
          <div className="curve-numbers">
            {(["x1", "y1", "x2", "y2"] as const).map((label, i) => (
              <NumberField
                key={label}
                value={pts[i]}
                step={0.01}
                precision={2}
                min={i % 2 === 0 ? 0 : -1}
                max={i % 2 === 0 ? 1 : 2}
                onChange={(v) => setPoint(i, v)}
                aria-label={label}
                {...tip(`${label} — drag or click to type`)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Button showing the current easing (mini graph + name). Click opens the curve
 * editor in a pop-over that stays inside the window.
 */
export function EasingButton({
  ease,
  curve,
  onChange,
  title = "Easing",
}: {
  ease: Easing;
  curve?: Bezier;
  onChange: (ease: Easing, curve?: Bezier) => void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current || !popRef.current) return;
    const b = btnRef.current.getBoundingClientRect();
    const p = popRef.current.getBoundingClientRect();
    const m = 8;
    let left = b.right - p.width;
    if (left < m) left = Math.min(b.left, window.innerWidth - p.width - m);
    let top = b.bottom + 6;
    if (top + p.height > window.innerHeight - m) top = Math.max(m, b.top - p.height - 6);
    setPos({ left: Math.max(m, left), top });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!popRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        className={`easing-btn ${open ? "active" : ""}`}
        onClick={() => {
          setPos(null);
          setOpen((o) => !o);
        }}
        {...tip("Click to edit the timing curve — pick a preset or drag the curve's handles, like CSS cubic-bezier()", { title: `${title}: ${easingLabel(ease)}` })}
      >
        <CurveThumb ease={ease} curve={curve} size={16} />
        <span>{easingLabel(ease)}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="curve-popover"
            role="dialog"
            aria-label={`${title} curve`}
            style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
          >
            <CurveEditor ease={ease} curve={curve} onChange={onChange} />
          </div>,
          document.body,
        )}
    </>
  );
}
