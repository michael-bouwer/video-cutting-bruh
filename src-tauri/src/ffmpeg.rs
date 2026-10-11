//! Optional ffmpeg integration: locating the binaries, enriching probe results
//! via ffprobe, and generating preview proxies (H.264/AAC, optionally downscaled,
//! HDR tone-mapped to SDR) for files the system webview can't decode (e.g. HEVC
//! on Windows without the HEVC extension).
//!
//! Proxies use the fastest pipeline that works on this machine: Vulkan decode +
//! libplacebo + a hardware H.264 encoder, falling back step by step to CPU-only.
//!
//! ffmpeg isn't bundled; we look for a user install in the usual places for
//! each OS. GUI apps on macOS don't inherit the shell PATH, and on Windows a
//! fresh `winget install` only updates PATH for new processes, so well-known
//! install locations are searched explicitly.

use crate::probe::{ColorInfo, MediaProbe};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};

/// Bump when proxy encoding settings change, to invalidate cached proxies.
const PROXY_VERSION: u32 = 2;

fn exe(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(d) = std::env::var_os("VCB_FFMPEG_DIR") {
        dirs.push(PathBuf::from(d));
    }
    if let Some(d) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        dirs.push(d);
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            dirs.push(local.join(r"Microsoft\WinGet\Links"));
            // winget's Gyan.FFmpeg / BtbN packages unpack to Packages\<id>\ffmpeg-*\bin
            if let Ok(pkgs) = std::fs::read_dir(local.join(r"Microsoft\WinGet\Packages")) {
                for pkg in pkgs.flatten().filter(|e| e.file_name().to_string_lossy().to_lowercase().contains("ffmpeg")) {
                    if let Ok(inner) = std::fs::read_dir(pkg.path()) {
                        dirs.extend(inner.flatten().map(|e| e.path().join("bin")));
                    }
                }
            }
        }
        if let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
            dirs.push(home.join(r"scoop\shims"));
        }
        dirs.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin"));
        dirs.push(PathBuf::from(r"C:\ffmpeg\bin"));
    }
    #[cfg(target_os = "macos")]
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"].map(PathBuf::from));
    #[cfg(all(unix, not(target_os = "macos")))]
    dirs.extend(["/usr/bin", "/usr/local/bin", "/snap/bin"].map(PathBuf::from));
    dirs
}

pub fn locate(name: &str) -> Option<PathBuf> {
    let file = exe(name);
    candidate_dirs().into_iter().map(|d| d.join(&file)).find(|p| p.is_file())
}

pub(crate) fn command(bin: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

// ---------------------------------------------------------------------------
// Capabilities (detected once per run)
// ---------------------------------------------------------------------------

/// H.264 encoders in order of preference; the first that works is used.
const HW_ENCODERS: [&str; 4] = ["h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caps {
    /// libplacebo over Vulkan: GPU scaling + HDR tone mapping.
    gpu_filters: bool,
    /// H.264 encoder to use (hardware if one works, else libx264).
    encoder: String,
    /// zscale (libzimg): CPU fallback for HDR tone mapping.
    zscale: bool,
}

static CAPS: OnceLock<Caps> = OnceLock::new();

/// Runs a tiny synthetic encode to see whether a feature actually works on
/// this machine (an encoder being compiled in doesn't mean the GPU/driver has it).
pub(crate) fn works(bin: &Path, args: &[&str]) -> bool {
    command(bin)
        .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn caps(bin: &Path) -> Caps {
    CAPS.get_or_init(|| {
        let src = ["-f", "lavfi", "-i", "color=c=gray:s=640x360:r=30:d=0.2"];
        let encoder = HW_ENCODERS
            .iter()
            .find(|enc| {
                let mut a = src.to_vec();
                a.extend(["-pix_fmt", "yuv420p", "-c:v", enc, "-f", "null", "-"]);
                works(bin, &a)
            })
            .map(|e| e.to_string())
            .unwrap_or_else(|| "libx264".into());
        let gpu_filters = {
            let mut a = vec!["-init_hw_device", "vulkan=vk", "-filter_hw_device", "vk"];
            a.extend(src);
            a.extend(["-vf", "libplacebo=w=320:h=180:format=yuv420p", "-f", "null", "-"]);
            works(bin, &a)
        };
        let zscale = command(bin)
            .args(["-hide_banner", "-filters"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(" zscale "))
            .unwrap_or(false);
        Caps { gpu_filters, encoder, zscale }
    })
    .clone()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    available: bool,
    path: Option<String>,
    version: Option<String>,
    /// Whether HDR → SDR tone mapping is possible at all (GPU or CPU).
    can_tonemap: bool,
    caps: Option<Caps>,
}

#[tauri::command]
pub async fn ffmpeg_status() -> FfmpegStatus {
    let none = || FfmpegStatus { available: false, path: None, version: None, can_tonemap: false, caps: None };
    tauri::async_runtime::spawn_blocking(move || {
        let Some(bin) = locate("ffmpeg") else { return none() };
        let version = command(&bin)
            .arg("-version")
            .output()
            .ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).lines().next().map(str::to_string));
        if version.is_none() {
            return none();
        }
        let caps = caps(&bin);
        FfmpegStatus {
            available: true,
            path: Some(bin.to_string_lossy().into_owned()),
            version,
            can_tonemap: caps.gpu_filters || caps.zscale,
            caps: Some(caps),
        }
    })
    .await
    .unwrap_or_else(|_| none())
}

// ---------------------------------------------------------------------------
// ffprobe enrichment
// ---------------------------------------------------------------------------

/// Fills in colour info the container didn't declare. Some encoders (e.g.
/// NVIDIA ShadowPlay) only signal HDR in the HEVC bitstream's VUI, which the
/// container-level probe doesn't parse.
pub fn enrich_with_ffprobe(probe: &mut MediaProbe) {
    let Some(bin) = locate("ffprobe") else { return };
    if probe.has_audio.is_none() {
        probe.has_audio = command(&bin)
            .args(["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0"])
            .arg(&probe.path)
            .output()
            .ok()
            .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty());
    }
    let has_transfer = probe.color.as_ref().is_some_and(|c| c.transfer.is_some());
    if has_transfer {
        return;
    }
    let Ok(out) = command(&bin)
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,pix_fmt,color_transfer,color_primaries,color_space,color_range",
            "-of", "json",
        ])
        .arg(&probe.path)
        .output()
    else {
        return;
    };
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else { return };
    let Some(s) = json["streams"].get(0) else { return };
    let field = |k: &str| s[k].as_str().unwrap_or("");

    let color = ColorInfo {
        primaries: match field("color_primaries") {
            "bt709" => Some(1),
            "smpte170m" => Some(6),
            "bt2020" => Some(9),
            "smpte432" => Some(12),
            _ => None,
        },
        transfer: match field("color_transfer") {
            "bt709" => Some(1),
            "smpte170m" => Some(6),
            "iec61966-2-1" => Some(13),
            "bt2020-10" => Some(14),
            "smpte2084" => Some(16),
            "arib-std-b67" => Some(18),
            _ => None,
        },
        matrix: match field("color_space") {
            "bt709" => Some(1),
            "smpte170m" => Some(6),
            "bt2020nc" => Some(9),
            "bt2020c" => Some(10),
            _ => None,
        },
        full_range: match field("color_range") {
            "pc" => Some(true),
            "tv" => Some(false),
            _ => None,
        },
    };
    if color != ColorInfo::default() {
        probe.color = Some(color);
    }
    let pix = field("pix_fmt");
    if probe.bit_depth.is_none() && !pix.is_empty() {
        probe.bit_depth = Some(if pix.contains("12") { 12 } else if pix.contains("10") || pix == "p010le" { 10 } else { 8 });
    }
    if probe.video_codec.is_none() && !field("codec_name").is_empty() {
        probe.video_codec = Some(field("codec_name").to_string());
    }
}

// ---------------------------------------------------------------------------
// Proxies
// ---------------------------------------------------------------------------

/// Running proxy encodes, keyed by job id (unique per attempt), so they can be cancelled.
#[derive(Default)]
pub struct ProxyJobs(Mutex<HashMap<String, Child>>);

impl ProxyJobs {
    pub fn running(&self) -> bool {
        !self.0.lock().unwrap().is_empty()
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProxyProgress {
    job: String,
    progress: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyResult {
    path: String,
    /// Human-readable description of how it was made, e.g. "GPU (Vulkan) · h264_nvenc".
    method: String,
}

fn proxy_path(
    app: &AppHandle,
    project_path: Option<&str>,
    src: &Path,
    tonemap: Option<&str>,
    max_height: Option<u32>,
) -> Result<PathBuf, String> {
    let meta = std::fs::metadata(src).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    let key = format!("{PROXY_VERSION}|{}|{}|{mtime}|{tonemap:?}|{max_height:?}", src.to_string_lossy(), meta.len());
    let dir = crate::cache::proxy_dir(app, project_path)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{:016x}.mp4", crate::cache::stable_hash(&key))))
}

/// Input transfer function for tone mapping, if the clip is HDR.
fn hdr_transfer(tonemap: Option<&str>) -> Option<&'static str> {
    match tonemap {
        Some("HLG") => Some("arib-std-b67"),
        Some(_) => Some("smpte2084"),
        None => None,
    }
}

// Drop frames first (120 fps game captures don't need more than 60 for
// previewing) so the expensive filters below process fewer of them.
const FPS_CAP: &str = "fps=fps='min(source_fps,60)'";

fn height_expr(max_height: Option<u32>) -> String {
    max_height.map_or("ih".into(), |h| format!("'min({h},ih)'"))
}

/// libplacebo: GPU scaling and (for HDR) BT.2390 tone mapping to BT.709 SDR.
fn placebo_filter(tonemap: Option<&str>, max_height: Option<u32>) -> String {
    let tm = if tonemap.is_some() { ":tonemapping=bt.2390" } else { "" };
    format!(
        "libplacebo=w=-2:h={}{tm}:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p",
        height_expr(max_height)
    )
}

/// CPU fallback: swscale + zimg tone mapping (much slower at high resolutions).
fn cpu_filter(tonemap: Option<&str>, max_height: Option<u32>, zscale: bool) -> String {
    let scale = format!("scale=-2:{}", height_expr(max_height));
    match hdr_transfer(tonemap) {
        Some(tin) if zscale => format!(
            "{scale},zscale=tin={tin}:min=bt2020nc:pin=bt2020:t=linear:npl=100,format=gbrpf32le,\
             zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
        ),
        _ => format!("{scale},format=yuv420p"),
    }
}

/// Peak bitrate for a proxy of the given height: plenty for a sharp preview,
/// without multi-GB files (game footage at constant quality can hit 70+ Mbps).
fn max_bitrate_mbps(height: u32) -> u32 {
    (height as f32 / 60.0).round().clamp(6.0, 40.0) as u32
}

fn encoder_args(encoder: &str, height: u32) -> Vec<String> {
    let max = max_bitrate_mbps(height);
    let (maxrate, bufsize, avg) = (format!("{max}M"), format!("{}M", max * 2), format!("{}M", max * 6 / 10));
    // Short GOP keeps scrubbing snappy in the preview.
    let mut a: Vec<String> = ["-g", "15", "-bf", "0", "-pix_fmt", "yuv420p"].map(String::from).to_vec();
    let enc: Vec<&str> = match encoder {
        "h264_nvenc" => vec!["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "24", "-b:v", "0", "-maxrate", &maxrate, "-bufsize", &bufsize],
        "h264_qsv" => vec!["-c:v", "h264_qsv", "-preset", "faster", "-global_quality", "24", "-maxrate", &maxrate, "-bufsize", &bufsize],
        "h264_amf" => vec!["-c:v", "h264_amf", "-quality", "speed", "-rc", "vbr_peak", "-b:v", &avg, "-maxrate", &maxrate, "-bufsize", &bufsize],
        "h264_videotoolbox" => vec!["-c:v", "h264_videotoolbox", "-b:v", &avg, "-maxrate", &maxrate, "-bufsize", &bufsize, "-allow_sw", "1"],
        _ => vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", &maxrate, "-bufsize", &bufsize, "-tune", "fastdecode"],
    };
    a.extend(enc.into_iter().map(String::from));
    a
}

struct Pipeline {
    label: String,
    /// Arguments before `-i`.
    input: Vec<String>,
    vf: String,
    encoder: String,
}

/// Fastest first; each is tried in turn if the previous one fails.
fn pipelines(caps: &Caps, tonemap: Option<&str>, max_height: Option<u32>) -> Vec<Pipeline> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let vk = ["-init_hw_device", "vulkan=vk", "-filter_hw_device", "vk"];
    let mut out = Vec::new();
    if caps.gpu_filters {
        // Decode, filter and download entirely on the GPU via Vulkan video.
        out.push(Pipeline {
            label: format!("GPU (Vulkan) · {}", caps.encoder),
            input: s(&[&vk[..], &["-hwaccel", "vulkan", "-hwaccel_output_format", "vulkan"]].concat()),
            vf: format!("{FPS_CAP},{},hwdownload,format=yuv420p", placebo_filter(tonemap, max_height)),
            encoder: caps.encoder.clone(),
        });
        // Platform decoder, GPU filtering.
        out.push(Pipeline {
            label: format!("GPU filters · {}", caps.encoder),
            input: s(&[&vk[..], &["-hwaccel", "auto"]].concat()),
            vf: format!("{FPS_CAP},{}", placebo_filter(tonemap, max_height)),
            encoder: caps.encoder.clone(),
        });
    }
    out.push(Pipeline {
        label: format!("CPU · {}", caps.encoder),
        input: s(&["-hwaccel", "auto"]),
        vf: format!("{FPS_CAP},{}", cpu_filter(tonemap, max_height, caps.zscale)),
        encoder: caps.encoder.clone(),
    });
    if caps.encoder != "libx264" {
        // Last resort in case the hardware encoder rejects this input.
        out.push(Pipeline {
            label: "CPU · libx264".into(),
            input: s(&["-hwaccel", "auto"]),
            vf: format!("{FPS_CAP},{}", cpu_filter(tonemap, max_height, caps.zscale)),
            encoder: "libx264".into(),
        });
    }
    out
}

enum RunError {
    Cancelled,
    Failed(String),
}

/// Runs one ffmpeg encode, emitting progress, cancellable via `cancel_proxy(job)`.
#[allow(clippy::too_many_arguments)]
async fn run_encode(
    app: &AppHandle,
    jobs: &ProxyJobs,
    job: &str,
    bin: &Path,
    src: &Path,
    out: &Path,
    p: &Pipeline,
    duration: Option<f64>,
    height: u32,
) -> Result<(), RunError> {
    let mut child = command(bin)
        .args(["-hide_banner", "-nostats", "-nostdin", "-y"])
        .args(&p.input)
        .arg("-i")
        .arg(src)
        .args(["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"])
        .args(["-vf", &p.vf])
        .args(encoder_args(&p.encoder, height))
        .args(["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"])
        .args(["-c:a", "aac", "-b:a", "160k", "-ac", "2"])
        .args(["-movflags", "+faststart", "-progress", "pipe:1"])
        .arg(out)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| RunError::Failed(format!("Could not start ffmpeg: {e}")))?;

    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    jobs.0.lock().unwrap().insert(job.to_string(), child);

    // Drain stderr concurrently so ffmpeg never blocks on a full pipe.
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let app2 = app.clone();
    let job2 = job.to_string();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let total_us = duration.filter(|d| *d > 0.0).map(|d| d * 1_000_000.0);
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let (Some(v), Some(total)) = (line.strip_prefix("out_time_us="), total_us) {
                if let Ok(us) = v.trim().parse::<f64>() {
                    let progress = (us / total).clamp(0.0, 1.0);
                    let _ = app2.emit("proxy-progress", ProxyProgress { job: job2.clone(), progress });
                }
            }
        }
    })
    .await;

    // A missing entry means `cancel_proxy` already killed and removed it.
    let child = jobs.0.lock().unwrap().remove(job);
    let stderr_text = err_reader.join().unwrap_or_default();
    let Some(mut child) = child else { return Err(RunError::Cancelled) };
    let status = child.wait().map_err(|e| RunError::Failed(e.to_string()))?;
    if status.success() {
        return Ok(());
    }
    let tail: Vec<&str> = stderr_text.lines().filter(|l| !l.trim().is_empty()).rev().take(3).collect();
    Err(RunError::Failed(tail.into_iter().rev().collect::<Vec<_>>().join(" | ")))
}

/// Creates (or reuses a cached) preview proxy for `path`.
/// `max_height`: None keeps the source resolution.
/// Emits `proxy-progress` events (`{ job, progress: 0..1 }`) while encoding.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_proxy(
    app: AppHandle,
    jobs: State<'_, ProxyJobs>,
    job: String,
    path: String,
    duration: Option<f64>,
    tonemap: Option<String>,
    max_height: Option<u32>,
    source_height: Option<u32>,
    project_path: Option<String>,
) -> Result<ProxyResult, String> {
    let src = PathBuf::from(&path);
    let tonemap = tonemap.as_deref();
    let out = proxy_path(&app, project_path.as_deref(), &src, tonemap, max_height)?;
    if out.is_file() {
        app.asset_protocol_scope().allow_file(&out).map_err(|e| e.to_string())?;
        return Ok(ProxyResult { path: out.to_string_lossy().into_owned(), method: "cached".into() });
    }

    let bin = locate("ffmpeg").ok_or("ffmpeg not found")?;
    let caps = {
        let b = bin.clone();
        tauri::async_runtime::spawn_blocking(move || caps(&b)).await.map_err(|e| e.to_string())?
    };
    let partial = out.with_extension("partial.mp4");
    let height = match (max_height, source_height) {
        (Some(m), Some(s)) => m.min(s),
        (m, s) => m.or(s).unwrap_or(1080),
    };

    let mut errors = Vec::new();
    for p in pipelines(&caps, tonemap, max_height) {
        let _ = app.emit("proxy-progress", ProxyProgress { job: job.clone(), progress: 0.0 });
        match run_encode(&app, &jobs, &job, &bin, &src, &partial, &p, duration, height).await {
            Ok(()) => {
                std::fs::rename(&partial, &out).map_err(|e| e.to_string())?;
                app.asset_protocol_scope().allow_file(&out).map_err(|e| e.to_string())?;
                return Ok(ProxyResult { path: out.to_string_lossy().into_owned(), method: p.label });
            }
            Err(RunError::Cancelled) => {
                let _ = std::fs::remove_file(&partial);
                return Err("cancelled".into());
            }
            Err(RunError::Failed(e)) => {
                let _ = std::fs::remove_file(&partial);
                errors.push(format!("{}: {e}", p.label));
            }
        }
    }
    Err(format!("ffmpeg failed — {}", errors.join(" ; ")))
}

#[tauri::command]
pub fn cancel_proxy(jobs: State<'_, ProxyJobs>, job: String) {
    if let Some(mut child) = jobs.0.lock().unwrap().remove(&job) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Kill any running encodes when the app exits.
pub fn kill_all(app: &AppHandle) {
    if let Some(jobs) = app.try_state::<ProxyJobs>() {
        for (_, mut child) in jobs.0.lock().unwrap().drain() {
            let _ = child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(gpu: bool, zscale: bool) -> Caps {
        Caps { gpu_filters: gpu, encoder: "h264_nvenc".into(), zscale }
    }

    #[test]
    fn gpu_pipelines_come_first_and_tonemap_hdr() {
        let p = pipelines(&caps(true, true), Some("PQ"), Some(1080));
        assert_eq!(p.len(), 4);
        assert!(p[0].vf.contains("libplacebo") && p[0].vf.contains("tonemapping=bt.2390") && p[0].vf.contains("hwdownload"));
        assert!(p[0].vf.contains("h='min(1080,ih)'"));
        assert!(p[2].vf.contains("zscale=tin=smpte2084"));
        assert_eq!(p[3].encoder, "libx264");
    }

    #[test]
    fn sdr_and_full_resolution() {
        let p = pipelines(&caps(true, true), None, None);
        assert!(!p[0].vf.contains("tonemapping"));
        assert!(p[0].vf.contains("h=ih"));
        assert!(!p[2].vf.contains("zscale"));
    }

    #[test]
    fn bitrate_scales_with_height() {
        assert_eq!(max_bitrate_mbps(720), 12);
        assert_eq!(max_bitrate_mbps(1440), 24);
        assert_eq!(max_bitrate_mbps(4320), 40);
        let a = encoder_args("h264_nvenc", 1440);
        assert!(a.windows(2).any(|w| w[0] == "-maxrate" && w[1] == "24M"));
    }

    #[test]
    fn cpu_only_without_vulkan_or_zscale() {
        let p = pipelines(&caps(false, false), Some("HLG"), Some(720));
        assert!(p.iter().all(|x| !x.vf.contains("libplacebo")));
        assert!(!p[0].vf.contains("zscale"));
    }
}
