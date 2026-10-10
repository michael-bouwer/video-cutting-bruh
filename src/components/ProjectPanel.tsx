import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { regenerateProxies } from "../lib/media";
import { saveProject } from "../lib/project";
import { projectName } from "../lib/dialog";
import { formatTime, timelineEnd } from "../lib/timeline";
import { tip } from "./Tooltip";
import type { ProxyMode, ProxyQuality } from "../types";

export const RESOLUTIONS = [
  { label: "720p", group: "Landscape 16:9", w: 1280, h: 720 },
  { label: "1080p", group: "Landscape 16:9", w: 1920, h: 1080 },
  { label: "1440p", group: "Landscape 16:9", w: 2560, h: 1440 },
  { label: "4K UHD", group: "Landscape 16:9", w: 3840, h: 2160 },
  { label: "Ultrawide 1080p", group: "Landscape 21:9", w: 2560, h: 1080 },
  { label: "Ultrawide 1440p", group: "Landscape 21:9", w: 3440, h: 1440 },
  { label: "Vertical 1080p", group: "Vertical 9:16 (Shorts, TikTok, Reels)", w: 1080, h: 1920 },
  { label: "Vertical 720p", group: "Vertical 9:16 (Shorts, TikTok, Reels)", w: 720, h: 1280 },
  { label: "Square 1080", group: "Square & portrait", w: 1080, h: 1080 },
  { label: "Portrait 4:5", group: "Square & portrait", w: 1080, h: 1350 },
];

export const shortResolution = (w: number, h: number) =>
  RESOLUTIONS.find((r) => r.w === w && r.h === h)?.label ?? `${w}×${h}`;

const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120];

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const aspect = (w: number, h: number) => {
  const g = gcd(w, h) || 1;
  const [a, b] = [w / g, h / g];
  return a > 50 ? `${(w / h).toFixed(2)}:1` : `${a}:${b}`;
};
/** Video encoders need even dimensions. */
const even = (v: number) => Math.max(16, Math.min(8192, Math.round(v / 2) * 2));

/** Project-wide settings, shown as a tab in the right-hand panel. */
export function ProjectPanel() {
  return (
    <div className="project-panel">
      <ProjectInfo />
      <FormatSection />
      <ProxySection />
    </div>
  );
}

function ProjectInfo() {
  const projectPath = useStore((s) => s.projectPath);
  const dirty = useStore((s) => s.dirty);
  const clips = useStore((s) => s.clips);
  const mediaCount = useStore((s) => s.media.length);
  const fps = useStore((s) => s.settings.fps);
  const total = timelineEnd(clips);

  const reveal = async () => {
    if (!projectPath) return;
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    revealItemInDir(projectPath).catch(() => {});
  };

  return (
    <section className="settings-section">
      <div className="section-title">Project</div>
      <div className="project-name">
        {projectName(projectPath)}
        {dirty && <span className="muted small" {...tip("Unsaved changes")}> • edited</span>}
      </div>
      <div className="storage-path">{projectPath ?? "Not saved yet — preview copies are kept in a temporary folder until you save."}</div>
      <div className="button-row">
        {projectPath ? (
          <button onClick={reveal} {...tip("Show the project file in your file manager")}>
            Show in folder
          </button>
        ) : (
          <button className="primary" onClick={() => saveProject()} {...tip("Choose where to save the project. Its preview copies move there too.")}>
            Save project…
          </button>
        )}
      </div>
      <dl className="stats">
        <dt>Length</dt>
        <dd>{formatTime(total, fps)}</dd>
        <dt>Clips</dt>
        <dd>{clips.length}</dd>
        <dt>Media</dt>
        <dd>{mediaCount}</dd>
      </dl>
    </section>
  );
}

function FormatSection() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const media = useStore((s) => s.media);
  const { width, height } = settings;
  const preset = RESOLUTIONS.find((r) => r.w === width && r.h === height);
  const groups = [...new Set(RESOLUTIONS.map((r) => r.group))];
  const sized = media.filter((m) => (m.probe?.width ?? m.width) > 0);

  // Local drafts so typing "19" on the way to "1920" doesn't resize the canvas each keystroke.
  const [w, setW] = useState(String(width));
  const [h, setH] = useState(String(height));
  useEffect(() => setW(String(width)), [width]);
  useEffect(() => setH(String(height)), [height]);
  const commit = () => {
    const nw = even(Number(w) || width);
    const nh = even(Number(h) || height);
    setW(String(nw));
    setH(String(nh));
    if (nw !== width || nh !== height) setSettings({ width: nw, height: nh });
  };

  return (
    <section className="settings-section">
      <div className="section-title">Video format</div>
      <label className="field">
        <span>Resolution</span>
        <select
          value={preset ? `${preset.w}x${preset.h}` : "custom"}
          onChange={(e) => {
            const r = RESOLUTIONS.find((x) => `${x.w}x${x.h}` === e.target.value);
            if (r) setSettings({ width: r.w, height: r.h });
          }}
          {...tip("Size of the output frame. Clips are fitted inside it; use Scale and Position in the inspector to reframe them.")}
        >
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {RESOLUTIONS.filter((r) => r.group === g).map((r) => (
                <option key={r.label} value={`${r.w}x${r.h}`}>
                  {r.label} — {r.w}×{r.h}
                </option>
              ))}
            </optgroup>
          ))}
          {!preset && <option value="custom">Custom — {width}×{height}</option>}
        </select>
      </label>
      <div className="field size-field">
        <span>Size</span>
        <div className="size-inputs">
          <input
            type="number"
            min={16}
            max={8192}
            step={2}
            value={w}
            onChange={(e) => setW(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && commit()}
            aria-label="Width"
            {...tip("Width in pixels (rounded to an even number)")}
          />
          <span className="muted">×</span>
          <input
            type="number"
            min={16}
            max={8192}
            step={2}
            value={h}
            onChange={(e) => setH(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && commit()}
            aria-label="Height"
            {...tip("Height in pixels (rounded to an even number)")}
          />
          <button
            className="icon-btn"
            onClick={() => setSettings({ width: height, height: width })}
            {...tip("Swap width and height (landscape ⇄ portrait)", { label: "Swap orientation" })}
          >
            ⇄
          </button>
        </div>
      </div>
      <div className="field">
        <span>Aspect</span>
        <span className="muted">{aspect(width, height)}</span>
      </div>
      {sized.length > 0 && (
        <label className="field">
          <span>Match clip</span>
          <select
            value=""
            onChange={(e) => {
              const m = sized.find((x) => x.id === e.target.value);
              if (m) setSettings({ width: even(m.probe?.width ?? m.width), height: even(m.probe?.height ?? m.height) });
            }}
            {...tip("Set the project resolution to a file's original size")}
          >
            <option value="">Use a file's size…</option>
            {sized.map((m) => (
              <option key={m.id} value={m.id}>
                {m.probe?.width ?? m.width}×{m.probe?.height ?? m.height} — {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>Frame rate</span>
        <select
          value={settings.fps}
          onChange={(e) => setSettings({ fps: Number(e.target.value) })}
          {...tip("Used for timecode, frame stepping (← →) and snapping keyframes to frames. Preview copies are limited to 60 fps.")}
        >
          {(FRAME_RATES.includes(settings.fps) ? FRAME_RATES : [...FRAME_RATES, settings.fps].sort((a, b) => a - b)).map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
      </label>
      <label className="field checkbox">
        <span>Allow HDR</span>
        <input
          type="checkbox"
          checked={settings.allowHdr}
          onChange={(e) => setSettings({ allowHdr: e.target.checked })}
          {...tip("Off: HDR videos (HDR10, HLG, Dolby Vision) are rejected on import. On: they're accepted and shown tone-mapped to normal range in the preview.")}
        />
      </label>
    </section>
  );
}

function ProxySection() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const ffmpeg = useStore((s) => s.ffmpeg);

  return (
    <section className="settings-section">
      <div className="section-title">Preview proxies</div>
      {ffmpeg?.available ? (
        <>
          <label className="field">
            <span>Mode</span>
            <select
              value={settings.proxyMode}
              onChange={(e) => setSettings({ proxyMode: e.target.value as ProxyMode })}
              {...tip("Auto: convert only files the preview can't play, plus HDR (for correct colors). Always: convert everything for smoother scrubbing of heavy footage. Off: always play originals.")}
            >
              <option value="auto">Auto (unplayable + HDR)</option>
              <option value="always">Always</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="field">
            <span>Quality</span>
            <select
              value={settings.proxyQuality}
              onChange={(e) => {
                setSettings({ proxyQuality: e.target.value as ProxyQuality });
                regenerateProxies();
              }}
              {...tip("Resolution of the preview copies. Full matches the source (sharpest); lower is faster to create and lighter to play. Changing it re-creates existing copies in the background — the preview keeps working meanwhile.")}
            >
              <option value="full">Full resolution</option>
              <option value="1080">1080p</option>
              <option value="720">720p (fastest)</option>
            </select>
          </label>
          <p className="muted small">
            H.264 copies for smooth previews; export uses the originals.
            <br />
            {ffmpeg.caps && (
              <>
                {ffmpeg.caps.gpuFilters ? "GPU tone mapping (Vulkan)" : "CPU tone mapping"} ·{" "}
                {ffmpeg.caps.encoder === "libx264" ? "CPU encoder" : `hardware encoder (${ffmpeg.caps.encoder.replace("h264_", "")})`}
                <br />
              </>
            )}
            {ffmpeg.version}
            {!ffmpeg.canTonemap && " — HDR proxies won't be tone-mapped (no Vulkan or zscale)."}
          </p>
          <StorageSection />
        </>
      ) : (
        <p className="muted small">
          {ffmpeg
            ? "ffmpeg not found. Install it to preview formats the system webview can't play (e.g. HEVC on Windows)."
            : "Available in the desktop app with ffmpeg installed."}
        </p>
      )}
    </section>
  );
}

interface DirInfo {
  dir: string;
  files: number;
  bytes: number;
}

export const formatBytes = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : b > 0 ? `${(b / 1e3).toFixed(0)} KB` : "empty";

/** Where preview proxies live, how big the caches are, and cleanup actions. */
function StorageSection() {
  const projectPath = useStore((s) => s.projectPath);
  const media = useStore((s) => s.media);
  const [info, setInfo] = useState<{ project: DirInfo | null; temporary: DirInfo } | null>(null);
  const [busy, setBusy] = useState(false);
  const inUse = media.map((m) => m.proxy?.path).filter((p): p is string => !!p);
  const readyCount = media.filter((m) => m.proxy?.status === "ready").length;

  const refresh = () => {
    if (!isTauri()) return;
    invoke<{ project: DirInfo | null; temporary: DirInfo }>("proxy_cache_info", { projectPath })
      .then(setInfo)
      .catch(() => setInfo(null));
  };
  useEffect(refresh, [projectPath, media.length, readyCount]);

  const reveal = async (dir: string) => {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    revealItemInDir(dir).catch(() => useStore.getState().notify("info", "The folder will be created when the first preview copy is made."));
  };

  const clean = async (temporary: boolean) => {
    setBusy(true);
    try {
      const r = await invoke<{ removed: number; bytes: number }>("clean_proxy_cache", { projectPath, temporary, keep: inUse });
      useStore.getState().notify("info", r.removed ? `Freed ${formatBytes(r.bytes)} (${r.removed} file${r.removed === 1 ? "" : "s"})` : "Nothing to remove");
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (!info) return null;
  const current = info.project ?? info.temporary;
  return (
    <>
      <div className="subsection-title">Storage</div>
      <div className="storage-row">
        <span {...tip(projectPath ? "Preview copies are stored in the project folder, next to the project file." : "This project isn't saved yet, so its preview copies are in a temporary app folder. They move into the project folder when you save.")}>
          {projectPath ? "Project cache" : "Temporary cache"} · {formatBytes(current.bytes)}
        </span>
        <span className="button-row">
          <button onClick={() => reveal(current.dir)} {...tip("Open this folder in your file manager")}>
            Show
          </button>
          <button disabled={busy || current.files === 0} onClick={() => clean(!projectPath)} {...tip("Delete preview copies that no media in this project uses (e.g. old quality settings or removed videos). Copies in use are kept.")}>
            Remove unused
          </button>
        </span>
      </div>
      <div className="storage-path">{current.dir}</div>
      {projectPath && info.temporary.files > 0 && (
        <div className="storage-row">
          <span {...tip(`Copies made for unsaved projects, in ${info.temporary.dir}. Safe to clear; they're re-created when needed.`)}>
            Temporary cache · {formatBytes(info.temporary.bytes)}
          </span>
          <button disabled={busy} onClick={() => clean(true)} {...tip("Delete everything in the temporary cache that this project isn't using")}>
            Clear
          </button>
        </div>
      )}
    </>
  );
}
