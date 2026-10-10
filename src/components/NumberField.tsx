import { useEffect, useRef, useState } from "react";

/**
 * Numeric input you can drag left/right to change (like After Effects / Blender),
 * or click to type into.
 *
 * - Drag: changes the value; Shift = 10× faster, Alt/⌥ = 10× finer.
 * - Click without dragging: edit as text; Enter/blur commits, Escape cancels.
 * - Arrow up/down while editing: step (with the same modifiers).
 *
 * `onChange` fires continuously while dragging; history coalesces the gesture into one undo step.
 */
export function NumberField({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  precision,
  unit,
  perPx: perPxProp,
  className = "",
  title,
  disabled,
  "aria-label": ariaLabel,
  ...rest
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Decimal places shown (default: from `step`). */
  precision?: number;
  unit?: string;
  /** Value change per pixel dragged (default: based on the min–max range). */
  perPx?: number;
  className?: string;
  title?: string;
  disabled?: boolean;
  "aria-label"?: string;
} & Record<`data-${string}`, string | undefined>) {
  const decimals = precision ?? Math.max(0, Math.min(4, (String(step).split(".")[1] ?? "").length));
  const format = (v: number) => (Number.isFinite(v) ? v.toFixed(decimals) : "");
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(format(value));
  const inputRef = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    if (!editing) setText(format(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editing, decimals]);

  // Focus and select the text as soon as editing starts.
  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (el && document.activeElement !== el) el.focus();
    el?.select();
  }, [editing]);

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const snapStep = (v: number) => Math.round(v / step) * step;
  const commit = (raw: string) => {
    const v = Number(raw.replace(",", "."));
    if (Number.isFinite(v)) onChange(clamp(v));
    setEditing(false);
  };

  // Pixels → value: at least one step per 2 px, faster for wide ranges.
  const range = Number.isFinite(max - min) ? max - min : 1000 * step;
  const perPx = perPxProp ?? Math.max(step / 2, range / 600);

  const onPointerDown = (e: React.PointerEvent<HTMLInputElement>) => {
    if (disabled || editing || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    const start = value;
    dragging.current = false;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!dragging.current && Math.abs(dx) < 3) return;
      if (!dragging.current) {
        dragging.current = true;
        document.body.classList.add("scrubbing");
      }
      const speed = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      onChange(clamp(snapStep(start + dx * perPx * speed)));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.classList.remove("scrubbing");
      // A click (no drag): switch to typing — focused by the effect below.
      if (!dragging.current) setEditing(true);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <span className={`number-field ${editing ? "editing" : ""} ${disabled ? "disabled" : ""} ${className}`}>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={text}
        readOnly={!editing}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        onPointerDown={onPointerDown}
        onFocus={() => {
          // Keyboard focus (Tab) goes straight to editing.
          if (!editing && !dragging.current) setEditing(true);
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => editing && commit(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(text);
          else if (e.key === "Escape") {
            setText(format(value));
            setEditing(false);
            inputRef.current?.blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const speed = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
            const v = clamp(snapStep(value + (e.key === "ArrowUp" ? 1 : -1) * step * speed));
            onChange(v);
            setText(format(v));
          }
        }}
        {...rest}
      />
      {unit && <span className="number-unit">{unit}</span>}
    </span>
  );
}
