# video-cutting-bruh

A cross-platform (Windows / macOS / Linux) video editor built with Tauri 2 + React + TypeScript.

## Features (so far)

- **Drag & drop import** of videos (mp4, mov, m4v, webm, mkv) and still images (png, jpg, webp, gif, bmp, avif). Drop on the timeline to append clips, or anywhere else to add files to the media bin. Images become 5 s clips you can trim to any length.
- **Media bin:**
  - Files are grouped by type: *Needs attention* (missing or unplayable), *HDR video*, *Video* and *Images*. You can filter by type with the chips, search by name, sort by date added, name, length or file size, and collapse groups.
  - Three views: **Thumbnails**, **List** and **Details** (a table of length, resolution, format, color, file size and usage). The view choice is remembered.
  - Drag items onto the timeline to insert them at a specific spot (Esc cancels), or double-click / **+** to append.
- **HDR detection + "Allow HDR" toggle.** Each file is probed in Rust with no ffmpeg needed. The probe reads the MP4/MOV `colr`/`hvcC`/`dvcC`/`mdcv` boxes and the Matroska `Colour` elements, and classifies the file as HDR10 (PQ), HLG or Dolby Vision. HDR clips, such as phone footage shot with HDR on, are rejected unless **Allow HDR** is enabled. With it on, the preview canvas uses `display-p3` where the webview supports it.
- **Preview proxies (optional ffmpeg).** If ffmpeg is installed, the app converts files the system webview can't play into an H.264 preview copy (a proxy), e.g. HEVC on Windows without the HEVC extension. HDR clips get one too, tone-mapped properly to SDR.
  - **Quality:** full source resolution by default, or 1080p / 720p, up to 60 fps, with the bitrate capped by resolution.
  - **Speed:** it uses the fastest pipeline that works on the machine. The best case is Vulkan decode + libplacebo tone mapping + a hardware encoder (NVENC / QSV / AMF / VideoToolbox); it falls back step by step to CPU-only (zscale + x264).
  - You can keep editing while a proxy encodes, and export always uses the original file. Proxies are stored in the project's `vcb-cache` folder (see Projects).
  - Settings are under ⚙ → Preview proxies: mode auto / always / off, and quality.
  - Install ffmpeg: `winget install Gyan.FFmpeg` · `brew install ffmpeg` · `sudo apt install ffmpeg`
  - The app also checks the usual install folders (winget, scoop, choco, Homebrew), because GUI apps don't always see the shell `PATH`. To point it at a specific install, set `VCB_FFMPEG_DIR`.
  - With ffprobe installed, HDR is also detected when it's only declared inside the video stream, as NVIDIA ShadowPlay does.
- **Multi-track timeline:**
  - **Tracks:** video tracks (V1, V2…; higher ones are drawn on top) and audio tracks (A1, A2…; mixed together). Each track can be hidden, muted, soloed (audio), locked or deleted. Add tracks with **+ Video / + Audio**, or by dropping onto the "new track" strip that appears while dragging.
  - **Free placement:** clips start wherever you drop them, and gaps play as black and silence. Clips on one track never overlap; a drop that would overlap slides to the nearest free gap. Drag up or down to move a clip to another track of the same kind.
  - **Snapping:** clips snap to other clip edges, the playhead and 0. Toggle it with ⊞, or hold Alt (⌥) while dragging.
  - **Trimming:** dragging an edge trims the clip. Dragging it back restores the trimmed footage, up to the length of the source file; stills can be stretched to any length.
  - **Linked audio:** a video with sound becomes a video clip and an audio clip, linked (⛓). Linked clips move, trim, split and delete together. If the audio's track is busy, the audio moves to another audio track with room. Use **Unlink** in the inspector to edit them separately, or Shift+Delete to remove just one.
  - **Audio clips:** keyframeable volume, fade-in and fade-out (drag the handles at the top corners), plus track mute and solo. Audio files (mp3, wav, m4a, aac, flac, ogg, opus) can be imported too.
- **Transitions:** crossfade, dip to black, wipe left/right, slide left/up, iris. They apply where two clips touch on a video track (click ⧉ on the cut) and are centred on the cut, using footage beyond each clip's trim points where the file has it.
- **Keyframes:** position X/Y, scale, rotation and opacity (video) and volume (audio), with linear, ease in/out/in-out and hold easing.
  - Click ◆ to keyframe a property at the playhead.
  - Once a property has keyframes, editing its value writes a keyframe.
  - You can drag the preview to move the selected clip.
- **Editing:** split at the playhead (`S`): the selected clip and its link, or everything under the playhead. Duplicate (Ctrl/⌘+D), delete (Del).

- **Projects:** New / Open / Save / Save As (`.vcbproj`, JSON), plus recent projects in the File menu and on the start screen.
  - **New project…** creates a folder for the project:
    ```
    <location>/<name>/<name>.vcbproj
    <location>/<name>/vcb-cache/proxies/   ← preview copies
    ```
    Your source videos stay where they are.
  - Unsaved ("Untitled") projects keep their preview copies in a temporary app cache. On save, those copies move into the project's `vcb-cache` folder.
  - ⚙ → Storage shows where the cache is and how big it is, with Show, Remove unused and Clear temporary cache.
  - When you open a project, any file that moved is looked for next to the project file. Files that still can't be found show as *Missing* and can be relinked.
  - You're asked before unsaved changes are lost: closing the window, New, or Open.
  - Unsaved work is autosaved every 15 s. If the app crashes, you're offered to recover it on the next start.
  - The window title shows the project name, with • when there are unsaved changes.
- **Day / night theme:** pick System, Day or Night from the toolbar (◐ / ☀ / ☾). System follows the OS and switches live, and the native title bar matches. The choice is remembered per device.
- **Undo / redo** for all timeline edits. A drag or slider gesture counts as one step.
- **Layout:** the side panels and the timeline resize by dragging the dividers (double-click the timeline divider to reset), and the sizes are remembered.
  - Every region is clamped, so the UI always fits the window and the preview never collapses.
  - The window remembers its size and position. At startup it's moved and resized onto a connected monitor, e.g. after unplugging a screen.

| Shortcut | Action |
| --- | --- |
| Space | Play / pause |
| S | Split at playhead |
| K | Keyframe all transform props on the selected clip |
| Del / Backspace | Delete selected clip / remove transition |
| ← / → | Step one frame (Shift: 1 second) |
| Home / End | Jump to start / end |
| Ctrl/⌘+Z, Ctrl/⌘+Shift+Z (or Ctrl+Y) | Undo / redo |
| Ctrl/⌘+D | Duplicate selected clip |
| `\` | Zoom timeline to fit |
| Ctrl/⌘+N / O / S / Shift+S | New / Open / Save / Save as |
| Ctrl/⌘+I | Import media |

## Development

```bash
pnpm install
pnpm tauri dev
```

`pnpm dev` also runs the UI in a plain browser. It falls back to HTML5 drag & drop and blob URLs, and skips HDR probing.

Rust probe tests: `cd src-tauri && cargo test`

## Architecture

```
src/
  types.ts             data model (MediaItem, Clip, Keyframe, Transition…)
  store.ts             zustand store + all editing actions
  engine/player.ts     preview engine: one <video> per clip, clock sync, canvas compositing
  lib/timeline.ts      clip layout (transitions = overlap), frame lookup, timecode
  lib/keyframes.ts     interpolation + easing
  lib/props.ts         registry of animatable properties  ← add new keyframeable props here
  lib/transitions.ts   transition renderers               ← add new transitions here
  lib/mediaDrag.ts     dragging media from the bin onto the timeline (pointer-based)
  lib/media.ts         import pipeline (Tauri paths / browser files), proxies, project media restore, relink
  lib/project.ts       project files, recents, dirty tracking, autosave/recovery, close guard, window title
  lib/history.ts       undo/redo (watches clip edits, coalesces gestures)
  lib/layout.ts        resizable panel sizes
  components/          Toolbar, MediaBin, Preview, Inspector, Timeline, Notices
src-tauri/src/
  lib.rs               `import_media` command: grants asset-protocol access per file, probes it
  probe.rs             dependency-free MP4/MOV/MKV probe (codec, size, duration, bit depth, colour, HDR)
  project.rs           project read/write (atomic), autosave, keep window on screen
  cache.rs             where proxies live (project folder vs temporary), cache info/cleanup, moving on save
  ffmpeg.rs            optional ffmpeg: locate binaries, ffprobe colour fallback, proxy encoding + cancel
```

The timeline has any number of video and audio tracks. Clips have an absolute `start`, and clips on the same track never overlap. A transition belongs to the clip after a cut: when two clips touch, it blends them over a window centred on the cut. Video tracks are composited bottom-up, and audio tracks are mixed (clip volume × fades × mute/solo). Projects saved in format v1 (single track) are converted when opened.

## Cross-platform notes

Playback uses each OS's system webview, so codec support depends on the platform:

| | Windows (WebView2) | macOS (WKWebView) | Linux (WebKitGTK) |
| --- | --- | --- | --- |
| H.264 | ✅ | ✅ | needs GStreamer `gst-libav` / `-ugly` |
| HEVC / iPhone HDR | needs the "HEVC Video Extensions" from the Microsoft Store and HW decode | ✅ | needs `gst-plugins-bad` + `gst-libav` |
| VP9 / AV1 (webm) | ✅ | VP9 ✅, AV1 on Apple silicon (M3+) | GStreamer plugins |
| ProRes | ❌ | ✅ | ❌ |

When a file can't be decoded and ffmpeg is installed, the app creates a proxy automatically. Without ffmpeg, it shows a hint that matches the platform and the detected codec.

The webview tone-maps HDR to SDR in the preview.

All media URLs go through `convertFileSrc` in `lib/media.ts`. If the asset protocol gives trouble with video on older WebKitGTK versions, that's the one place to swap in a localhost streaming server.

## Next steps

- Export: an ffmpeg sidecar that builds a filtergraph from the timeline, including HDR→SDR tone mapping (`zscale` + `tonemap`) or HDR passthrough
- Multiple tracks, audio waveforms, timeline thumbnails
- More keyframeable properties (crop, anchor point, blur…) and bezier easing
