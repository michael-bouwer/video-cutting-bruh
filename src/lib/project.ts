import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { useStore } from "../store";
import type { Clip, ProjectSettings } from "../types";
import { cancelProxy, refreshFfmpegStatus, restoreMedia, type SavedMedia } from "./media";
import { resetHistory, withoutHistory } from "./history";
import { ask, confirmUnsaved, projectName } from "./dialog";
import { requestNewProject } from "../components/NewProjectDialog";

const FORMAT = "video-cutting-bruh";
const VERSION = 1;
export const PROJECT_EXT = "vcbproj";
const AUTOSAVE_INTERVAL_MS = 15_000;
const RECENT_KEY = "vcb.recentProjects";
const RECENT_LIMIT = 10;

interface ProjectFile {
  format: typeof FORMAT;
  version: number;
  settings: ProjectSettings;
  media: SavedMedia[];
  clips: Clip[];
  view: { zoom: number; currentTime: number };
  /** Only in autosaves: which file the work belongs to. */
  projectPath?: string | null;
}

const DEFAULT_SETTINGS: ProjectSettings = { width: 1920, height: 1080, fps: 30, allowHdr: false, proxyMode: "auto", proxyQuality: "full" };

/** True while a project is being applied, so it isn't counted as an edit. */
let loading = false;

function serialize(includePath = false): string {
  const s = useStore.getState();
  const data: ProjectFile = {
    format: FORMAT,
    version: VERSION,
    settings: s.settings,
    media: s.media.map((m) => ({ id: m.id, path: m.path, name: m.name })),
    clips: s.clips,
    view: { zoom: s.zoom, currentTime: s.currentTime },
    ...(includePath ? { projectPath: s.projectPath } : {}),
  };
  return JSON.stringify(data, null, 2);
}

function parse(text: string): ProjectFile {
  const data = JSON.parse(text) as Partial<ProjectFile>;
  if (data.format !== FORMAT || !Array.isArray(data.media) || !Array.isArray(data.clips)) {
    throw new Error("Not a video-cutting-bruh project file");
  }
  if ((data.version ?? 0) > VERSION) throw new Error("This project was saved by a newer version of the app");
  return data as ProjectFile;
}

function cancelRunningProxies() {
  useStore.getState().media.forEach(cancelProxy);
}

async function dirname(path: string): Promise<string | null> {
  try {
    const { dirname } = await import("@tauri-apps/api/path");
    return await dirname(path);
  } catch {
    return null;
  }
}

async function applyProject(data: ProjectFile | null, path: string | null, dirty = false) {
  loading = true;
  try {
    cancelRunningProxies();
    withoutHistory(() =>
      useStore.setState({
        media: [],
        clips: [],
        selection: null,
        playing: false,
        currentTime: 0,
        settings: { ...DEFAULT_SETTINGS, ...data?.settings },
        zoom: data?.view?.zoom ?? 80,
        projectPath: path,
      }),
    );
    if (data) {
      await restoreMedia(data.media, path ? await dirname(path) : null);
      withoutHistory(() =>
        useStore.setState({ clips: data.clips, currentTime: data.view?.currentTime ?? 0 }),
      );
    }
    resetHistory();
    useStore.setState({ dirty });
  } finally {
    loading = false;
  }
}

// ---- Recent projects (per-device convenience, so localStorage is fine) ------

export interface RecentProject {
  path: string;
  name: string;
  openedAt: number;
}

export function getRecent(): RecentProject[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function setRecent(list: RecentProject[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_LIMIT)));
  } catch {
    /* storage unavailable — recents are optional */
  }
  useStore.setState((s) => ({ recentVersion: s.recentVersion + 1 }));
}

function addRecent(path: string) {
  setRecent([{ path, name: projectName(path), openedAt: Date.now() }, ...getRecent().filter((r) => r.path !== path)]);
}

export function removeRecent(path: string) {
  setRecent(getRecent().filter((r) => r.path !== path));
}

export function clearRecent() {
  setRecent([]);
}

// ---- Commands -------------------------------------------------------------------

function requireTauri(): boolean {
  if (isTauri()) return true;
  useStore.getState().notify("info", "Projects can only be saved and opened in the desktop app.");
  return false;
}

/** Asks to save unsaved changes. Resolves false if the user cancelled. */
async function settleUnsaved(action: string): Promise<boolean> {
  if (!useStore.getState().dirty) return true;
  const choice = await confirmUnsaved(action);
  if (choice === "cancel") return false;
  if (choice === "save") return saveProject();
  return true;
}

/**
 * Creates a project in its own folder: `<location>/<name>/<name>.vcbproj`,
 * with generated data (preview proxies) in `<location>/<name>/vcb-cache/`.
 */
export async function newProject() {
  if (!(await settleUnsaved("starting a new project"))) return;
  if (!isTauri()) {
    await applyProject(null, null);
    return;
  }
  const choice = await requestNewProject();
  if (!choice) return;
  const { join } = await import("@tauri-apps/api/path");
  const dir = await join(choice.folder, choice.name);
  const path = await join(dir, `${choice.name}.${PROJECT_EXT}`);

  const exists = await invoke<string>("read_project", { path }).then(
    () => true,
    () => false,
  );
  if (exists) {
    const overwrite = await ask(
      "Project already exists",
      `"${path}" already exists. Do you want to open it instead?`,
      [
        { id: "cancel", label: "Cancel" },
        { id: "open", label: "Open it", kind: "primary" },
      ],
      "cancel",
    );
    if (overwrite === "open") await openProject(path);
    return;
  }

  await applyProject(null, path);
  try {
    await invoke("write_project", { path, contents: serialize() });
  } catch (e) {
    useStore.setState({ projectPath: null });
    useStore.getState().notify("error", `Couldn't create the project: ${e}`);
    return;
  }
  addRecent(path);
  clearAutosave();
  useStore.getState().notify("info", `Created ${choice.name} in ${dir}`);
}

/** Moves preview proxies made while the project was unsaved into its folder. */
async function adoptProxies(projectPath: string) {
  const items = useStore.getState().media.filter((m) => m.proxy?.status === "ready" && m.proxy.path);
  if (items.length === 0) return;
  try {
    const moved = await invoke<string[]>("adopt_proxies", { paths: items.map((m) => m.proxy!.path), projectPath });
    items.forEach((m, i) => {
      const next = moved[i];
      if (!next || next === m.proxy!.path) return;
      const current = useStore.getState().media.find((x) => x.id === m.id);
      if (current?.proxy) {
        useStore.getState().updateMedia(m.id, { src: convertFileSrc(next), proxy: { ...current.proxy, path: next } });
      }
    });
  } catch {
    /* proxies stay in the temp cache; they still work */
  }
}

export async function openProject(path?: string) {
  if (!requireTauri()) return;
  if (!(await settleUnsaved("opening another project"))) return;
  if (!path) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "video-cutting-bruh project", extensions: [PROJECT_EXT] }],
    });
    if (!picked || Array.isArray(picked)) return;
    path = picked;
  }
  let data: ProjectFile;
  try {
    data = parse(await invoke<string>("read_project", { path }));
  } catch (e) {
    useStore.getState().notify("error", `Couldn't open ${projectName(path)}: ${e instanceof Error ? e.message : e}`);
    removeRecent(path);
    return;
  }
  await applyProject(data, path);
  addRecent(path);
  clearAutosave();
}

/** Saves the project (asking for a location if needed). Resolves true on success. */
export async function saveProject(saveAs = false): Promise<boolean> {
  if (!requireTauri()) return false;
  let path = useStore.getState().projectPath;
  if (saveAs || !path) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const picked = await save({
      defaultPath: path ?? `${projectName(null)}.${PROJECT_EXT}`,
      filters: [{ name: "video-cutting-bruh project", extensions: [PROJECT_EXT] }],
    });
    if (!picked) return false;
    path = picked.toLowerCase().endsWith(`.${PROJECT_EXT}`) ? picked : `${picked}.${PROJECT_EXT}`;
  }
  try {
    await invoke("write_project", { path, contents: serialize() });
  } catch (e) {
    useStore.getState().notify("error", `Couldn't save: ${e}`);
    return false;
  }
  useStore.setState({ projectPath: path, dirty: false });
  await adoptProxies(path);
  addRecent(path);
  clearAutosave();
  useStore.getState().notify("info", `Saved ${projectName(path)}`);
  return true;
}

// ---- Autosave / crash recovery ------------------------------------------------------

function clearAutosave() {
  if (isTauri()) invoke("autosave_clear").catch(() => {});
}

let autosaveChecked = false;
async function offerAutosaveRestore() {
  // Only once per app start (effects can mount twice in dev).
  if (autosaveChecked) return;
  autosaveChecked = true;
  const saved = await invoke<{ contents: string; modified: number } | null>("autosave_read").catch(() => null);
  if (!saved) return;
  let data: ProjectFile;
  try {
    data = parse(saved.contents);
  } catch {
    clearAutosave();
    return;
  }
  if (data.clips.length === 0 && data.media.length === 0) return clearAutosave();
  const when = new Date(saved.modified).toLocaleString();
  const choice = await ask(
    "Recover unsaved work?",
    `The app closed unexpectedly while "${projectName(data.projectPath ?? null)}" had unsaved changes (autosaved ${when}). Do you want to recover them?`,
    [
      { id: "discard", label: "Discard", kind: "danger" },
      { id: "restore", label: "Recover", kind: "primary" },
    ],
    "discard",
  );
  if (choice === "restore") await applyProject(data, data.projectPath ?? null, true);
  else clearAutosave();
}

// ---- Wiring -----------------------------------------------------------------------------

const mediaKey = (s: ReturnType<typeof useStore.getState>) => s.media.map((m) => `${m.id}:${m.path}`).join("|");

/** Installs dirty tracking, window title, autosave, close guard and crash recovery. */
export function installProjectLifecycle(): () => void {
  const cleanups: (() => void)[] = [];

  // Any edit to the timeline, settings or the set of media marks the project dirty.
  cleanups.push(
    useStore.subscribe((s, prev) => {
      if (loading || s.dirty) return;
      if (s.clips !== prev.clips || s.settings !== prev.settings || (s.media !== prev.media && mediaKey(s) !== mediaKey(prev))) {
        useStore.setState({ dirty: true });
      }
    }),
  );

  // Window title: "• name — video-cutting-bruh"
  const updateTitle = () => {
    const { projectPath, dirty } = useStore.getState();
    const title = `${dirty ? "• " : ""}${projectName(projectPath)} — video-cutting-bruh`;
    document.title = title;
    if (isTauri()) {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title)).catch(() => {});
    }
  };
  updateTitle();
  cleanups.push(
    useStore.subscribe((s, prev) => {
      if (s.projectPath !== prev.projectPath || s.dirty !== prev.dirty) updateTitle();
    }),
  );

  if (!isTauri()) {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useStore.getState().dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    cleanups.push(() => window.removeEventListener("beforeunload", onBeforeUnload));
    return () => cleanups.forEach((c) => c());
  }

  // Autosave for crash recovery (cleared on save / clean exit).
  const timer = setInterval(() => {
    if (useStore.getState().dirty && !loading) invoke("autosave_write", { contents: serialize(true) }).catch(() => {});
  }, AUTOSAVE_INTERVAL_MS);
  cleanups.push(() => clearInterval(timer));

  // Confirm unsaved changes before the window closes.
  let unlistenClose: (() => void) | undefined;
  let disposed = false;
  import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
    const win = getCurrentWindow();
    const un = await win.onCloseRequested(async (event) => {
      if (!useStore.getState().dirty) {
        clearAutosave();
        return;
      }
      event.preventDefault();
      if (!(await settleUnsaved("closing"))) return;
      clearAutosave();
      cancelRunningProxies();
      await win.destroy();
    });
    if (disposed) un();
    else unlistenClose = un;
  });
  cleanups.push(() => {
    disposed = true;
    unlistenClose?.();
  });

  refreshFfmpegStatus().then(offerAutosaveRestore);
  return () => cleanups.forEach((c) => c());
}
