import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { hdrLabel, openImportDialog, relinkMedia, removeMediaItem } from "../lib/media";
import { startMediaDrag } from "../lib/mediaDrag";
import { ask } from "../lib/dialog";
import { formatTime } from "../lib/timeline";
import { formatBytes } from "./ProjectPanel";
import { tip } from "./Tooltip";
import type { MediaItem } from "../types";

const CODEC_NAMES: [RegExp, string][] = [
  [/^(dvh1|dvhe)$/i, "Dolby Vision (HEVC)"],
  [/^(hvc1|hev1|hevc)$/i, "HEVC / H.265"],
  [/^(avc1|avc3|avc|h264)$/i, "H.264 / AVC"],
  [/^(av01|av1)$/i, "AV1"],
  [/^(vp09|vp9)$/i, "VP9"],
  [/^(vp08|vp8)$/i, "VP8"],
  [/^ap(4h|4x|cn|ch|cs|co)$/i, "Apple ProRes"],
];
const codecName = (c: string) => CODEC_NAMES.find(([re]) => re.test(c))?.[1] ?? c;
const extOf = (p: string) => p.split(/[\\/]/).pop()?.split(".").pop()?.toUpperCase() ?? "";

// ---- Categories -----------------------------------------------------------------

type CategoryKey = "attention" | "hdr" | "video" | "image" | "audio";

/** First match wins, so e.g. a missing HDR file is listed under "Needs attention". */
const CATEGORIES: { key: CategoryKey; label: string; icon: string; hint: string; test: (m: MediaItem) => boolean }[] = [
  {
    key: "attention",
    label: "Needs attention",
    icon: "⚠",
    hint: "Files that are missing or can't be played",
    test: (m) => m.status === "missing" || m.status === "error",
  },
  {
    key: "hdr",
    label: "HDR video",
    icon: "◆",
    hint: "Videos captured in HDR10, HLG or Dolby Vision",
    test: (m) => m.kind === "video" && !!m.probe?.hdr,
  },
  { key: "video", label: "Video", icon: "▶", hint: "Standard (SDR) videos", test: (m) => m.kind === "video" },
  { key: "image", label: "Images", icon: "▣", hint: "Still images — they become 5 s clips you can trim to any length", test: (m) => m.kind === "image" },
  { key: "audio", label: "Audio", icon: "♪", hint: "Music and sound files — they go on audio tracks", test: (m) => m.kind === "audio" },
];
const categoryOf = (m: MediaItem) => CATEGORIES.find((c) => c.test(m))!.key;

// ---- View preferences (per device) -------------------------------------------------

type ViewMode = "grid" | "list" | "details";
type SortKey = "added" | "name" | "duration" | "size";
type Filter = "all" | CategoryKey;

interface BinPrefs {
  view: ViewMode;
  sort: SortKey;
  collapsed: CategoryKey[];
}

const PREFS_KEY = "vcb.mediaBin";
function loadPrefs(): BinPrefs {
  const defaults: BinPrefs = { view: "grid", sort: "added", collapsed: [] };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return defaults;
  }
}

const VIEWS: { key: ViewMode; icon: string; label: string; hint: string }[] = [
  { key: "grid", icon: "▦", label: "Thumbnails", hint: "Large thumbnails" },
  { key: "list", icon: "☰", label: "List", hint: "Compact list with key details" },
  { key: "details", icon: "▤", label: "Details", hint: "Table with all metadata: length, resolution, codec, file size…" },
];

const SORTS: { key: SortKey; label: string; cmp: (a: MediaItem, b: MediaItem) => number }[] = [
  { key: "added", label: "Date added", cmp: (a, b) => a.addedAt - b.addedAt },
  { key: "name", label: "Name", cmp: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) },
  { key: "duration", label: "Length", cmp: (a, b) => b.duration - a.duration },
  { key: "size", label: "File size", cmp: (a, b) => (b.probe?.size ?? 0) - (a.probe?.size ?? 0) },
];

// ---- Bin ------------------------------------------------------------------------------

export function MediaBin() {
  const media = useStore((s) => s.media);
  const [prefs, setPrefs] = useState<BinPrefs>(loadPrefs);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* optional */
    }
  }, [prefs]);

  const counts = useMemo(() => {
    const c: Record<CategoryKey, number> = { attention: 0, hdr: 0, video: 0, image: 0, audio: 0 };
    media.forEach((m) => c[categoryOf(m)]++);
    return c;
  }, [media]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const cmp = SORTS.find((s) => s.key === prefs.sort)!.cmp;
    return media
      .filter((m) => (filter === "all" || categoryOf(m) === filter) && (!q || m.name.toLowerCase().includes(q)))
      .sort(cmp);
  }, [media, filter, query, prefs.sort]);

  const groups = CATEGORIES.map((c) => ({ ...c, items: visible.filter((m) => categoryOf(m) === c.key) })).filter(
    (g) => g.items.length > 0,
  );

  const toggleGroup = (key: CategoryKey) =>
    setPrefs((p) => ({
      ...p,
      collapsed: p.collapsed.includes(key) ? p.collapsed.filter((k) => k !== key) : [...p.collapsed, key],
    }));

  return (
    <aside className="panel media-bin" data-drop-zone="bin">
      <div className="bin-header">
        <span className="panel-title">
          Media <span className="muted">({media.length})</span>
        </span>
        <div className="segmented" role="radiogroup" aria-label="View">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              role="radio"
              aria-checked={prefs.view === v.key}
              className={prefs.view === v.key ? "active" : ""}
              onClick={() => setPrefs((p) => ({ ...p, view: v.key }))}
              {...tip(v.hint, { title: v.label, label: `${v.label} view` })}
            >
              {v.icon}
            </button>
          ))}
        </div>
      </div>

      {media.length === 0 ? (
        <button className="empty-drop" onClick={openImportDialog}>
          <strong>Drop videos, images or audio here</strong>
          <span>or click to browse</span>
          <span className="muted small">mp4 · mov · mkv · png · jpg · mp3 · wav · m4a…</span>
        </button>
      ) : (
        <>
          <div className="bin-controls">
            <input
              type="search"
              className="bin-search"
              placeholder="Search media…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              {...tip("Filter by file name")}
            />
            <select
              value={prefs.sort}
              onChange={(e) => setPrefs((p) => ({ ...p, sort: e.target.value as SortKey }))}
              {...tip("Sort order within each category")}
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="chips" role="radiogroup" aria-label="Category">
            <Chip active={filter === "all"} onClick={() => setFilter("all")} hint="Show every category">
              All <span className="chip-count">{media.length}</span>
            </Chip>
            {CATEGORIES.filter((c) => counts[c.key] > 0).map((c) => (
              <Chip key={c.key} active={filter === c.key} onClick={() => setFilter(filter === c.key ? "all" : c.key)} hint={c.hint} warn={c.key === "attention"}>
                {c.label} <span className="chip-count">{counts[c.key]}</span>
              </Chip>
            ))}
          </div>

          {visible.length === 0 ? (
            <p className="muted small bin-empty">No media matches “{query}”.</p>
          ) : prefs.view === "details" ? (
            // One table for all groups so columns line up and there's a single horizontal scroll.
            <div className="details-scroll">
              <table className="details-table">
                <DetailsHead />
                {groups.map((g) => {
                  const collapsed = prefs.collapsed.includes(g.key) && filter === "all";
                  return (
                    <tbody key={g.key} className={`bin-group ${g.key}`}>
                      {filter === "all" && (
                        <tr className="group-row">
                          <td colSpan={8}>
                            <button className="group-header" aria-expanded={!collapsed} onClick={() => toggleGroup(g.key)} {...tip(g.hint)}>
                              <span className="caret">{collapsed ? "▸" : "▾"}</span>
                              <span className="group-icon">{g.icon}</span>
                              {g.label}
                              <span className="muted small">{g.items.length}</span>
                            </button>
                          </td>
                        </tr>
                      )}
                      {!collapsed && g.items.map((m) => <DetailsRow key={m.id} item={m} />)}
                    </tbody>
                  );
                })}
              </table>
            </div>
          ) : (
            groups.map((g) => {
              const collapsed = prefs.collapsed.includes(g.key) && filter === "all";
              return (
                <section key={g.key} className={`bin-group ${g.key}`}>
                  {filter === "all" && (
                    <button className="group-header" aria-expanded={!collapsed} onClick={() => toggleGroup(g.key)} {...tip(g.hint)}>
                      <span className="caret">{collapsed ? "▸" : "▾"}</span>
                      <span className="group-icon">{g.icon}</span>
                      {g.label}
                      <span className="muted small">{g.items.length}</span>
                    </button>
                  )}
                  {!collapsed && <ItemsView view={prefs.view as Exclude<ViewMode, "details">} items={g.items} />}
                </section>
              );
            })
          )}
          <p className="muted small bin-hint">Drag items onto the timeline, or double-click to add them at the end.</p>
        </>
      )}
    </aside>
  );
}

function Chip({ active, onClick, hint, warn, children }: { active: boolean; onClick: () => void; hint: string; warn?: boolean; children: ReactNode }) {
  return (
    <button role="radio" aria-checked={active} className={`chip ${active ? "active" : ""} ${warn ? "warn" : ""}`} onClick={onClick} {...tip(hint)}>
      {children}
    </button>
  );
}

function DetailsHead() {
  return (
    <thead>
      <tr>
        <th className="name-col">Name</th>
        <th>Length</th>
        <th>Resolution</th>
        <th>Format</th>
        <th>Color</th>
        <th {...tip("File size on disk")}>Size</th>
        <th {...tip("Number of clips on the timeline using this file")}>Used</th>
        <th aria-label="Actions" />
      </tr>
    </thead>
  );
}

function ItemsView({ view, items }: { view: Exclude<ViewMode, "details">; items: MediaItem[] }) {
  return (
    <ul className={view === "grid" ? "media-grid" : "media-list"}>
      {items.map((m) => (view === "grid" ? <GridCard key={m.id} item={m} /> : <ListRow key={m.id} item={m} />))}
    </ul>
  );
}

// ---- Shared item logic -----------------------------------------------------------------

function useItem(item: MediaItem) {
  const appendClip = useStore((s) => s.appendClip);
  const usedBy = useStore((s) => s.clips.filter((c) => c.mediaId === item.id).length);
  const placeable = (item.status === "ready" || item.status === "proxying") && item.duration > 0;

  const remove = async () => {
    if (usedBy > 0) {
      const choice = await ask(
        "Remove media?",
        `"${item.name}" is used by ${usedBy} clip${usedBy === 1 ? "" : "s"} on the timeline. Removing it also removes ${usedBy === 1 ? "that clip" : "those clips"}.`,
        [
          { id: "cancel", label: "Cancel" },
          { id: "remove", label: "Remove", kind: "danger" },
        ],
        "cancel",
      );
      if (choice !== "remove") return;
    }
    removeMediaItem(item.id);
  };

  // Drag to the timeline / double-click to append.
  const interact = {
    onPointerDown: (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      startMediaDrag(e, item.id);
    },
    onDoubleClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      if (placeable) appendClip(item.id);
    },
  };

  const itemTip = tip(
    item.error
      ? `${item.error}\n\n${item.path}`
      : `${item.path}\n\n${placeable ? "Drag onto the timeline, or double-click to add it at the end." : "Preparing…"}`,
    { title: item.name },
  );

  return { usedBy, placeable, remove, interact, itemTip, appendClip };
}

function Actions({ item, placeable, remove, appendClip }: { item: MediaItem; placeable: boolean; remove: () => void; appendClip: (id: string) => void }) {
  return (
    <div className="row-actions">
      {item.status === "missing" ? (
        <button onClick={() => relinkMedia(item.id)} {...tip("Locate this file on disk. Clips that use it are kept.", { title: "Relink", label: "Relink file" })}>
          ⤷
        </button>
      ) : (
        <button disabled={!placeable} onClick={() => appendClip(item.id)} {...tip("Add to the end of the timeline (or drag it to a specific spot)", { label: "Add to timeline" })}>
          +
        </button>
      )}
      <button onClick={remove} {...tip("Remove from the project, along with any clips that use it. The file on disk isn't touched.", { label: "Remove from project" })}>
        ×
      </button>
    </div>
  );
}

function Thumb({ item }: { item: MediaItem }) {
  if (item.status === "ready" && item.kind === "audio") return <span className="thumb-audio">♪</span>;
  if (item.status === "ready") {
    return item.kind === "image" ? (
      <img src={item.src} alt="" loading="lazy" draggable={false} />
    ) : (
      <video src={`${item.src}#t=0.1`} preload="metadata" muted />
    );
  }
  return (
    <span className="thumb-status">
      {item.status === "proxying" ? `${Math.round((item.proxy?.progress ?? 0) * 100)}%` : item.status === "loading" ? "…" : item.status === "missing" ? "?" : "!"}
    </span>
  );
}

function ProxyProgress({ item }: { item: MediaItem }) {
  const proxy = item.proxy;
  if (proxy?.status !== "generating") return null;
  return (
    <div
      className="proxy-progress"
      {...tip("Creating an H.264 copy so the preview can play this file. You can already place and edit its clips; export will use the original.", { title: "Optimizing for preview" })}
    >
      <div style={{ width: `${(proxy.progress * 100).toFixed(1)}%` }} />
      <span className="muted small">{item.status === "ready" ? "Updating preview quality…" : "Optimizing for preview…"}</span>
    </div>
  );
}

function Badges({ item, usedBy, compact }: { item: MediaItem; usedBy: number; compact?: boolean }) {
  const p = item.probe;
  const proxy = item.proxy;
  return (
    <>
      {p?.hdr && (
        <span className="badge hdr" {...tip("Captured in HDR. The preview shows it tone-mapped to normal (SDR) range.", { title: hdrLabel(p.hdr) })}>
          {compact ? "HDR" : hdrLabel(p.hdr)}
        </span>
      )}
      {!compact && p?.dolbyVision && p.hdr !== "DolbyVision" && (
        <span className="badge hdr" {...tip("Also carries Dolby Vision metadata")}>DV</span>
      )}
      {!compact && p?.bitDepth && p.bitDepth > 8 && (
        <span className="badge" {...tip(`${p.bitDepth} bits per color channel (normal video is 8-bit) — smoother gradients, typical for HDR`)}>
          {p.bitDepth}-bit
        </span>
      )}
      {!compact && item.kind === "video" && p?.videoCodec && (
        <span className="badge" {...tip(`Video codec: ${codecName(p.videoCodec)}`)}>
          {p.videoCodec}
        </span>
      )}
      {!compact && proxy?.height && (proxy.status === "ready" || proxy.status === "generating") && (
        <span
          className="badge proxy"
          {...tip(
            `The preview plays a ${proxy.height}p H.264 copy made with ffmpeg, because this file can't play directly (or is HDR). Export will use the original file.${proxy.method && proxy.method !== "cached" ? `\n\nMade with: ${proxy.method}` : ""}`,
            { title: "Preview proxy" },
          )}
        >
          Proxy {proxy.height}p
        </span>
      )}
      {item.status === "error" && (
        <span className="badge error" {...tip(item.error ?? "This file can't be played", { title: "Unsupported" })}>
          Unsupported
        </span>
      )}
      {item.status === "missing" && (
        <span className="badge error" {...tip("The file was moved, renamed or deleted since the project was saved. Use ⤷ to locate it — its clips are kept.", { title: "Missing file" })}>
          Missing
        </span>
      )}
      {usedBy > 0 && (
        <span className="badge used" {...tip(`Used by ${usedBy} clip${usedBy === 1 ? "" : "s"} on the timeline`)}>
          ×{usedBy}
        </span>
      )}
    </>
  );
}

const resolutionOf = (m: MediaItem) => {
  const w = m.probe?.width || m.width;
  const h = m.probe?.height || m.height;
  return w && h ? `${w}×${h}` : "—";
};
const lengthOf = (m: MediaItem, fps: number) =>
  m.kind === "image" ? "Still" : m.duration > 0 ? formatTime(m.duration, fps) : "—";

// ---- Views ---------------------------------------------------------------------------------

function GridCard({ item }: { item: MediaItem }) {
  const fps = useStore((s) => s.settings.fps);
  const dragging = useStore((s) => s.mediaDrag?.mediaId === item.id);
  const { usedBy, placeable, remove, interact, itemTip, appendClip } = useItem(item);
  return (
    <li className={`media-card ${item.status} ${dragging ? "dragging" : ""} ${placeable ? "draggable" : ""}`} {...interact} {...itemTip}>
      <div className="card-thumb">
        <Thumb item={item} />
        <span className="card-length">{lengthOf(item, fps)}</span>
        <div className="card-badges">
          <Badges item={item} usedBy={usedBy} compact />
        </div>
        <Actions item={item} placeable={placeable} remove={remove} appendClip={appendClip} />
      </div>
      <div className="card-name">{item.name}</div>
      <ProxyProgress item={item} />
    </li>
  );
}

function ListRow({ item }: { item: MediaItem }) {
  const fps = useStore((s) => s.settings.fps);
  const dragging = useStore((s) => s.mediaDrag?.mediaId === item.id);
  const { usedBy, placeable, remove, interact, itemTip, appendClip } = useItem(item);
  return (
    <li className={`media-row ${item.status} ${dragging ? "dragging" : ""} ${placeable ? "draggable" : ""}`} {...interact} {...itemTip}>
      <div className="thumb">
        <Thumb item={item} />
      </div>
      <div className="media-meta">
        <div className="media-name">{item.name}</div>
        <div className="badges">
          <span className="muted small">{lengthOf(item, fps)}</span>
          <span className="muted small">{resolutionOf(item)}</span>
          <Badges item={item} usedBy={usedBy} />
        </div>
        <ProxyProgress item={item} />
      </div>
      <Actions item={item} placeable={placeable} remove={remove} appendClip={appendClip} />
    </li>
  );
}

function DetailsRow({ item }: { item: MediaItem }) {
  const fps = useStore((s) => s.settings.fps);
  const dragging = useStore((s) => s.mediaDrag?.mediaId === item.id);
  const { usedBy, placeable, remove, interact, itemTip, appendClip } = useItem(item);
  const p = item.probe;
  const format = item.kind !== "video" ? extOf(item.path) : [p?.videoCodec && codecName(p.videoCodec), p?.container?.toUpperCase()].filter(Boolean).join(" · ") || extOf(item.path);
  const color = p?.hdr ? hdrLabel(p.hdr) : item.kind !== "video" ? "—" : `SDR${p?.bitDepth ? ` ${p.bitDepth}-bit` : ""}`;
  return (
    <tr className={`${item.status} ${dragging ? "dragging" : ""} ${placeable ? "draggable" : ""}`} {...interact}>
      <td className="name-col" {...itemTip}>
        <div className="name-cell">
          <span className="mini-thumb">
            <Thumb item={item} />
          </span>
          <span className="media-name">{item.name}</span>
        </div>
      </td>
      <td>{lengthOf(item, fps)}</td>
      <td>{resolutionOf(item)}</td>
      <td>{format}</td>
      <td className={p?.hdr ? "hdr-text" : ""}>{color}</td>
      <td>{p?.size ? formatBytes(p.size) : "—"}</td>
      <td>{usedBy || "—"}</td>
      <td>
        <Actions item={item} placeable={placeable} remove={remove} appendClip={appendClip} />
      </td>
    </tr>
  );
}
