mod cache;
mod ffmpeg;
mod probe;
mod project;

use probe::MediaProbe;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Keep in sync with IMAGE_EXTENSIONS in src/lib/media.ts.
const IMAGE_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    path: String,
    probe: Option<MediaProbe>,
    error: Option<String>,
}

/// Grants the webview read access to the given files (via the asset protocol)
/// and returns container/colour information for each, including HDR detection.
///
/// Files are allowed individually instead of opening the asset scope to the
/// whole filesystem.
#[tauri::command]
async fn import_media(app: AppHandle, paths: Vec<String>) -> Vec<ImportResult> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| {
                let p = PathBuf::from(&path);
                let result = (|| -> Result<MediaProbe, String> {
                    if !p.is_file() {
                        return Err("Not a file".into());
                    }
                    app.asset_protocol_scope()
                        .allow_file(&p)
                        .map_err(|e| format!("Could not grant access: {e}"))?;
                    let mut probe = probe::probe(&p).map_err(|e| format!("Could not read file: {e}"))?;
                    // Stills have no HDR/colour signalling worth probing.
                    let is_image = p
                        .extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
                    if !is_image {
                        ffmpeg::enrich_with_ffprobe(&mut probe);
                    }
                    probe.hdr = probe::classify_hdr(&probe);
                    Ok(probe)
                })();
                match result {
                    Ok(probe) => ImportResult { path, probe: Some(probe), error: None },
                    Err(error) => ImportResult { path, probe: None, error: Some(error) },
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(ffmpeg::ProxyJobs::default())
        .setup(|app| {
            // Runs after window-state restored the last size/position.
            if let Some(win) = app.get_webview_window("main") {
                let _ = project::fit_window_to_screen(&win);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            import_media,
            ffmpeg::ffmpeg_status,
            ffmpeg::create_proxy,
            ffmpeg::cancel_proxy,
            project::read_project,
            project::write_project,
            project::autosave_write,
            project::autosave_read,
            project::autosave_clear,
            cache::proxy_cache_info,
            cache::clean_proxy_cache,
            cache::adopt_proxies
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                ffmpeg::kill_all(app);
            }
        });
}
