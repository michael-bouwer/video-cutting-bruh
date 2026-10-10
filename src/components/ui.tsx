import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { tip as tipProps } from "./Tooltip";

/** Button + popover that closes on outside click / Escape and never leaves the viewport. */
export function Dropdown({
  label,
  tip,
  align = "left",
  className = "",
  children,
}: {
  label: ReactNode;
  /** Tooltip props from `tip()`. */
  tip?: ReturnType<typeof tipProps>;
  align?: "left" | "right";
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`dropdown ${className}`} ref={ref}>
      <button className={open ? "active" : ""} {...(open ? {} : tip)} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open && <div className={`dropdown-panel ${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function MenuItem({
  label,
  shortcut,
  disabled,
  onClick,
}: {
  label: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="menu-item" disabled={disabled} onClick={onClick}>
      <span className="menu-label">{label}</span>
      {shortcut && <span className="menu-shortcut">{shortcut}</span>}
    </button>
  );
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** Formats a shortcut for the current OS, e.g. "Mod+S" → "Ctrl+S" / "⌘S". */
export const kbd = (s: string) => (isMac ? s.replace(/Mod\+/g, "⌘").replace(/Shift\+/g, "⇧") : s.replace(/Mod\+/g, "Ctrl+"));

/** Renders the store's current dialog request as a modal. */
export function DialogHost() {
  const dialog = useStore((s) => s.dialog);
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!dialog) return;
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dialog.resolve(dialog.cancelId);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dialog]);

  if (!dialog) return null;
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && dialog.resolve(dialog.cancelId)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">{dialog.title}</h2>
        <p>{dialog.message}</p>
        <div className="modal-actions">
          {dialog.buttons.map((b) => (
            <button
              key={b.id}
              ref={b.kind === "primary" ? primaryRef : undefined}
              className={b.kind ?? ""}
              onClick={() => dialog.resolve(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Draggable divider between panels. Reports the pointer delta since drag start. */
export function Splitter({
  orientation,
  onStart,
  onDrag,
  onEnd,
  onReset,
}: {
  orientation: "vertical" | "horizontal";
  onStart?: () => void;
  onDrag: (delta: number) => void;
  onEnd?: () => void;
  /** Double-click action, e.g. restoring default sizes. */
  onReset?: () => void;
}) {
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    onStart?.();
    const start = orientation === "vertical" ? e.clientX : e.clientY;
    const move = (ev: PointerEvent) => onDrag((orientation === "vertical" ? ev.clientX : ev.clientY) - start);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      onEnd?.();
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      className={`splitter ${orientation}`}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      role="separator"
      aria-orientation={orientation}
      {...tipProps(`Drag to resize${onReset ? " · double-click to reset the layout" : ""}`)}
    />
  );
}
