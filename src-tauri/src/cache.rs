//! Where generated data (preview proxies) lives.
//!
//! * Saved projects keep it next to the project file: `<project dir>/vcb-cache/proxies/`.
//!   Projects in the same folder share it, which is fine: files are keyed by
//!   source file + settings, not by project.
//! * Unsaved projects use the app's temporary cache; on save, those files are
//!   moved into the project's folder (`adopt_proxies`).

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const PROJECT_CACHE_DIR: &str = "vcb-cache";

pub fn temp_proxy_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("proxies"))
}

/// Proxy folder for a project (or the temporary one for unsaved projects).
pub fn proxy_dir(app: &AppHandle, project_path: Option<&str>) -> Result<PathBuf, String> {
    match project_path {
        Some(p) => {
            let parent = Path::new(p).parent().ok_or("Invalid project path")?;
            Ok(parent.join(PROJECT_CACHE_DIR).join("proxies"))
        }
        None => temp_proxy_dir(app),
    }
}

/// Stable 64-bit FNV-1a (std's DefaultHasher may change between Rust versions,
/// which would orphan every cached proxy in saved projects).
pub fn stable_hash(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3))
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DirInfo {
    dir: String,
    files: u32,
    bytes: u64,
}

fn dir_info(dir: &Path) -> DirInfo {
    let mut info = DirInfo { dir: dir.to_string_lossy().into_owned(), ..Default::default() };
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if let Ok(m) = e.metadata() {
                if m.is_file() {
                    info.files += 1;
                    info.bytes += m.len();
                }
            }
        }
    }
    info
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    /// The project's cache (None for unsaved projects).
    project: Option<DirInfo>,
    /// The app-wide temporary cache used by unsaved projects.
    temporary: DirInfo,
}

#[tauri::command]
pub fn proxy_cache_info(app: AppHandle, project_path: Option<String>) -> Result<CacheInfo, String> {
    let temp = temp_proxy_dir(&app)?;
    let project = match project_path.as_deref() {
        Some(p) => Some(dir_info(&proxy_dir(&app, Some(p))?)),
        None => None,
    };
    Ok(CacheInfo { project, temporary: dir_info(&temp) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanResult {
    removed: u32,
    bytes: u64,
}

/// Deletes cached proxies in a cache folder except those in `keep` (in use).
/// `temporary` selects the app-wide temp cache instead of the project's.
/// Half-written files of running encodes are left alone.
#[tauri::command]
pub fn clean_proxy_cache(
    app: AppHandle,
    project_path: Option<String>,
    temporary: bool,
    keep: Vec<String>,
    jobs: tauri::State<'_, crate::ffmpeg::ProxyJobs>,
) -> Result<CleanResult, String> {
    let dir = if temporary { temp_proxy_dir(&app)? } else { proxy_dir(&app, project_path.as_deref())? };
    let keep: HashSet<PathBuf> = keep.iter().map(PathBuf::from).collect();
    let encoding = jobs.running();
    let mut res = CleanResult { removed: 0, bytes: 0 };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(res) };
    for e in entries.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if !path.is_file() || keep.contains(&path) || (encoding && name.ends_with(".partial.mp4")) {
            continue;
        }
        let len = e.metadata().map(|m| m.len()).unwrap_or(0);
        if std::fs::remove_file(&path).is_ok() {
            res.removed += 1;
            res.bytes += len;
        }
    }
    Ok(res)
}

/// Moves proxies from the temporary cache into a (newly saved) project's cache.
/// Paths outside the temporary cache are returned unchanged. Returns the new
/// path for every input, in order.
#[tauri::command]
pub fn adopt_proxies(app: AppHandle, paths: Vec<String>, project_path: String) -> Result<Vec<String>, String> {
    let temp = temp_proxy_dir(&app)?;
    let dest_dir = proxy_dir(&app, Some(&project_path))?;
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let scope = app.asset_protocol_scope();

    Ok(paths
        .into_iter()
        .map(|p| {
            let src = PathBuf::from(&p);
            let (Some(parent), Some(name)) = (src.parent(), src.file_name()) else { return p };
            if parent != temp {
                return p;
            }
            let dest = dest_dir.join(name);
            let moved = dest.is_file()
                || std::fs::rename(&src, &dest).is_ok()
                // Different drive: copy, then remove the temp file.
                || (std::fs::copy(&src, &dest).is_ok() && std::fs::remove_file(&src).map(|_| true).unwrap_or(true));
            if moved && scope.allow_file(&dest).is_ok() {
                let _ = std::fs::remove_file(&src);
                dest.to_string_lossy().into_owned()
            } else {
                p
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_hash_is_fnv1a() {
        // Reference values for FNV-1a 64.
        assert_eq!(stable_hash(""), 0xcbf29ce484222325);
        assert_eq!(stable_hash("a"), 0xaf63dc4c8601ec8c);
    }
}

/// Saves a PNG of the preview (sent as base64) and returns its path.
/// Saved projects keep screenshots next to the project file in `Screenshots/`;
/// unsaved projects use a temporary app folder.
#[tauri::command]
pub fn save_screenshot(app: AppHandle, project_path: Option<String>, name: String, data_base64: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim_start_matches("data:image/png;base64,"))
        .map_err(|e| format!("Invalid image data: {e}"))?;
    if !bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Err("Not a PNG image".into());
    }
    let dir = match project_path.as_deref() {
        Some(p) => Path::new(p).parent().ok_or("Invalid project path")?.join("Screenshots"),
        None => app.path().app_cache_dir().map_err(|e| e.to_string())?.join("screenshots"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Keep only safe file-name characters, and never overwrite an existing file.
    let stem: String = name
        .trim_end_matches(".png")
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') && !c.is_control())
        .collect();
    let stem = if stem.trim().is_empty() { "Screenshot".to_string() } else { stem.trim().to_string() };
    let mut path = dir.join(format!("{stem}.png"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}).png"));
        n += 1;
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
