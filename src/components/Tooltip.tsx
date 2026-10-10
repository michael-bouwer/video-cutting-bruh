import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Props for an element with a tooltip. Read by <TooltipLayer/> via event
 * delegation, so any element can have one without wrapper components.
 *
 *   <button {...tip("Cut the clip under the playhead", { kbd: "S" })}>✂</button>
 *
 * `label` also sets aria-label (use it for icon-only buttons).
 */
export function tip(text: string, opts: { title?: string; kbd?: string; label?: string } = {}) {
  return {
    "data-tip": text,
    ...(opts.title ? { "data-tip-title": opts.title } : {}),
    ...(opts.kbd ? { "data-tip-kbd": opts.kbd } : {}),
    ...(opts.label ? { "aria-label": opts.label } : {}),
  };
}

const SHOW_DELAY = 450;
/** After a tooltip was just visible, neighbouring ones show almost instantly. */
const WARM_DELAY = 60;
const WARM_WINDOW = 500;
const MARGIN = 8;
const GAP = 8;

interface TipState {
  el: HTMLElement;
  text: string;
  title?: string;
  kbd?: string;
}

function read(el: HTMLElement): TipState | null {
  const text = el.dataset.tip;
  if (!text) return null;
  return { el, text, title: el.dataset.tipTitle, kbd: el.dataset.tipKbd };
}

export function TooltipLayer() {
  const [tipState, setTip] = useState<TipState | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer = 0;
    let current: HTMLElement | null = null;
    let lastHidden = 0;
    /** Set on press so a tooltip doesn't pop up mid-drag; cleared on leaving the element. */
    let suppressed: HTMLElement | null = null;
    let observer: MutationObserver | null = null;

    const hide = () => {
      clearTimeout(timer);
      if (current) lastHidden = performance.now();
      current = null;
      observer?.disconnect();
      setTip(null);
      setPos(null);
    };

    const show = (el: HTMLElement) => {
      const t = read(el);
      if (!t || !el.isConnected) return;
      current = el;
      setTip(t);
      // Keep content live if the element's tip changes while shown (e.g. ◆ toggled).
      observer?.disconnect();
      observer = new MutationObserver(() => {
        const next = read(el);
        if (next) setTip(next);
        else hide();
      });
      observer.observe(el, { attributes: true, attributeFilter: ["data-tip", "data-tip-title", "data-tip-kbd"] });
    };

    const schedule = (el: HTMLElement, immediate = false) => {
      clearTimeout(timer);
      const warm = performance.now() - lastHidden < WARM_WINDOW;
      timer = window.setTimeout(() => show(el), immediate ? 0 : warm ? WARM_DELAY : SHOW_DELAY);
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = (e.target as Element | null)?.closest<HTMLElement>("[data-tip]") ?? null;
      if (el === current || el === suppressed) return;
      if (current) hide();
      suppressed = null;
      if (el) schedule(el);
      else clearTimeout(timer);
    };
    const onOut = (e: PointerEvent) => {
      const to = e.relatedTarget as Node | null;
      const el = (e.target as Element | null)?.closest<HTMLElement>("[data-tip]");
      if (!el || (to && el.contains(to))) return;
      if (el === suppressed) suppressed = null;
      if (el === current || !current) hide();
    };
    const onDown = (e: PointerEvent) => {
      suppressed = (e.target as Element | null)?.closest<HTMLElement>("[data-tip]") ?? null;
      hide();
    };
    const onFocus = (e: FocusEvent) => {
      const el = (e.target as Element | null)?.closest<HTMLElement>("[data-tip]");
      // Keyboard focus only: mouse clicks also focus buttons.
      if (el && el.matches(":focus-visible")) schedule(el, true);
    };
    const onBlur = () => current && hide();

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    window.addEventListener("wheel", hide, { passive: true });
    window.addEventListener("keydown", hide);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    return () => {
      clearTimeout(timer);
      observer?.disconnect();
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      window.removeEventListener("wheel", hide);
      window.removeEventListener("keydown", hide);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
    };
  }, []);

  // Place below the target (above if there's no room), clamped inside the window.
  useLayoutEffect(() => {
    if (!tipState || !boxRef.current) return;
    const r = tipState.el.getBoundingClientRect();
    const box = boxRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const below = r.bottom + GAP + box.height <= vh - MARGIN || r.top - GAP - box.height < MARGIN;
    const y = below ? Math.min(r.bottom + GAP, vh - MARGIN - box.height) : r.top - GAP - box.height;
    const x = Math.min(Math.max(MARGIN, r.left + r.width / 2 - box.width / 2), vw - MARGIN - box.width);
    setPos({ x, y: Math.max(MARGIN, y), below });
  }, [tipState]);

  if (!tipState) return null;
  return (
    <div
      ref={boxRef}
      className={`tooltip ${pos ? "visible" : ""}`}
      role="tooltip"
      style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: -9999 }}
    >
      {(tipState.title || tipState.kbd) && (
        <div className="tooltip-head">
          {tipState.title && <strong>{tipState.title}</strong>}
          {tipState.kbd && <kbd>{tipState.kbd}</kbd>}
        </div>
      )}
      <div className="tooltip-text">{tipState.text}</div>
    </div>
  );
}
