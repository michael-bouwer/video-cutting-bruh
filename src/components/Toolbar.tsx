import { useStore } from "../store";
import { formatTime, layoutClips } from "../lib/timeline";
import { openImportDialog } from "../lib/media";
import { shortResolution } from "./ProjectPanel";
import { clearRecent, getRecent, newProject, openProject, saveProject } from "../lib/project";
import { redo, undo } from "../lib/history";
import { Dropdown, MenuItem, kbd } from "./ui";
import { tip } from "./Tooltip";
import { setThemePref, useTheme, type ThemePref } from "../lib/theme";

export function Toolbar() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const playing = useStore((s) => s.playing);
  const setPlaying = useStore((s) => s.setPlaying);
  const currentTime = useStore((s) => s.currentTime);
  const total = useStore((s) => layoutClips(s.clips).total);
  const seek = useStore((s) => s.seek);
  const split = useStore((s) => s.splitAtPlayhead);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);

  const rightTab = useStore((s) => s.rightTab);
  const setRightTab = useStore((s) => s.setRightTab);

  return (
    <header className="toolbar">
      <div className="toolbar-group left">
        <FileMenu />
        <button
          onClick={openImportDialog}
          {...tip("Add videos or images to the media bin. You can also drag files onto the window — drop them on the timeline to add them as clips right away.", { title: "Import media", kbd: kbd("Mod+I"), label: "Import media" })}
        >
          <span aria-hidden>＋</span>
          <span className="collapse-label"> Import</span>
        </button>
        <span className="toolbar-sep" />
        <button className="icon-btn" disabled={!canUndo} onClick={undo} {...tip("Undo the last timeline edit", { kbd: kbd("Mod+Z"), label: "Undo" })}>
          ↶
        </button>
        <button className="icon-btn" disabled={!canRedo} onClick={redo} {...tip("Redo the last undone edit", { kbd: kbd("Mod+Shift+Z"), label: "Redo" })}>
          ↷
        </button>
      </div>

      <div className="toolbar-group transport">
        <button className="icon-btn" onClick={() => seek(0)} {...tip("Go to start", { kbd: "Home", label: "Go to start" })}>
          ⏮
        </button>
        <button className="icon-btn play" onClick={() => setPlaying(!playing)} {...tip(playing ? "Pause" : "Play", { kbd: "Space", label: playing ? "Pause" : "Play" })}>
          {playing ? "⏸" : "▶"}
        </button>
        <button className="icon-btn" onClick={() => seek(total)} {...tip("Go to end", { kbd: "End", label: "Go to end" })}>
          ⏭
        </button>
        <span
          className="timecode"
          {...tip(`Playhead position / total length, as minutes:seconds:frames at ${settings.fps} fps. Step one frame with ← →, one second with Shift+← →.`, { title: "Timecode" })}
        >
          {formatTime(currentTime, settings.fps)}
          <span className="muted collapse-label"> / {formatTime(total, settings.fps)}</span>
        </span>
        <button
          onClick={split}
          {...tip("Cut the clip under the playhead into two separate clips. Keyframed motion continues across the cut.", { title: "Split", kbd: "S", label: "Split at playhead" })}
        >
          <span aria-hidden>✂</span>
          <span className="collapse-label"> Split</span>
        </button>
      </div>

      <div className="toolbar-group right">
        <ThemeMenu />
        <label
          className={`toggle ${settings.allowHdr ? "on" : ""}`}
          {...tip(
            "Off: HDR videos (HDR10, HLG, Dolby Vision — e.g. game or phone recordings with HDR capture on) are rejected on import. On: they're accepted and shown tone-mapped to normal range in the preview.",
            { title: "Allow HDR clips" },
          )}
        >
          <input type="checkbox" checked={settings.allowHdr} onChange={(e) => setSettings({ allowHdr: e.target.checked })} />
          HDR
        </label>
        <button
          className={rightTab === "project" ? "active" : ""}
          onClick={() => setRightTab(rightTab === "project" ? "inspector" : "project")}
          {...tip("Resolution, frame rate, HDR and preview-proxy settings — opens the Project tab on the right", { title: "Project settings" })}
        >
          ⚙ <span className="collapse-label">{shortResolution(settings.width, settings.height)} · </span>
          {settings.fps}fps
        </button>
      </div>
    </header>
  );
}

function FileMenu() {
  const projectPath = useStore((s) => s.projectPath);
  useStore((s) => s.recentVersion); // re-render when recents change
  const recent = getRecent().filter((r) => r.path !== projectPath);

  return (
    <Dropdown label={<>File ▾</>} tip={tip("New, open and save projects; recent projects", { title: "File" })}>
      {(close) => {
        const run = (fn: () => unknown) => () => {
          close();
          fn();
        };
        return (
          <div className="menu">
            <MenuItem label="New project…" shortcut={kbd("Mod+N")} onClick={run(newProject)} />
            <MenuItem label="Open project…" shortcut={kbd("Mod+O")} onClick={run(() => openProject())} />
            <MenuItem label="Save" shortcut={kbd("Mod+S")} onClick={run(() => saveProject())} />
            <MenuItem label="Save as…" shortcut={kbd("Mod+Shift+S")} onClick={run(() => saveProject(true))} />
            <div className="menu-sep" />
            <MenuItem label="Import media…" shortcut={kbd("Mod+I")} onClick={run(openImportDialog)} />
            <div className="menu-sep" />
            <div className="menu-heading">Recent projects</div>
            {recent.length === 0 ? (
              <div className="menu-empty muted small">No recent projects</div>
            ) : (
              <>
                {recent.map((r) => (
                  <MenuItem
                    key={r.path}
                    label={
                      <span className="recent-item">
                        {r.name}
                        <span className="muted small">{r.path}</span>
                      </span>
                    }
                    onClick={run(() => openProject(r.path))}
                  />
                ))}
                <MenuItem label={<span className="muted">Clear recent</span>} onClick={run(clearRecent)} />
              </>
            )}
          </div>
        );
      }}
    </Dropdown>
  );
}

const THEME_OPTIONS: { key: ThemePref; label: string; icon: string }[] = [
  { key: "system", label: "System", icon: "◐" },
  { key: "light", label: "Day", icon: "☀" },
  { key: "dark", label: "Night", icon: "☾" },
];

function ThemeMenu() {
  const { pref, theme } = useTheme();
  const current = THEME_OPTIONS.find((o) => o.key === pref)!;
  return (
    <Dropdown
      align="right"
      className="theme-menu"
      tip={tip(
        pref === "system"
          ? `Following your system setting (currently ${theme === "light" ? "day" : "night"}). Choose Day or Night to override.`
          : `${current.label} theme. Choose System to follow your OS setting.`,
        { title: "Theme", label: "Theme" },
      )}
      label={<span aria-label="Theme">{pref === "system" ? current.icon : theme === "light" ? "☀" : "☾"}</span>}
    >
      {(close) => (
        <div className="menu">
          <div className="menu-heading">Theme</div>
          {THEME_OPTIONS.map((o) => (
            <MenuItem
              key={o.key}
              label={
                <span className="theme-option">
                  <span className="check">{pref === o.key ? "✓" : ""}</span>
                  {o.icon} {o.label}
                </span>
              }
              shortcut={o.key === "system" ? (theme === "light" ? "now: day" : "now: night") : undefined}
              onClick={() => {
                setThemePref(o.key);
                close();
              }}
            />
          ))}
        </div>
      )}
    </Dropdown>
  );
}
