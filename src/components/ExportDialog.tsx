import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { even, listEncoders, startExport, type Codec, type EncoderInfo, type ExportHandle, type ExportProgress, type Quality } from "../lib/export";
import { planFor, startHqExport } from "../lib/exportHq";
import { projectName } from "../lib/dialog";
import { formatTime, timelineEnd } from "../lib/timeline";
import { tip } from "./Tooltip";

const CODEC_LABEL: Record<Codec, string> = { h264: "H.264", hevc: "HEVC (H.265)", av1: "AV1" };
const CODEC_HINT: Record<Codec, string> = {
  h264: "Plays everywhere (phones, browsers, YouTube, Discord). Best default.",
  hevc: "About 40% smaller than H.264 at the same quality. Plays on most modern devices.",
  av1: "Smallest files. Needs fairly recent hardware or software to play smoothly.",
};
const ENCODER_LABEL = (e: EncoderInfo) =>
  e.hardware
    ? `${e.encoder.split("_").pop()!.toUpperCase().replace("VIDEOTOOLBOX", "VideoToolbox")} (GPU)`
    : `${e.encoder} (CPU)`;
const LAST_DIR_KEY = "vcb.exportDir";
const MODE_KEY = "vcb.exportMode";

/** preview: render frames with the preview engine (matches it exactly). original: ffmpeg renders from the source files. */
type Mode = "preview" | "original";

const readMode = (): Mode => {
  try {
    return localStorage.getItem(MODE_KEY) === "original" ? "original" : "preview";
  } catch {
    return "preview";
  }
};

type Phase = "setup" | "running" | "done" | "error";

const fmtDuration = (s: number) => {
  if (!Number.isFinite(s) || s <= 0) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m ? `${m}m ${String(sec).padStart(2, "0")}s` : `${sec}s`;
};

async function defaultPath(): Promise<string> {
  const { join, dirname, videoDir } = await import("@tauri-apps/api/path");
  const projectPath = useStore.getState().projectPath;
  const name = `${projectName(projectPath)}.mp4`;
  try {
    const last = localStorage.getItem(LAST_DIR_KEY);
    if (last) return join(last, name);
  } catch {
    /* ignore */
  }
  if (projectPath) return join(await dirname(projectPath), name);
  return join(await videoDir(), name);
}

export function ExportDialog() {
  const open = useStore((s) => s.exportOpen);
  if (!open) return null;
  return <ExportDialogBody />;
}

function ExportDialogBody() {
  const settings = useStore((s) => s.settings);
  const clips = useStore((s) => s.clips);
  const media = useStore((s) => s.media);
  const tracks = useStore((s) => s.tracks);
  const close = () => useStore.setState({ exportOpen: false });

  const [phase, setPhase] = useState<Phase>("setup");
  const [encoders, setEncoders] = useState<EncoderInfo[] | null>(null);
  const [path, setPath] = useState("");
  const [scale, setScale] = useState(1);
  const [fps, setFps] = useState(settings.fps);
  const [codec, setCodec] = useState<Codec>("h264");
  const [quality, setQuality] = useState<Quality>("high");
  const [audio, setAudio] = useState(true);
  const [mode, setModeState] = useState<Mode>(readMode);
  const [hdr, setHdr] = useState(true);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const handle = useRef<ExportHandle | null>(null);

  useEffect(() => {
    defaultPath().then(setPath).catch(() => {});
    listEncoders()
      .then((list) => {
        setEncoders(list);
        if (list.length && !list.some((e) => e.codec === "h264")) setCodec(list[0].codec);
      })
      .catch((e) => {
        setEncoders([]);
        setError(String(e));
      });
  }, []);

  // Escape closes (but never mid-export).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (phase !== "running") close();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [phase]);

  const total = timelineEnd(clips);
  const width = even(settings.width * scale);
  const height = even(settings.height * scale);
  const frames = Math.ceil(total * fps);
  const used = new Set(clips.map((c) => c.mediaId));
  const preparing = media.filter((m) => used.has(m.id) && m.status === "proxying");
  const broken = media.filter((m) => used.has(m.id) && (m.status === "missing" || m.status === "error"));
  const encoder = encoders?.find((e) => e.codec === codec);
  const visibleVideo = new Set(tracks.filter((t) => t.kind === "video" && !t.hidden).map((t) => t.id));
  const hdrSources = media.some((m) => m.probe?.hdr && clips.some((c) => c.mediaId === m.id && visibleVideo.has(c.trackId)));
  const hdrOut = mode === "original" && hdrSources && hdr && codec !== "h264";
  // Only the preview engine needs the preview copies.
  const canExport = total > 0 && !!encoder && !!path && (mode === "original" || preparing.length === 0);

  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* optional */
    }
  };

  // HDR10 needs a 10-bit codec: switch off H.264 when it's turned on.
  useEffect(() => {
    if (mode === "original" && hdrSources && hdr && codec === "h264" && encoders) {
      const alt = encoders.find((e) => e.codec === "hevc") ?? encoders.find((e) => e.codec === "av1");
      if (alt) setCodec(alt.codec);
    }
  }, [mode, hdrSources, hdr, codec, encoders]);

  // What the original-files render can't reproduce exactly.
  const warnings = useMemo(() => {
    if (mode !== "original" || phase !== "setup") return [];
    try {
      return planFor({ path, scale, fps, codec, quality, audio }, hdrOut).warnings;
    } catch (e) {
      return [String(e)];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, phase, clips, tracks, media, scale, fps, audio, hdrOut]);

  const browse = async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const picked = await save({ defaultPath: path || undefined, filters: [{ name: "MP4 video", extensions: ["mp4"] }] });
    if (!picked) return;
    setPath(/\.mp4$/i.test(picked) ? picked : `${picked}.mp4`);
  };

  const run = async () => {
    if (!encoder) return;
    try {
      const { dirname } = await import("@tauri-apps/api/path");
      localStorage.setItem(LAST_DIR_KEY, await dirname(path));
    } catch {
      /* optional */
    }
    setPhase("running");
    setError("");
    const opts = { path, scale, fps, codec, quality, audio };
    const h = mode === "original" ? startHqExport(opts, encoder.encoder, hdrOut, setProgress) : startExport(opts, encoder.encoder, setProgress);
    handle.current = h;
    try {
      setResult(await h.done);
      setPhase("done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "cancelled") {
        setPhase("setup");
        setProgress(null);
      } else {
        setError(msg);
        setPhase("error");
      }
    } finally {
      handle.current = null;
    }
  };

  const reveal = async () => {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    revealItemInDir(result).catch(() => {});
  };

  const pct = progress ? (progress.phase === "audio" ? 0 : (progress.frame / progress.frames) * 100) : 0;

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && phase !== "running" && close()}>
      <div className="modal export-modal" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <h2 id="export-title">Export video</h2>

        {phase === "setup" && (
          <>
            <div className="form-row">
              <span>File</span>
              <div className="path-picker">
                <input type="text" value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} />
                <button type="button" onClick={browse}>
                  Browse…
                </button>
              </div>
            </div>
            <div className="form-row">
              <span>Render</span>
              <div className="segmented mode-seg" role="radiogroup">
                <button
                  role="radio"
                  aria-checked={mode === "preview"}
                  className={mode === "preview" ? "active" : ""}
                  onClick={() => setMode("preview")}
                  {...tip("Renders every frame with the preview engine, so it looks exactly like the preview. SDR only; HDR footage comes from the tone-mapped preview copies.")}
                >
                  Match preview
                </button>
                <button
                  role="radio"
                  aria-checked={mode === "original"}
                  className={mode === "original" ? "active" : ""}
                  onClick={() => setMode("original")}
                  {...tip("ffmpeg renders the edit straight from your original recordings: best quality, can keep HDR, usually faster. A few things are approximated (listed below).")}
                >
                  Original files (HQ)
                </button>
              </div>
            </div>
            <label className="form-row">
              <span>Resolution</span>
              <select value={scale} onChange={(e) => setScale(Number(e.target.value))} {...tip("Output size relative to the project resolution (Project tab)")}>
                {[1, 0.75, 0.5, 0.25].map((s) => (
                  <option key={s} value={s}>
                    {s * 100}% — {even(settings.width * s)}×{even(settings.height * s)}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-row">
              <span>Frame rate</span>
              <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                {[...new Set([settings.fps, 24, 25, 30, 50, 60])].sort((a, b) => a - b).map((f) => (
                  <option key={f} value={f}>
                    {f} fps{f === settings.fps ? " (project)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-row">
              <span>Format</span>
              <select value={codec} disabled={!encoders?.length} onChange={(e) => setCodec(e.target.value as Codec)} {...tip(CODEC_HINT[codec])}>
                {encoders === null && <option>Detecting encoders…</option>}
                {encoders?.map((e) => (
                  <option key={e.codec} value={e.codec}>
                    {CODEC_LABEL[e.codec]} — {ENCODER_LABEL(e)}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-row">
              <span>Quality</span>
              <div className="segmented quality-seg" role="radiogroup">
                {(["high", "balanced", "small"] as Quality[]).map((q) => (
                  <button
                    key={q}
                    role="radio"
                    aria-checked={quality === q}
                    className={quality === q ? "active" : ""}
                    onClick={() => setQuality(q)}
                    {...tip({ high: "Visually lossless — biggest files", balanced: "Good quality, moderate size", small: "Smaller files, some visible compression" }[q])}
                  >
                    {q[0].toUpperCase() + q.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            {mode === "original" && hdrSources && (
              <label className="form-row">
                <span>HDR</span>
                <span className="checkbox-row" {...tip("Keep your HDR recordings in HDR (HDR10: PQ, BT.2020, 10-bit). SDR clips and images are mapped into HDR. Needs HEVC or AV1, and an HDR screen/player to look right.")}>
                  <input type="checkbox" checked={hdr} onChange={(e) => setHdr(e.target.checked)} />
                  HDR10 output (otherwise tone mapped to SDR)
                </span>
              </label>
            )}
            <label className="form-row">
              <span>Audio</span>
              <span className="checkbox-row">
                <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
                Include audio (AAC, mixed from all audible audio tracks)
              </span>
            </label>
            <p className="muted small export-summary">
              {formatTime(total, fps)} · {frames.toLocaleString()} frames · {width}×{height} · {hdrOut ? "HDR10 (PQ, BT.2020)" : "SDR (BT.709)"}
            </p>
            {mode === "original" && warnings.length > 0 && (
              <ul className="export-notes">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {mode === "preview" && preparing.length > 0 && <p className="export-warn">Waiting for {preparing.length} preview cop{preparing.length === 1 ? "y" : "ies"} to finish before exporting.</p>}
            {broken.length > 0 && <p className="export-warn">{broken.length} file(s) are missing or unplayable — their clips will be black/silent.</p>}
            {encoders?.length === 0 && <p className="export-warn">ffmpeg with a usable encoder wasn't found. {error}</p>}
            <div className="modal-actions">
              <button onClick={close}>Cancel</button>
              <button className="primary" disabled={!canExport} onClick={run}>
                Export
              </button>
            </div>
          </>
        )}

        {phase === "running" && (
          <>
            <p className="export-phase">
              {progress?.phase === "audio"
                ? "Mixing audio…"
                : progress?.phase === "finishing"
                  ? "Finishing the file…"
                  : mode === "original"
                    ? "Rendering from the original files…"
                    : "Rendering frames…"}
            </p>
            <div className="export-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
              <div style={{ width: `${pct}%` }} />
            </div>
            {progress?.phase === "video" && (
              <p className="muted small export-stats">
                Frame {progress.frame.toLocaleString()} / {progress.frames.toLocaleString()} · {progress.speed.toFixed(1)} fps ·{" "}
                {(progress.speed / fps).toFixed(2)}× real time · about {fmtDuration(progress.eta)} left
              </p>
            )}
            <p className="muted small">
              {mode === "original"
                ? "ffmpeg is rendering the edit straight from your original files."
                : "The preview shows the frames as they're rendered. Editing is paused until the export finishes."}
            </p>
            <div className="modal-actions">
              <button className="danger" onClick={() => handle.current?.cancel()}>
                Cancel export
              </button>
            </div>
          </>
        )}

        {phase === "done" && (
          <>
            <p>✅ Exported to:</p>
            <p className="export-path">{result}</p>
            <div className="modal-actions">
              <button onClick={reveal}>Show in folder</button>
              <button className="primary" onClick={close}>
                Done
              </button>
            </div>
          </>
        )}

        {phase === "error" && (
          <>
            <p className="export-warn">Export failed: {error}</p>
            <div className="modal-actions">
              <button onClick={close}>Close</button>
              <button className="primary" onClick={() => setPhase("setup")}>
                Back to settings
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
