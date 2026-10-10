import { useStore } from "../store";
import type { KeyframeRef } from "../types";

/**
 * Box (marquee) selection in the timeline.
 *
 * Starts on a pointerdown on empty lane space. If the pointer moves, a box is
 * drawn and every clip and keyframe it touches is selected (Shift/Ctrl/⌘ adds
 * to the existing selection, like Shift-click). If it doesn't move, it's a
 * click: `onClick` runs (the timeline seeks there and clears the selection).
 */
export interface MarqueeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

type Listener = (box: MarqueeBox | null) => void;
let listener: Listener | null = null;
/** The timeline registers the function that draws the box. */
export function onMarquee(fn: Listener | null): void {
  listener = fn;
}

const intersects = (a: DOMRect, b: { l: number; t: number; r: number; b: number }) =>
  a.left < b.r && a.right > b.l && a.top < b.b && a.bottom > b.t;

export function startMarquee(e: React.PointerEvent, onClick: () => void) {
  if (e.button !== 0) return;
  const content = document.querySelector<HTMLElement>(".timeline-content");
  const scroller = document.querySelector<HTMLElement>(".timeline-scroll");
  if (!content || !scroller) return;
  e.preventDefault();
  const sx = e.clientX;
  const sy = e.clientY;
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  const st = useStore.getState();
  const baseClips = additive ? st.clipSelection : [];
  const baseKfs = additive ? st.kfSelection : [];
  let active = false;
  let last = { x: sx, y: sy };

  const update = () => {
    const cr = content.getBoundingClientRect();
    const l = Math.min(sx, last.x);
    const r = Math.max(sx, last.x);
    const t = Math.min(sy, last.y);
    const b = Math.max(sy, last.y);
    listener?.({ left: l - cr.left, top: t - cr.top, width: r - l, height: b - t });

    const box = { l, t, r, b };
    const clipIds = [...content.querySelectorAll<HTMLElement>("[data-clip-id]")]
      .filter((el) => intersects(el.getBoundingClientRect(), box))
      .map((el) => el.dataset.clipId!);
    const kfs: KeyframeRef[] = [...content.querySelectorAll<HTMLElement>("[data-kf-id]")]
      .filter((el) => intersects(el.getBoundingClientRect(), box))
      .map((el) => ({ clipId: el.dataset.kfClip!, fx: el.dataset.kfFx || null, key: el.dataset.kfKey!, kfId: el.dataset.kfId! }));
    const s = useStore.getState();
    s.selectClips([...baseClips, ...clipIds.filter((id) => !baseClips.includes(id))]);
    s.selectKeyframes([...baseKfs, ...kfs]);
  };

  // Keep the box growing while the timeline auto-scrolls near its edges.
  let timer = 0;
  const autoscroll = () => {
    const r = scroller.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    if (last.x < r.left + 30) dx = -14;
    else if (last.x > r.right - 30) dx = 14;
    if (last.y < r.top + 30) dy = -10;
    else if (last.y > r.bottom - 20) dy = 10;
    if (dx || dy) {
      scroller.scrollLeft += dx;
      scroller.scrollTop += dy;
      update();
    }
  };

  const move = (ev: PointerEvent) => {
    last = { x: ev.clientX, y: ev.clientY };
    if (!active) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      active = true;
      document.body.classList.add("marquee-selecting");
      timer = window.setInterval(autoscroll, 30);
    }
    update();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.clearInterval(timer);
    document.body.classList.remove("marquee-selecting");
    listener?.(null);
    if (!active) onClick();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
