import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { listEncoders, outputSize, startExport, type Codec, type EncoderInfo, type ExportHandle, type ExportProgress, type ExportSettings, type Quality } from "../lib/export";
import { planFor, startHqExport } from "../lib/exportHq";
import { enqueueExport } from "../lib/exportQueue";
import { clipEnd } from "../lib/timeline";
import { NumberField } from "./NumberField";
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

type Preset = "custom" | "youtube" | "youtube-hdr" | "discord" | "discord50" | "shorts";
const PRESETS: { key: Preset; label: string; hint: string }[] = [
  { key: "custom", label: "Custom", hint: "Your own settings" },
  { key: "youtube", label: "YouTube — best quality", hint: "Full resolution, H.264, high quality" },
  { key: "youtube-hdr", label: "YouTube HDR", hint: "HDR10 (HEVC) from your original HDR recordings" },
  { key: "discord", label: "Discord — under 10 MB", hint: "Bitrate, resolution and frame rate chosen to fit Discord's free upload limit" },
  { key: "discord50", label: "Discord Nitro — under 50 MB", hint: "Fits Nitro's 50 MB upload limit" },
  { key: "shorts", label: "Shorts / TikTok / Reels (9:16)", hint: "Vertical: the centre of the frame, full height" },
];
/** Audio bitrate for size-limited exports (kbit/s). */
const SIZE_AUDIO_KBPS = 96;

type RangeMode = "all" | "selection" | "markers" | "custom";

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
  const [preset, setPreset] = useState<Preset>("custom");
  /** Target file size (MB) — picks the bitrate. */
  const [sizeLimit, setSizeLimit] = useState<number | null>(null);
  const [vertical, setVertical] = useState(false);
  const markers = useStore((s) => s.markers);
  const selectionSpan = useStore((s) => {
    const ids = s.clipSelection.length ? s.clipSelection : s.selection?.kind === "clip" ? [s.selection.clipId] : [];
    const sel = s.clips.filter((c) => ids.includes(c.id));
    return sel.length ? `${Math.min(...sel.map((c) => c.start))}|${Math.max(...sel.map(clipEnd))}` : "";
  });
  const [rangeMode, setRangeMode] = useState<RangeMode>(selectionSpan && useStore.getState().clipSelection.length > 0 ? "selection" : "all");
  const [customRange, setCustomRange] = useState<[number, number]>(() => [0, timelineEnd(useStore.getState().clips)]);
  const [markerRange, setMarkerRange] = useState<[number, number]>([0, 1]);
  const [queued, setQueued] = useState(false);
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

  const timelineTotal = timelineEnd(clips);
  const range = useMemo((): { start: number; end: number } => {
    if (rangeMode === "selection" && selectionSpan) {
      const [a, b] = selectionSpan.split("|").map(Number);
      return { start: a, end: b };
    }
    if (rangeMode === "markers" && markers.length >= 2) {
      const a = markers[Math.min(markerRange[0], markers.length - 1)]?.t ?? 0;
      const b = markers[Math.min(markerRange[1], markers.length - 1)]?.t ?? timelineTotal;
      return { start: Math.min(a, b), end: Math.max(a, b) };
    }
    if (rangeMode === "custom") return { start: Math.max(0, customRange[0]), end: Math.min(timelineTotal, customRange[1]) };
    return { start: 0, end: timelineTotal };
  }, [rangeMode, selectionSpan, markers, markerRange, customRange, timelineTotal]);
  const total = Math.max(0, range.end - range.start);
  // Size-limited presets: average bitrate that fits the limit (a little headroom for the container).
  const bitrateKbps = sizeLimit && total > 0 ? Math.max(100, Math.floor((sizeLimit * 8 * 1024 * 1024 * 0.94) / total / 1000) - SIZE_AUDIO_KBPS) : null;
  const { width, height } = outputSize(settings.width, settings.height, { scale, vertical });
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
  const opts: ExportSettings = {
    path,
    scale,
    fps,
    codec,
    quality,
    audio,
    range,
    vertical,
    bitrateKbps: bitrateKbps ?? undefined,
    audioKbps: sizeLimit ? SIZE_AUDIO_KBPS : undefined,
  };

  // Size-limited exports: lower resolution and frame rate as the bitrate gets tight.
  useEffect(() => {
    if (!bitrateKbps) return;
    const targetH = bitrateKbps < 1200 ? 480 : bitrateKbps < 3500 ? 720 : bitrateKbps < 7000 ? 1080 : settings.height;
    setScale(Math.min(1, targetH / settings.height));
    setFps(bitrateKbps < 2500 ? Math.min(30, settings.fps) : settings.fps);
  }, [bitrateKbps, settings.height, settings.fps]);

  const applyPreset = (p: Preset) => {
    setPreset(p);
    if (p === "custom") return;
    const has = (c: Codec) => encoders?.some((e) => e.codec === c);
    setSizeLimit(p === "discord" ? 10 : p === "discord50" ? 50 : null);
    setVertical(p === "shorts");
    setQuality("high");
    if (p === "youtube-hdr") {
      setMode("original");
      setHdr(true);
      setCodec(has("hevc") ? "hevc" : "av1");
      setScale(1);
      setFps(settings.fps);
      return;
    }
    setHdr(false);
    if (has("h264")) setCodec("h264");
    if (p === "youtube" || p === "shorts") {
      setScale(p === "shorts" ? Math.min(1, 1920 / settings.height) : 1);
      setFps(settings.fps);
    }
  };

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
      return planFor(opts, hdrOut).warnings;
    } catch (e) {
      return [String(e)];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, phase, clips, tracks, media, scale, fps, audio, hdrOut, range, vertical]);

  const browse = async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const picked = await save({ defaultPath: path || undefined, filters: [{ name: "MP4 video", extensions: ["mp4"] }] });
    if (!picked) return;
    setPath(/\.mp4$/i.test(picked) ? picked : `${picked}.mp4`);
  };

  const rememberDir = async () => {
    try {
      const { dirname } = await import("@tauri-apps/api/path");
      localStorage.setItem(LAST_DIR_KEY, await dirname(path));
    } catch {
      /* optional */
    }
  };

  /** Original-files exports can render in the background while you keep editing. */
  const addToQueue = async () => {
    if (!encoder) return;
    await rememberDir();
    setQueued(true);
    try {
      await enqueueExport(opts, encoder.encoder, hdrOut);
      close();
    } catch (e) {
      setQueued(false);
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  const run = async () => {
    if (!encoder) return;
    await rememberDir();
    setPhase("running");
    setError("");
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
            <label className="form-row">
              <span>Preset</span>
              <select value={preset} onChange={(e) => applyPreset(e.target.value as Preset)} {...tip(PRESETS.find((p) => p.key === preset)!.hint)}>
                {PRESETS.filter((p) => p.key !== "youtube-hdr" || hdrSources).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-row">
              <span>Range</span>
              <div className="range-picker">
                <select value={rangeMode} onChange={(e) => setRangeMode(e.target.value as RangeMode)} {...tip("Which part of the timeline to export")}>
                  <option value="all">Whole timeline</option>
                  <option value="selection" disabled={!selectionSpan}>
                    Selected clips
                  </option>
                  <option value="markers" disabled={markers.length < 2}>
                    Between markers
                  </option>
                  <option value="custom">Custom…</option>
                </select>
                {rangeMode === "markers" && markers.length >= 2 && (
                  <>
                    <select value={markerRange[0]} onChange={(e) => setMarkerRange([Number(e.target.value), markerRange[1]])} aria-label="From marker">
                      {markers.map((m, i) => (
                        <option key={m.id} value={i}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    →
                    <select value={markerRange[1]} onChange={(e) => setMarkerRange([markerRange[0], Number(e.target.value)])} aria-label="To marker">
                      {markers.map((m, i) => (
                        <option key={m.id} value={i}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                {rangeMode === "custom" && (
                  <>
                    <NumberField value={customRange[0]} min={0} max={timelineTotal} step={0.1} precision={2} unit="s" onChange={(v) => setCustomRange([v, customRange[1]])} aria-label="Start" />
                    →
                    <NumberField value={customRange[1]} min={0} max={timelineTotal} step={0.1} precision={2} unit="s" onChange={(v) => setCustomRange([customRange[0], v])} aria-label="End" />
                  </>
                )}
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
                {[...new Set([1, 0.75, 0.5, 0.25, scale])].sort((a, b) => b - a).map((s) => {
                  const o = outputSize(settings.width, settings.height, { scale: s, vertical });
                  return (
                    <option key={s} value={s}>
                      {Math.round(s * 100)}% — {o.width}×{o.height}
                    </option>
                  );
                })}
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
              {sizeLimit ? (
                <span className="muted small" {...tip("Set by the size limit: the bitrate is chosen so the file stays under it. Choose another preset (or Custom) for quality-based encoding.")}>
                  Fits {sizeLimit} MB: {bitrateKbps?.toLocaleString()} kbit/s video + {SIZE_AUDIO_KBPS} kbit/s audio
                  {bitrateKbps !== null && bitrateKbps < 400 && " — very low; consider a shorter range"}
                </span>
              ) : (
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
              )}
            </div>
            <label className="form-row">
              <span>Framing</span>
              <span className="checkbox-row" {...tip("Vertical 9:16 video for Shorts, TikTok and Reels: the centre of the frame at full height. Move clips (Position X) to choose what's in view.")}>
                <input type="checkbox" checked={vertical} onChange={(e) => setVertical(e.target.checked)} />
                Vertical 9:16 (centre of the frame)
              </span>
            </label>
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
              {range.start > 0 || range.end < timelineTotal ? `${formatTime(range.start, fps)}–${formatTime(range.end, fps)} · ` : ""}
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
              {mode === "original" && (
                <button
                  disabled={!canExport || queued}
                  onClick={addToQueue}
                  {...tip("Render in the background and keep editing. The export uses the timeline as it is now; later edits aren't included. Progress is under ⏳ in the toolbar.")}
                >
                  Add to queue
                </button>
              )}
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
