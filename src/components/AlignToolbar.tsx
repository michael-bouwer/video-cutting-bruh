import { useStore } from "../store";
import { transformAt } from "../lib/keyframes";
import { clipEnd } from "../lib/timeline";
import { tip } from "./Tooltip";
import type { AnimProp } from "../types";

type Align = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom" | "fit" | "fill" | "reset";

/** The selected clip on a video track, if the playhead is over it. */
function target() {
  const s = useStore.getState();
  if (s.selection?.kind !== "clip") return null;
  const clip = s.clips.find((c) => c.id === s.selection!.clipId);
  if (!clip || s.tracks.find((t) => t.id === clip.trackId)?.kind !== "video") return null;
  if (s.currentTime < clip.start || s.currentTime > clipEnd(clip)) return null;
  const m = s.media.find((x) => x.id === clip.mediaId);
  const sw = m?.width || m?.probe?.width || 0;
  const sh = m?.height || m?.probe?.height || 0;
  if (!sw || !sh) return null;
  return { clip, sw, sh, local: s.currentTime - clip.start };
}

/**
 * Moves/scales the selected clip so its (scaled, rotated) bounding box lines up
 * with the frame. Uses the normal property setter, so animated properties get a
 * keyframe at the playhead.
 */
function align(mode: Align) {
  const tgt = target();
  if (!tgt) return;
  const { clip, sw, sh, local } = tgt;
  const st = useStore.getState();
  const { width: W, height: H } = st.settings;
  const tr = transformAt(clip, local);
  // Clips are fitted ("contain") into the frame before the transform is applied.
  const fit = Math.min(W / sw, H / sh);
  const dw = sw * fit;
  const dh = sh * fit;
  const s = tr.scale / 100;
  const rad = (tr.rotation * Math.PI) / 180;
  const bw = (Math.abs(dw * Math.cos(rad)) + Math.abs(dh * Math.sin(rad))) * s;
  const bh = (Math.abs(dw * Math.sin(rad)) + Math.abs(dh * Math.cos(rad))) * s;
  const set = (prop: AnimProp, v: number) => st.setPropValue(clip.id, prop, local, Math.round(v * 100) / 100);

  switch (mode) {
    case "left":
      return set("x", ((bw / 2 - W / 2) / W) * 100);
    case "hcenter":
      return set("x", 0);
    case "right":
      return set("x", ((W / 2 - bw / 2) / W) * 100);
    case "top":
      return set("y", ((bh / 2 - H / 2) / H) * 100);
    case "vcenter":
      return set("y", 0);
    case "bottom":
      return set("y", ((H / 2 - bh / 2) / H) * 100);
    case "fit":
      set("scale", 100);
      set("x", 0);
      return set("y", 0);
    case "fill":
      // Unrotated cover: the smaller side reaches the frame edge.
      set("scale", Math.max(W / dw, H / dh) * 100);
      set("x", 0);
      return set("y", 0);
    case "reset":
      for (const p of ["x", "y", "rotation"] as const) set(p, 0);
      return set("scale", 100);
  }
}

// Small line icons: a frame edge/centre line and the object box.
const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <path d={d} />
  </svg>
);
const ICONS: Record<Align, string> = {
  left: "M2 2v12 M5 5h8v6H5z",
  hcenter: "M8 2v12 M4 5h8v6H4z",
  right: "M14 2v12 M3 5h8v6H3z",
  top: "M2 2h12 M5 5h6v8H5z",
  vcenter: "M2 8h12 M5 4h6v8H5z",
  bottom: "M2 14h12 M5 3h6v8H5z",
  fit: "M2 4h12v8H2z M5 6h6v4H5z",
  fill: "M2 4h12v8H2z M1 2h14 M1 14h14",
  reset: "M3 8a5 5 0 1 0 1.5-3.5 M3 2v3h3",
};

const BUTTONS: { mode: Align; label: string; hint: string }[][] = [
  [
    { mode: "left", label: "Align left", hint: "Line the clip's left edge up with the frame's left edge" },
    { mode: "hcenter", label: "Centre horizontally", hint: "Centre the clip horizontally" },
    { mode: "right", label: "Align right", hint: "Line the clip's right edge up with the frame's right edge" },
  ],
  [
    { mode: "top", label: "Align top", hint: "Line the clip's top edge up with the top of the frame" },
    { mode: "vcenter", label: "Centre vertically", hint: "Centre the clip vertically" },
    { mode: "bottom", label: "Align bottom", hint: "Line the clip's bottom edge up with the bottom of the frame" },
  ],
  [
    { mode: "fit", label: "Fit", hint: "Scale to fit the whole clip inside the frame (100%) and centre it" },
    { mode: "fill", label: "Fill", hint: "Scale up until the clip covers the whole frame (crops the edges) and centre it" },
    { mode: "reset", label: "Reset", hint: "Reset position, scale and rotation" },
  ],
];

/** Alignment shortcuts for the selected clip, shown above the preview. */
export function AlignToolbar() {
  // Re-render when what `target()` depends on changes.
  const enabled = useStore((s) => {
    if (s.selection?.kind !== "clip") return false;
    const clip = s.clips.find((c) => c.id === s.selection!.clipId);
    return !!clip && s.tracks.find((t) => t.id === clip.trackId)?.kind === "video" && s.currentTime >= clip.start && s.currentTime <= clipEnd(clip);
  });
  const why = useStore((s) => (s.selection?.kind !== "clip" ? "Select a video or image clip on the timeline to align it." : "Move the playhead over the selected clip (and it must be on a video track)."));

  return (
    <div className="align-toolbar" role="toolbar" aria-label="Align selected clip">
      <span className="muted small align-label">Align</span>
      {BUTTONS.map((group, i) => (
        <div key={i} className="align-group">
          {group.map((b) => (
            <button
              key={b.mode}
              className="icon-btn"
              disabled={!enabled}
              onClick={() => align(b.mode)}
              {...tip(enabled ? `${b.hint}. Takes scale and rotation into account; animated properties get a keyframe at the playhead.` : why, { title: b.label, label: b.label })}
            >
              <Icon d={ICONS[b.mode]} />
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
