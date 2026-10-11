//! Export: the frontend renders each frame with the preview engine and streams
//! raw RGBA pixels here; we pipe them into ffmpeg, which encodes them (plus an
//! audio mix rendered by the frontend) into the output file.
//!
//! Flow: `export_encoders` → (`export_audio_segment`… → `export_save_audio`) →
//! `export_begin` → `export_frame` × N → `export_end` (or `export_cancel`).

use crate::ffmpeg::{command, locate, works};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Manager, State};

// ---- Encoder detection ---------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EncoderInfo {
    /// "h264" | "hevc" | "av1"
    codec: String,
    encoder: String,
    hardware: bool,
}

const CANDIDATES: [(&str, &[&str], &[&str]); 3] = [
    ("h264", &["h264_nvenc", "h264_amf", "h264_qsv", "h264_videotoolbox"], &["libx264"]),
    ("hevc", &["hevc_nvenc", "hevc_amf", "hevc_qsv", "hevc_videotoolbox"], &["libx265"]),
    ("av1", &["av1_nvenc", "av1_amf", "av1_qsv"], &["libsvtav1", "libaom-av1"]),
];

static ENCODERS: OnceLock<Vec<EncoderInfo>> = OnceLock::new();

/// The best working encoder per codec (hardware first), detected with a tiny test encode.
fn detect(bin: &Path) -> Vec<EncoderInfo> {
    ENCODERS
        .get_or_init(|| {
            let test = |enc: &str| {
                works(
                    bin,
                    &["-f", "lavfi", "-i", "color=c=gray:s=640x360:r=30:d=0.2", "-pix_fmt", "yuv420p", "-c:v", enc, "-f", "null", "-"],
                )
            };
            let mut out = Vec::new();
            for (codec, hw, sw) in CANDIDATES {
                if let Some(e) = hw.iter().find(|e| test(e)) {
                    out.push(EncoderInfo { codec: codec.into(), encoder: e.to_string(), hardware: true });
                } else if let Some(e) = sw.iter().find(|e| test(e)) {
                    out.push(EncoderInfo { codec: codec.into(), encoder: e.to_string(), hardware: false });
                }
            }
            out
        })
        .clone()
}

#[tauri::command]
pub async fn export_encoders() -> Result<Vec<EncoderInfo>, String> {
    let bin = locate("ffmpeg").ok_or("ffmpeg not found")?;
    tauri::async_runtime::spawn_blocking(move || detect(&bin)).await.map_err(|e| e.to_string())
}

/// Encoder arguments for a quality level ("high" | "balanced" | "small").
fn encoder_args(encoder: &str, codec: &str, quality: &str) -> Vec<String> {
    let q = |h: u32, b: u32, s: u32| match quality {
        "high" => h,
        "small" => s,
        _ => b,
    };
    let crf = match codec {
        "hevc" => q(20, 24, 29),
        "av1" => q(24, 31, 38),
        _ => q(18, 22, 27),
    };
    let mut a: Vec<String> = vec!["-c:v".into(), encoder.into()];
    let push = |a: &mut Vec<String>, xs: &[&str]| a.extend(xs.iter().map(|s| s.to_string()));
    match encoder {
        e if e.ends_with("_nvenc") => push(&mut a, &["-preset", "p5", "-rc", "vbr", "-cq", &crf.to_string(), "-b:v", "0"]),
        e if e.ends_with("_amf") => push(&mut a, &["-quality", "quality", "-rc", "cqp", "-qp_i", &crf.to_string(), "-qp_p", &crf.to_string()]),
        e if e.ends_with("_qsv") => push(&mut a, &["-preset", "medium", "-global_quality", &crf.to_string()]),
        e if e.ends_with("_videotoolbox") => push(&mut a, &["-q:v", &q(70, 55, 40).to_string()]),
        "libx264" => push(&mut a, &["-preset", "medium", "-crf", &crf.to_string()]),
        "libx265" => push(&mut a, &["-preset", "medium", "-crf", &crf.to_string()]),
        "libsvtav1" => push(&mut a, &["-preset", "8", "-crf", &crf.to_string()]),
        "libaom-av1" => push(&mut a, &["-cpu-used", "6", "-crf", &crf.to_string(), "-b:v", "0"]),
        _ => {}
    }
    // Apple players need the hvc1 tag for HEVC in MP4.
    if codec == "hevc" {
        push(&mut a, &["-tag:v", "hvc1"]);
    }
    a
}

// ---- Audio -------------------------------------------------------------------------------

fn export_temp_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("export");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Decodes `[start, start+duration)` of a file's audio to a 48 kHz stereo WAV the
/// frontend can load (only the part the clip uses, so long recordings stay small).
#[tauri::command]
pub async fn export_audio_segment(app: AppHandle, path: String, start: f64, duration: f64) -> Result<String, String> {
    let bin = locate("ffmpeg").ok_or("ffmpeg not found")?;
    let out = export_temp_dir(&app)?.join(format!("seg-{}.wav", crate::cache::stable_hash(&format!("{path}|{start}|{duration}"))));
    let out2 = out.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        command(&bin)
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", &format!("{start:.6}"), "-t", &format!("{duration:.6}"), "-i"])
            .arg(&path)
            .args(["-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le"])
            .arg(&out2)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if !status.status.success() || !out.is_file() {
        // No audio stream (or unreadable): the caller treats this clip as silent.
        return Err(String::from_utf8_lossy(&status.stderr).lines().last().unwrap_or("no audio").to_string());
    }
    app.asset_protocol_scope().allow_file(&out).map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().into_owned())
}

/// Stores the frontend's rendered audio mix (a WAV file sent as raw bytes).
#[tauri::command]
pub async fn export_save_audio(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected WAV bytes".into());
    };
    let dir = export_temp_dir(&app)?;
    let path = dir.join(format!("mix-{}.wav", std::process::id()));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    // The per-clip segments were only needed to build this mix.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with("seg-") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(path.to_string_lossy().into_owned())
}

// ---- Video ---------------------------------------------------------------------------------

struct ExportJob {
    child: Child,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    stderr: Arc<Mutex<String>>,
    partial: PathBuf,
    out: PathBuf,
    temp: Vec<PathBuf>,
}

#[derive(Default)]
pub struct ExportJobs(Mutex<HashMap<String, ExportJob>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    path: String,
    width: u32,
    height: u32,
    fps: f64,
    encoder: String,
    codec: String,
    quality: String,
    audio_path: Option<String>,
}

#[tauri::command]
pub fn export_begin(jobs: State<'_, ExportJobs>, opts: ExportOptions) -> Result<String, String> {
    let bin = locate("ffmpeg").ok_or("ffmpeg not found")?;
    let out = PathBuf::from(&opts.path);
    let ext = out.extension().and_then(|e| e.to_str()).unwrap_or("mp4").to_string();
    // Write to a temporary name so a cancelled/failed export never leaves a broken file behind.
    let partial = out.with_extension(format!("partial.{ext}"));
    if opts.width % 2 == 1 || opts.height % 2 == 1 {
        return Err("Width and height must be even".into());
    }

    let mut cmd = command(&bin);
    cmd.args(["-hide_banner", "-nostats", "-loglevel", "error", "-y"])
        .args(["-f", "rawvideo", "-pix_fmt", "rgba", "-s", &format!("{}x{}", opts.width, opts.height)])
        .args(["-framerate", &format!("{}", opts.fps), "-i", "pipe:0"]);
    if let Some(a) = &opts.audio_path {
        cmd.arg("-i").arg(a);
    }
    cmd.args(["-map", "0:v:0"]);
    if opts.audio_path.is_some() {
        cmd.args(["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]);
    }
    // The canvas is sRGB; tag the output as standard BT.709 SDR.
    cmd.args(["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"])
        .args(encoder_args(&opts.encoder, &opts.codec, &opts.quality))
        .args(["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"])
        .args(["-movflags", "+faststart"])
        .arg(&partial)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Could not start ffmpeg: {e}"))?;
    let stdin = child.stdin.take();
    let mut err = child.stderr.take().unwrap();
    let stderr = Arc::new(Mutex::new(String::new()));
    let sink = stderr.clone();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        *sink.lock().unwrap() = s;
    });

    let id = format!("{:x}", crate::cache::stable_hash(&format!("{}|{:?}", opts.path, std::time::SystemTime::now())));
    let temp = opts.audio_path.iter().map(PathBuf::from).collect();
    jobs.0.lock().unwrap().insert(
        id.clone(),
        ExportJob { child, stdin: Arc::new(Mutex::new(stdin)), stderr, partial, out, temp },
    );
    Ok(id)
}

/// One RGBA frame (raw request body), for the export named in the `x-export-id` header.
#[tauri::command]
pub async fn export_frame(jobs: State<'_, ExportJobs>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let id = request
        .headers()
        .get("x-export-id")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing export id")?
        .to_string();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw frame bytes".into());
    };
    let bytes = bytes.clone();
    let (stdin, stderr) = {
        let map = jobs.0.lock().unwrap();
        let job = map.get(&id).ok_or("export not running")?;
        (job.stdin.clone(), job.stderr.clone())
    };
    // Writing blocks while ffmpeg catches up (natural back-pressure), so do it off the async runtime.
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = stdin.lock().unwrap();
        let pipe = guard.as_mut().ok_or("export already finished")?;
        pipe.write_all(&bytes).map_err(|e| {
            let detail = stderr.lock().unwrap().lines().last().unwrap_or("").to_string();
            format!("ffmpeg stopped accepting frames: {e}. {detail}")
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn cleanup(job: &ExportJob) {
    for t in &job.temp {
        let _ = std::fs::remove_file(t);
    }
}

/// Finishes encoding and returns the output path.
#[tauri::command]
pub async fn export_end(jobs: State<'_, ExportJobs>, id: String) -> Result<String, String> {
    let mut job = jobs.0.lock().unwrap().remove(&id).ok_or("export not running")?;
    // Closing stdin tells ffmpeg the video has ended.
    job.stdin.lock().unwrap().take();
    let job = tauri::async_runtime::spawn_blocking(move || {
        let status = job.child.wait();
        (job, status)
    })
    .await
    .map_err(|e| e.to_string())?;
    let (job, status) = job;
    cleanup(&job);
    let ok = status.map(|s| s.success()).unwrap_or(false);
    if !ok {
        let _ = std::fs::remove_file(&job.partial);
        // stderr is collected by a thread; give it a moment to finish.
        std::thread::sleep(std::time::Duration::from_millis(50));
        let err = job.stderr.lock().unwrap().clone();
        let tail: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).rev().take(3).collect();
        return Err(format!("ffmpeg failed: {}", tail.into_iter().rev().collect::<Vec<_>>().join(" | ")));
    }
    if job.out.exists() {
        std::fs::remove_file(&job.out).map_err(|e| format!("Couldn't replace the existing file: {e}"))?;
    }
    std::fs::rename(&job.partial, &job.out).map_err(|e| e.to_string())?;
    Ok(job.out.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn export_cancel(jobs: State<'_, ExportJobs>, id: String) {
    if let Some(mut job) = jobs.0.lock().unwrap().remove(&id) {
        job.stdin.lock().unwrap().take();
        let _ = job.child.kill();
        let _ = job.child.wait();
        let _ = std::fs::remove_file(&job.partial);
        cleanup(&job);
    }
}

/// Kill running exports when the app exits.
pub fn kill_all(app: &AppHandle) {
    if let Some(jobs) = app.try_state::<ExportJobs>() {
        for (_, mut job) in jobs.0.lock().unwrap().drain() {
            let _ = job.child.kill();
            let _ = std::fs::remove_file(&job.partial);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hevc_gets_hvc1_tag_and_quality_maps() {
        let a = encoder_args("hevc_nvenc", "hevc", "high");
        assert!(a.windows(2).any(|w| w[0] == "-cq" && w[1] == "20"));
        assert!(a.windows(2).any(|w| w[0] == "-tag:v" && w[1] == "hvc1"));
        let x = encoder_args("libx264", "h264", "small");
        assert!(x.windows(2).any(|w| w[0] == "-crf" && w[1] == "27"));
    }
}
