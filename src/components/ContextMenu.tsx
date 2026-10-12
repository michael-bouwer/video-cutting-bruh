import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { create } from "zustand";

/** A right-click menu at a viewport position; `content` renders the items. */
interface MenuState {
  menu: { x: number; y: number; content: (close: () => void) => ReactNode } | null;
}

export const useContextMenu = create<MenuState>(() => ({ menu: null }));

export function openContextMenu(e: { clientX: number; clientY: number; preventDefault: () => void }, content: (close: () => void) => ReactNode) {
  e.preventDefault();
  useContextMenu.setState({ menu: { x: e.clientX, y: e.clientY, content } });
}

const close = () => useContextMenu.setState({ menu: null });

export function ContextMenuHost() {
  const menu = useContextMenu((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4))}px`;
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  if (!menu) return null;
  return (
    <div className="context-menu dropdown-panel" ref={ref} style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()}>
      <div className="menu">{menu.content(close)}</div>
    </div>
  );
}
