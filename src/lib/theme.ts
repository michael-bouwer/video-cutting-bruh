import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";

/** "system" follows the OS light/dark setting. */
export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

// Keep in sync with the inline script in index.html (prevents a flash on startup).
const KEY = "vcb.theme";
const media = window.matchMedia("(prefers-color-scheme: light)");
const listeners = new Set<() => void>();

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

let pref: ThemePref = readPref();

export const resolveTheme = (p: ThemePref): Theme => (p === "system" ? (media.matches ? "light" : "dark") : p);

function apply(animate: boolean) {
  const root = document.documentElement;
  if (animate) {
    root.classList.add("theme-transition");
    window.setTimeout(() => root.classList.remove("theme-transition"), 250);
  }
  root.dataset.theme = resolveTheme(pref);
  // Native title bar / window chrome: null lets the OS decide for "system".
  if (isTauri()) {
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(pref === "system" ? null : pref))
      .catch(() => {});
  }
  listeners.forEach((l) => l());
}

export function setThemePref(next: ThemePref) {
  pref = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* per-device preference; fine if it can't persist */
  }
  apply(true);
}

/** Applies the saved theme and follows OS changes while set to "system". */
export function installTheme() {
  apply(false);
  media.addEventListener("change", () => pref === "system" && apply(true));
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Current preference and the theme it resolves to. */
export function useTheme(): { pref: ThemePref; theme: Theme } {
  const p = useSyncExternalStore(subscribe, () => pref);
  const theme = useSyncExternalStore(subscribe, () => resolveTheme(pref));
  return { pref: p, theme };
}
