import { useEffect, useRef } from "react";
import { player } from "../engine/player";
import { useStore } from "../store";
import { clipEnd, trackFrameAt } from "../lib/timeline";
import { valueAt } from "../lib/keyframes";
import { openImportDialog } from "../lib/media";
import { getRecent, newProject, openProject } from "../lib/project";
import { kbd } from "./ui";
import { tip } from "./Tooltip";

export function Preview() {
  const { width, height, allowHdr } = useStore((s) => s.settings);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Media under the playhead that's still being converted for preview.
  const pending = useStore((s) => {
    // Topmost visible video track with a clip whose media is still being converted.
    for (const track of [...s.tracks].reverse()) {
      if (track.kind !== "video" || track.hidden) continue;
      const clip = trackFrameAt(s.clips, track.id, s.currentTime).current;
      const m = clip && s.media.find((x) => x.id === clip.mediaId);
      if (m?.status === "proxying") return Math.round((m.proxy?.progress ?? 0) * 100);
      if (clip) break;
    }
    return null;
  });
  // Whether dragging the canvas would move something right now.
  const dragTarget = useStore((s) => {
    if (s.selection?.kind !== "clip") return "none";
    const clip = s.clips.find((c) => c.id === s.selection!.clipId);
    if (!clip || s.tracks.find((t) => t.id === clip.trackId)?.kind !== "video") return "none";
    return s.currentTime >= clip.start && s.currentTime <= clipEnd(clip) ? "ready" : "outside";
  });
  // Wider-gamut canvas when HDR clips are allowed; webviews that don't support
  // it silently fall back to sRGB.
  const colorSpace: PredefinedColorSpace = allowHdr ? "display-p3" : "srgb";

  useEffect(() => {
    const c = canvasRef.current!;
    player.attach(c, colorSpace);
    return () => player.detach(c);
  }, [colorSpace]);

  // Drag on the preview to move the selected clip (writes keyframes if animated).
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = useStore.getState();
    if (s.selection?.kind !== "clip") return;
    const clip = s.clips.find((c) => c.id === s.selection!.clipId);
    if (!clip || s.tracks.find((t) => t.id === clip.trackId)?.kind !== "video") return;
    if (s.currentTime < clip.start || s.currentTime > clipEnd(clip)) return;
    const local = s.currentTime - clip.start;
    const x0 = valueAt(clip, "x", local);
    const y0 = valueAt(clip, "y", local);
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ((ev.clientX - sx) / rect.width) * 100;
      const dy = ((ev.clientY - sy) / rect.height) * 100;
      const st = useStore.getState();
      st.setPropValue(clip.id, "x", local, Math.round((x0 + dx) * 10) / 10);
      st.setPropValue(clip.id, "y", local, Math.round((y0 + dy) * 10) / 10);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section className="preview">
      <div className="preview-stage">
        <canvas
          key={colorSpace}
          ref={canvasRef}
          width={width}
          height={height}
          style={{ aspectRatio: `${width} / ${height}` }}
          onPointerDown={onPointerDown}
          {...tip(
            dragTarget === "ready"
              ? "Drag to move the selected clip. If its position is animated, this sets a keyframe at the playhead."
              : dragTarget === "outside"
                ? "Move the playhead over the selected clip, then drag here to move it."
                : "Select a clip on the timeline, then drag here to move it.",
            { title: "Preview" },
          )}
        />
        {pending !== null && <div className="preview-overlay">Optimizing clip for preview… {pending}%</div>}
        <Welcome />
      </div>
    </section>
  );
}

/** Start screen shown on an empty project. */
function Welcome() {
  const empty = useStore((s) => s.clips.length === 0 && s.media.length === 0);
  useStore((s) => s.recentVersion);
  if (!empty) return null;
  const recent = getRecent().slice(0, 5);
  return (
    <div className="welcome">
      <h1>Start editing</h1>
      <p className="muted">Create a project, or just drop videos anywhere to start.</p>
      <div className="welcome-actions">
        <button
          className="primary"
          onClick={newProject}
          {...tip("Create a project in its own folder. Preview copies of your videos are stored there too, so everything about the project stays together.")}
        >
          New project… <span className="small">{kbd("Mod+N")}</span>
        </button>
        <button onClick={openImportDialog} {...tip("Start right away in a temporary project. Its preview copies move into the project folder when you save.")}>
          Import videos… <span className="muted small">{kbd("Mod+I")}</span>
        </button>
        <button onClick={() => openProject()}>
          Open project… <span className="muted small">{kbd("Mod+O")}</span>
        </button>
      </div>
      {recent.length > 0 && (
        <div className="welcome-recent">
          <div className="menu-heading">Recent projects</div>
          {recent.map((r) => (
            <button key={r.path} className="recent-row" onClick={() => openProject(r.path)}>
              <span>{r.name}</span>
              <span className="muted small">{r.path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
