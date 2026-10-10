//! Project file IO, crash-recovery autosave, and keeping the main window on screen.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

pub const PROJECT_EXT: &str = "vcbproj";
const AUTOSAVE_FILE: &str = "autosave.vcbproj";

fn ensure_project_path(path: &Path) -> Result<(), String> {
    match path.extension().and_then(|e| e.to_str()) {
        Some(e) if e.eq_ignore_ascii_case(PROJECT_EXT) => Ok(()),
        _ => Err(format!("Project files must use the .{PROJECT_EXT} extension")),
    }
}

/// Writes via a temp file + rename so a crash mid-save never corrupts the project.
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("{PROJECT_EXT}.tmp"));
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

#[tauri::command]
pub fn read_project(path: String) -> Result<String, String> {
    let p = PathBuf::from(path);
    ensure_project_path(&p)?;
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_project(path: String, contents: String) -> Result<(), String> {
    let p = PathBuf::from(path);
    ensure_project_path(&p)?;
    write_atomic(&p, &contents)
}

fn autosave_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(AUTOSAVE_FILE))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Autosave {
    contents: String,
    /// Milliseconds since the Unix epoch.
    modified: u64,
}

#[tauri::command]
pub fn autosave_write(app: AppHandle, contents: String) -> Result<(), String> {
    write_atomic(&autosave_path(&app)?, &contents)
}

#[tauri::command]
pub fn autosave_read(app: AppHandle) -> Option<Autosave> {
    let p = autosave_path(&app).ok()?;
    let contents = std::fs::read_to_string(&p).ok()?;
    let modified = std::fs::metadata(&p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(Autosave { contents, modified })
}

#[tauri::command]
pub fn autosave_clear(app: AppHandle) {
    if let Ok(p) = autosave_path(&app) {
        let _ = std::fs::remove_file(p);
    }
}

/// Makes sure the window fits on, and is visible on, a connected monitor.
/// Handles default sizes larger than small laptop screens and restored
/// positions from monitors that have since been disconnected.
pub fn fit_window_to_screen(win: &WebviewWindow) -> tauri::Result<()> {
    let monitors = win.available_monitors()?;
    let Some(fallback) = win.primary_monitor()?.or_else(|| monitors.first().cloned()) else {
        return Ok(());
    };
    let pos = win.outer_position()?;
    let size = win.outer_size()?;

    // The monitor that contains the window's title bar area, if any.
    let probe = (pos.x + (size.width as i32).min(200) / 2, pos.y + 16);
    let on_screen = monitors.iter().find(|m| {
        let (mp, ms) = (m.position(), m.size());
        probe.0 >= mp.x && probe.0 < mp.x + ms.width as i32 && probe.1 >= mp.y && probe.1 < mp.y + ms.height as i32
    });
    let monitor = on_screen.unwrap_or(&fallback);
    let area = monitor.work_area();
    let (ax, ay, aw, ah) = (area.position.x, area.position.y, area.size.width, area.size.height);

    let mut new_size = size;
    if size.width > aw || size.height > ah {
        new_size = PhysicalSize::new(size.width.min(aw * 95 / 100), size.height.min(ah * 95 / 100));
        win.set_size(new_size)?;
    }
    let fits = pos.x >= ax
        && pos.y >= ay
        && pos.x + new_size.width as i32 <= ax + aw as i32
        && pos.y + new_size.height as i32 <= ay + ah as i32;
    if on_screen.is_none() || !fits {
        let x = ax + (aw as i32 - new_size.width as i32).max(0) / 2;
        let y = ay + (ah as i32 - new_size.height as i32).max(0) / 2;
        win.set_position(PhysicalPosition::new(x, y))?;
    }
    Ok(())
}
