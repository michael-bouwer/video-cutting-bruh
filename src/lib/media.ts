import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore, uid } from "../store";
import type { FfmpegStatus, HdrKind, MediaItem, MediaKind, MediaProbe, ProxyQuality } from "../types";

export const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "webm", "mkv"];
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];
export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus"];
export const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS];
/** Length of a still image when it's first placed on the timeline. */
export const IMAGE_DEFAULT_DURATION = 5;
/** Longest an image clip can be trimmed out to. */
export const IMAGE_MAX_DURATION = 3600;

const IMPORT_FILTERS = [
  { name: "Media", extensions: MEDIA_EXTENSIONS },
  { name: "Video", extensions: VIDEO_EXTENSIONS },
  { name: "Images", extensions: IMAGE_EXTENSIONS },
  { name: "Audio", extensions: AUDIO_EXTENSIONS },
];

interface ImportResult {
  path: string;
  probe: MediaProbe | null;
  error: string | null;
}

const extOf = (p: string) => p.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
const nameOf = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const kindOf = (p: string): MediaKind =>
  IMAGE_EXTENSIONS.includes(extOf(p)) ? "image" : AUDIO_EXTENSIONS.includes(extOf(p)) ? "audio" : "video";

/** Loads an audio file's metadata to learn its length. */
function loadAudio(src: string): Promise<{ duration: number }> {
  return new Promise((resolve, reject) => {
    const a = new Audio();
    a.preload = "metadata";
    const timer = setTimeout(() => reject(new Error("Timed out reading audio")), 20000);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
      a.removeAttribute("src");
      a.load();
    };
    a.onloadedmetadata = () => {
      const finish = () =>
        done(() => (Number.isFinite(a.duration) && a.duration > 0 ? resolve({ duration: a.duration }) : reject(new Error("Unknown duration"))));
      if (a.duration !== Infinity) return finish();
      a.ondurationchange = () => Number.isFinite(a.duration) && finish();
      a.currentTime = Number.MAX_SAFE_INTEGER;
    };
    a.onerror = () => done(() => reject(new Error(a.error?.message || "Unsupported audio format")));
    a.src = src;
  });
}

/** Loads an image to learn its size. */
function loadImage(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () =>
      img.naturalWidth ? resolve({ width: img.naturalWidth, height: img.naturalHeight }) : reject(new Error("Empty image"));
    img.onerror = () => reject(new Error("Unsupported or corrupt image"));
    img.src = src;
  });
}

export const hdrLabel = (h: HdrKind) => (h === "DolbyVision" ? "Dolby Vision" : h === "PQ" ? "HDR10 (PQ)" : "HLG");

type Platform = "windows" | "mac" | "linux" | "other";
function platform(): Platform {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return "linux";
  return "other";
}

/** Explains why the system webview may not decode a file. */
function decodeHint(probe: MediaProbe | null): string {
  const codec = (probe?.videoCodec ?? "").toLowerCase();
  const os = platform();
  if (/^(hvc1|hev1|dvh1|dvhe|hevc)$/.test(codec)) {
    if (os === "windows") return "HEVC playback in WebView2 needs the \"HEVC Video Extensions\" from the Microsoft Store and a GPU with HEVC decode.";
    if (os === "linux") return "HEVC playback needs GStreamer plugins (gst-plugins-bad and gst-libav).";
  }
  if (/^ap(4h|4x|cn|ch|cs|co)$/.test(codec)) return "ProRes isn't supported by the system webview — transcode to H.264/HEVC first.";
  if (os === "linux") return "Make sure GStreamer plugins (good, bad, ugly, libav) are installed.";
  return "The system webview couldn't decode this file's codec.";
}

/** Loads just the metadata to learn the decodable duration/size. */
function loadMetadata(src: string): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const done = () => {
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error("Timed out reading metadata"));
    }, 20000);
    const finish = () => {
      const meta = { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
      done();
      if (!meta.width || !meta.height) reject(new Error("No decodable video track"));
      else if (!Number.isFinite(meta.duration) || meta.duration <= 0) reject(new Error("Unknown duration"));
      else resolve(meta);
    };
    v.onloadedmetadata = () => {
      if (v.duration !== Infinity) return finish();
      // WebM/MKV written by recorders often lack a duration header; seeking far
      // past the end makes the browser scan the file and report the real length.
      v.ondurationchange = () => Number.isFinite(v.duration) && finish();
      v.currentTime = Number.MAX_SAFE_INTEGER;
    };
    v.onerror = () => {
      done();
      reject(new Error(v.error?.message || "Unsupported format"));
    };
    v.src = src;
  });
}

// ---- ffmpeg / proxies --------------------------------------------------------

const FFMPEG_INSTALL_HINT: Record<Platform, string> = {
  windows: "winget install Gyan.FFmpeg",
  mac: "brew install ffmpeg",
  linux: "your package manager (e.g. sudo apt install ffmpeg)",
  other: "ffmpeg.org",
};

export async function refreshFfmpegStatus() {
  if (!isTauri()) return;
  try {
    useStore.setState({ ffmpeg: await invoke<FfmpegStatus>("ffmpeg_status") });
  } catch {
    useStore.setState({ ffmpeg: { available: false, path: null, version: null, canTonemap: false, caps: null } });
  }
}

let progressListener: Promise<unknown> | null = null;
function listenForProxyProgress() {
  progressListener ??= listen<{ job: string; progress: number }>("proxy-progress", ({ payload }) => {
    const m = useStore.getState().media.find((x) => x.proxy?.job === payload.job);
    if (m?.proxy?.status === "generating") {
      useStore.getState().updateMedia(m.id, { proxy: { ...m.proxy, progress: payload.progress } });
    }
  });
  return progressListener;
}

/** Encodes run one at a time — each already saturates the GPU or every CPU core. */
let proxyQueue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = proxyQueue.then(job, job);
  proxyQueue = run.catch(() => {});
  return run;
}

/** Cancels an item's running/queued proxy encode, if any. */
export function cancelProxy(m: MediaItem | undefined) {
  if (m?.proxy?.status === "generating" && m.proxy.job && isTauri()) {
    invoke("cancel_proxy", { job: m.proxy.job }).catch(() => {});
  }
}

/** Removes a media item, cancelling its proxy encode if one is running. */
export function removeMediaItem(id: string) {
  const m = useStore.getState().media.find((x) => x.id === id);
  cancelProxy(m);
  if (m?.src.startsWith("blob:")) URL.revokeObjectURL(m.src);
  useStore.getState().removeMedia(id);
}

const qualityHeight = (q: ProxyQuality) => (q === "full" ? null : Number(q));

/**
 * Builds (or reuses a cached) proxy at the current quality setting and switches
 * the item's preview to it. While it encodes, the item keeps playing whatever
 * it played before (if anything). Resolves false if cancelled or superseded.
 */
async function buildProxy(item: MediaItem): Promise<boolean> {
  const { updateMedia, notify, settings } = useStore.getState();
  const job = `${item.id}:${uid()}`;
  const current = () => useStore.getState().media.find((m) => m.id === item.id);
  const stillOurs = () => current()?.proxy?.job === job;

  await listenForProxyProgress();
  cancelProxy(current());
  updateMedia(item.id, { proxy: { status: "generating", progress: 0, job } });
  try {
    const res = await enqueue(() => {
      // Skip queued work that was cancelled or replaced while waiting.
      if (!stillOurs()) return Promise.reject(new Error("cancelled"));
      return invoke<{ path: string; method: string }>("create_proxy", {
        job,
        path: item.path,
        duration: item.probe?.duration ?? null,
        tonemap: item.probe?.hdr ?? null,
        maxHeight: qualityHeight(settings.proxyQuality),
        sourceHeight: item.probe?.height ?? null,
        // Saved projects keep their proxies in the project folder.
        projectPath: useStore.getState().projectPath,
      });
    });
    if (!stillOurs()) return false;
    const src = convertFileSrc(res.path);
    const meta = await loadMetadata(src);
    updateMedia(item.id, {
      ...meta,
      // Keep the source's duration: the proxy can differ by a frame.
      duration: item.duration > 0 ? item.duration : meta.duration,
      src,
      status: "ready",
      error: undefined,
      proxy: { status: "ready", progress: 1, path: res.path, method: res.method, height: meta.height, job },
    });
    return true;
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (msg === "cancelled" || !stillOurs()) return false;
    const wasPlayable = current()?.status === "ready";
    updateMedia(item.id, {
      ...(wasPlayable ? {} : { status: "error" as const, error: msg }),
      proxy: { status: "error", progress: 0, error: msg, job },
    });
    notify("error", `${item.name}: couldn't create a preview proxy — ${msg}`);
    return false;
  }
}

/**
 * Re-encodes existing proxies after the proxy quality setting changes.
 * Items keep previewing their current proxy until the new one is ready.
 */
export function regenerateProxies() {
  for (const m of useStore.getState().media) {
    if (m.proxy && m.proxy.status !== "error") void buildProxy(m);
  }
}

/**
 * Makes an item playable: uses the original if the webview can decode it,
 * otherwise (or for HDR / "always" mode) generates a proxy with ffmpeg.
 * `onAppendable` fires as soon as the item can be placed on the timeline,
 * which for proxies is before encoding finishes (the duration is already known).
 */
async function prepare(item: MediaItem, onAppendable: () => void): Promise<boolean> {
  const { updateMedia, notify } = useStore.getState();
  if (item.kind === "audio") {
    try {
      const { duration } = await loadAudio(item.src);
      updateMedia(item.id, { duration, width: 0, height: 0, status: "ready" });
      return true;
    } catch (e) {
      const msg = `${e instanceof Error ? e.message : e}. ${platform() === "linux" ? "Make sure GStreamer plugins are installed." : "Try mp3, wav, m4a/aac, flac or ogg."}`;
      updateMedia(item.id, { status: "error", error: msg });
      notify("error", `${item.name}: ${msg}`);
      return false;
    }
  }
  if (item.kind === "image") {
    try {
      const size = await loadImage(item.src);
      updateMedia(item.id, { ...size, duration: IMAGE_DEFAULT_DURATION, status: "ready" });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updateMedia(item.id, { status: "error", error: msg });
      notify("error", `${item.name}: ${msg}`);
      return false;
    }
  }
  const { settings, ffmpeg } = useStore.getState();
  const canProxy = isTauri() && !!ffmpeg?.available && settings.proxyMode !== "off";
  const wantProxy = canProxy && (settings.proxyMode === "always" || item.probe?.hdr != null);

  if (!wantProxy) {
    try {
      const meta = await loadMetadata(item.src);
      updateMedia(item.id, { ...meta, status: "ready" });
      return true;
    } catch (e) {
      if (!canProxy) {
        let msg = `${e instanceof Error ? e.message : e}. ${decodeHint(item.probe)}`;
        if (isTauri() && !ffmpeg?.available) {
          msg += ` Or install ffmpeg (${FFMPEG_INSTALL_HINT[platform()]}) and re-import so the app can convert it automatically.`;
        }
        updateMedia(item.id, { status: "error", error: msg });
        notify("error", `${item.name}: ${msg}`);
        return false;
      }
      // Fall through: the webview can't play it, so build a proxy.
    }
  }

  updateMedia(item.id, { status: "proxying" });
  if (item.duration > 0) onAppendable();
  return buildProxy(item);
}

async function finishImport(items: MediaItem[], toTimeline: boolean) {
  const appendable = items.map(() => {
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>((r) => (resolve = r));
    return { promise, resolve };
  });
  const tasks = items.map((item, i) =>
    prepare(item, () => appendable[i].resolve(true)).then((ok) => appendable[i].resolve(ok)),
  );
  if (toTimeline) {
    // Append in drop order, each as soon as it (and everything before it) can be placed.
    for (let i = 0; i < items.length; i++) {
      if (await appendable[i].promise) useStore.getState().appendClip(items[i].id);
    }
  }
  await Promise.all(tasks);
}

/** Imports files by path (Tauri: native drag & drop or the file dialog). */
export async function importPaths(paths: string[], toTimeline = false) {
  const { notify, addMedia } = useStore.getState();
  const videos = paths.filter((p) => MEDIA_EXTENSIONS.includes(extOf(p)));
  const skipped = paths.length - videos.length;
  if (skipped > 0) notify("warn", `Skipped ${skipped} file(s) that aren't videos, images or audio (${MEDIA_EXTENSIONS.join(", ")}).`);
  if (videos.length === 0) return;

  if (!useStore.getState().ffmpeg) await refreshFfmpegStatus();

  let results: ImportResult[];
  try {
    results = await invoke<ImportResult[]>("import_media", { paths: videos });
  } catch (e) {
    notify("error", `Import failed: ${e}`);
    return;
  }

  const items: MediaItem[] = [];
  for (const r of results) {
    if (r.error || !r.probe) {
      notify("error", `${nameOf(r.path)}: ${r.error ?? "unknown error"}`);
      continue;
    }
    // Read the setting per file so toggling mid-import behaves predictably.
    if (r.probe.hdr && !useStore.getState().settings.allowHdr) {
      notify("warn", `${r.probe.fileName} was captured in ${hdrLabel(r.probe.hdr)}. Turn on "Allow HDR" to import it.`);
      continue;
    }
    const item = itemFromProbe(r.probe);
    addMedia(item);
    items.push(item);
  }
  await finishImport(items, toTimeline);
}

function itemFromProbe(probe: MediaProbe, id = uid()): MediaItem {
  const kind = kindOf(probe.path);
  return {
    id,
    kind,
    addedAt: Date.now(),
    name: probe.fileName || nameOf(probe.path),
    path: probe.path,
    src: convertFileSrc(probe.path),
    probe,
    status: "loading",
    duration: kind === "image" ? IMAGE_DEFAULT_DURATION : (probe.duration ?? 0),
    width: probe.width ?? 0,
    height: probe.height ?? 0,
  };
}

export interface SavedMedia {
  id: string;
  path: string;
  name: string;
}

/**
 * Re-imports a project's media, keeping their ids so clips stay linked.
 * Files that moved are looked for next to the project file (same name);
 * anything still missing is kept as a "missing" placeholder that can be relinked.
 * The HDR gate is skipped: the project already accepted these files.
 */
export async function restoreMedia(entries: SavedMedia[], projectDir: string | null) {
  if (!isTauri() || entries.length === 0) return;
  if (!useStore.getState().ffmpeg) await refreshFfmpegStatus();
  const { addMedia } = useStore.getState();

  const results = await invoke<ImportResult[]>("import_media", { paths: entries.map((e) => e.path) });
  const missing = entries.filter((_, i) => !results[i]?.probe);
  const nearby = new Map<string, MediaProbe>();
  if (projectDir && missing.length) {
    const { join } = await import("@tauri-apps/api/path");
    const guesses = await Promise.all(missing.map((e) => join(projectDir, nameOf(e.path))));
    const found = await invoke<ImportResult[]>("import_media", { paths: guesses });
    missing.forEach((e, i) => found[i]?.probe && nearby.set(e.id, found[i].probe!));
  }

  const items: MediaItem[] = [];
  entries.forEach((e, i) => {
    const probe = results[i]?.probe ?? nearby.get(e.id);
    if (probe) {
      const item = itemFromProbe(probe, e.id);
      addMedia(item);
      items.push(item);
    } else {
      addMedia({
        id: e.id,
        kind: kindOf(e.path),
        addedAt: Date.now(),
        name: e.name || nameOf(e.path),
        path: e.path,
        src: "",
        probe: null,
        status: "missing",
        error: "File not found — use Relink to locate it.",
        duration: 0,
        width: 0,
        height: 0,
      });
    }
  });
  const relinked = nearby.size;
  if (relinked) useStore.getState().notify("info", `Found ${relinked} moved file(s) next to the project.`);
  if (missing.length > relinked) {
    useStore.getState().notify("warn", `${missing.length - relinked} media file(s) are missing. Use "Relink" in the media bin.`);
  }
  // Don't wait for proxies: the project is usable while they encode.
  void finishImport(items, false);
}

/** Points a (missing) media item at a different file, keeping its clips. */
export async function relinkMedia(id: string) {
  if (!isTauri()) return;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: false, directory: false, filters: IMPORT_FILTERS });
  if (!picked || Array.isArray(picked)) return;
  const [r] = await invoke<ImportResult[]>("import_media", { paths: [picked] });
  if (!r?.probe) {
    useStore.getState().notify("error", `Couldn't open ${nameOf(picked)}: ${r?.error ?? "unknown error"}`);
    return;
  }
  const item = itemFromProbe(r.probe, id);
  useStore.getState().updateMedia(id, { ...item, error: undefined, proxy: undefined });
  await finishImport([item], false);
}

/**
 * Browser fallback (plain `pnpm dev` without Tauri): no native paths or probing,
 * so HDR can't be detected — files are always accepted.
 */
export async function importFiles(files: File[], toTimeline = false) {
  const { addMedia, notify } = useStore.getState();
  const items: MediaItem[] = [];
  for (const f of files) {
    if (!MEDIA_EXTENSIONS.includes(extOf(f.name)) && !/^(video|image|audio)\//.test(f.type)) {
      notify("warn", `Skipped ${f.name}: not a video, image or audio file.`);
      continue;
    }
    const item: MediaItem = {
      id: uid(),
      kind: f.type.startsWith("image/") ? "image" : f.type.startsWith("audio/") ? "audio" : kindOf(f.name),
      addedAt: Date.now(),
      name: f.name,
      path: f.name,
      src: URL.createObjectURL(f),
      probe: null,
      status: "loading",
      duration: 0,
      width: 0,
      height: 0,
    };
    addMedia(item);
    items.push(item);
  }
  await finishImport(items, toTimeline);
}

export async function openImportDialog() {
  if (!isTauri()) {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = MEDIA_EXTENSIONS.map((e) => `.${e}`).join(",");
    input.onchange = () => input.files && importFiles([...input.files]);
    input.click();
    return;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: true,
    directory: false,
    filters: IMPORT_FILTERS,
  });
  if (picked) await importPaths(Array.isArray(picked) ? picked : [picked]);
}
