//! Timeline visuals for media files: audio waveforms (peak envelopes) and
//! thumbnail strips (one JPEG sprite sheet per file).
//!
//! Both are made with ffmpeg in the background and cached in the app's cache
//! folder, keyed by file path, size and modification time. Generation runs one
//! file at a time so a big import doesn't start dozens of decoders at once.

use crate::ffmpeg::{command, locate};
use base64::Engine;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// Bump when the output format changes, to invalidate cached files.
const VERSION: u32 = 1;
/// Waveform resolution: peaks per second of audio.
pub const PEAKS_PER_SECOND: u32 = 100;
/// Decoding sample rate for waveforms (mono); plenty for a peak envelope.
const WAVE_RATE: u32 = 8000;

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

fn visuals_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("visuals");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Cache key for a file + parameters (changes when the file does).
fn key(path: &Path, params: &str) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    Ok(format!("{:016x}", crate::cache::stable_hash(&format!("{VERSION}|{}|{}|{mtime}|{params}", path.to_string_lossy(), meta.len()))))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Waveform {
    /// Peaks per second.
    rate: u32,
    /// Base64 of one byte per peak: max |sample| scaled to 0–255.
    peaks: String,
}

/// Peak envelope of a file's first audio stream.
#[tauri::command]
pub async fn media_waveform(app: AppHandle, path: String) -> Result<Waveform, String> {
    let src = PathBuf::from(&path);
    let out = visuals_dir(&app)?.join(format!("{}.peaks", key(&src, "wave")?));
    let bytes = if out.is_file() {
        std::fs::read(&out).map_err(|e| e.to_string())?
    } else {
        let bin = locate("ffmpeg").ok_or("ffmpeg not found")?;
        let peaks = tauri::async_runtime::spawn_blocking(move || {
            let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
            decode_peaks(&bin, &src)
        })
        .await
        .map_err(|e| e.to_string())??;
        let _ = std::fs::write(&out, &peaks);
        peaks
    };
    Ok(Waveform { rate: PEAKS_PER_SECOND, peaks: base64::engine::general_purpose::STANDARD.encode(bytes) })
}

fn decode_peaks(bin: &Path, src: &Path) -> Result<Vec<u8>, String> {
    let mut child = command(bin)
        .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-i"])
        .arg(src)
        .args(["-map", "0:a:0", "-vn", "-ac", "1", "-ar", &WAVE_RATE.to_string(), "-f", "s16le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start ffmpeg: {e}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let per_peak = (WAVE_RATE / PEAKS_PER_SECOND) as usize;
    let mut peaks = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    // Samples are 2 bytes and a read can end mid-sample, so bytes are paired up as they come.
    let mut low: Option<u8> = None;
    let (mut max, mut n) = (0i32, 0usize);
    loop {
        let read = stdout.read(&mut buf).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        for &b in &buf[..read] {
            let Some(lo) = low.take() else {
                low = Some(b);
                continue;
            };
            max = max.max((i16::from_le_bytes([lo, b]) as i32).abs());
            n += 1;
            if n == per_peak {
                peaks.push(((max * 255) / 32768).min(255) as u8);
                max = 0;
                n = 0;
            }
        }
    }
    if n > 0 {
        peaks.push(((max * 255) / 32768).min(255) as u8);
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() && peaks.is_empty() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut err);
        }
        return Err(err.lines().last().unwrap_or("no audio").to_string());
    }
    Ok(peaks)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thumbnails {
    /// JPEG sprite sheet (asset-protocol readable).
    path: String,
    /// Seconds between thumbnails (thumbnail i shows time i × interval).
    interval: f64,
    count: u32,
    cols: u32,
    tile_w: u32,
    tile_h: u32,
}

const TILE_H: u32 = 72;
const COLS: u32 = 16;
/// At most this many thumbnails per file (long recordings get sparser ones).
const MAX_THUMBS: f64 = 300.0;

/// A sprite sheet of thumbnails across a video. `hdr` ("PQ" | "HLG") tone maps.
#[tauri::command]
pub async fn media_thumbnails(app: AppHandle, path: String, duration: f64, aspect: f64, hdr: Option<String>) -> Result<Thumbnails, String> {
    let src = PathBuf::from(&path);
    if !(duration > 0.0) {
        return Err("unknown duration".into());
    }
    let interval = (duration / MAX_THUMBS).max(1.0);
    let count = ((duration / interval).ceil() as u32).max(1);
    let tile_w = ((TILE_H as f64 * aspect.clamp(0.25, 4.0) / 2.0).round() as u32 * 2).max(2);
    let rows = count.div_ceil(COLS);
    let out = visuals_dir(&app)?.join(format!("{}.jpg", key(&src, &format!("thumbs|{interval}|{tile_w}|{hdr:?}"))?));
    if !out.is_file() {
        let bin = locate("ffmpeg").ok_or("ffmpeg not found")?;
        let (out2, src2) = (out.clone(), src.clone());
        tauri::async_runtime::spawn_blocking(move || {
            let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
            let scale = format!("fps=1/{interval},scale={tile_w}:{TILE_H}:force_original_aspect_ratio=decrease,pad={tile_w}:{TILE_H}:(ow-iw)/2:(oh-ih)/2");
            let tile = format!("tile={COLS}x{rows}");
            let tonemap = hdr.as_deref().map(|h| {
                let tin = if h == "HLG" { "arib-std-b67" } else { "smpte2084" };
                format!(
                    "zscale=tin={tin}:min=bt2020nc:pin=bt2020:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
                )
            });
            // Tone mapped first; without zscale, plain (washed out) beats nothing.
            let filters: Vec<String> = match &tonemap {
                Some(tm) => vec![format!("{scale},{tm},{tile}"), format!("{scale},{tile}")],
                None => vec![format!("{scale},{tile}")],
            };
            let partial = out2.with_extension("partial.jpg");
            let mut last = String::new();
            for vf in filters {
                // Only keyframes are decoded: fast even for long, high-resolution recordings.
                let res = command(&bin)
                    .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-skip_frame", "nokey", "-i"])
                    .arg(&src2)
                    .args(["-an", "-sn", "-vf", &vf, "-frames:v", "1", "-q:v", "5", "-f", "image2"])
                    .arg(&partial)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped())
                    .output()
                    .map_err(|e| e.to_string())?;
                if res.status.success() && partial.is_file() {
                    return std::fs::rename(&partial, &out2).map_err(|e| e.to_string());
                }
                last = String::from_utf8_lossy(&res.stderr).lines().last().unwrap_or("").to_string();
            }
            let _ = std::fs::remove_file(&partial);
            Err(format!("thumbnails failed: {last}"))
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    app.asset_protocol_scope().allow_file(&out).map_err(|e| e.to_string())?;
    Ok(Thumbnails { path: out.to_string_lossy().into_owned(), interval, count, cols: COLS, tile_w, tile_h: TILE_H })
}
