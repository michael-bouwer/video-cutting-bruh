import { useCallback, useEffect, useRef, useState } from "react";

/** Panel sizes in CSS pixels. The CSS grid clamps them further so the preview never collapses. */
export interface PanelSizes {
  bin: number;
  inspector: number;
  timeline: number;
}

const KEY = "vcb.layout";
const DEFAULTS: PanelSizes = { bin: 260, inspector: 300, timeline: 250 };
const LIMITS = {
  bin: [170, 480],
  inspector: [220, 520],
  timeline: [150, 420],
} as const;

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.round(Math.min(hi, Math.max(lo, v)));

function load(): PanelSizes {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      bin: clamp(saved.bin ?? DEFAULTS.bin, LIMITS.bin),
      inspector: clamp(saved.inspector ?? DEFAULTS.inspector, LIMITS.inspector),
      timeline: clamp(saved.timeline ?? DEFAULTS.timeline, LIMITS.timeline),
    };
  } catch {
    return DEFAULTS;
  }
}

/**
 * Resizable panel sizes, remembered per device. `begin()` snapshots the current
 * sizes at drag start; `resize(key, delta)` applies a delta relative to that.
 */
export function usePanelSizes() {
  const [sizes, setSizes] = useState<PanelSizes>(load);
  const start = useRef(sizes);
  const current = useRef(sizes);
  current.current = sizes;

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(sizes));
    } catch {
      /* optional */
    }
  }, [sizes]);

  const begin = useCallback(() => {
    start.current = current.current;
  }, []);

  const resize = useCallback((key: keyof PanelSizes, delta: number) => {
    setSizes((s) => ({ ...s, [key]: clamp(start.current[key] + delta, LIMITS[key]) }));
  }, []);

  const reset = useCallback(() => setSizes(DEFAULTS), []);
  return { sizes, begin, resize, reset };
}
