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
- **Transitions (24):** cut, crossfade, blur dissolve, dip to black/white, wipe left/right/up/down, diagonal, clock wipe, barn doors (sideways and up/down), iris, push left/right/up/down, cover from left/right, reveal left/right, zoom in/out. They apply where two clips touch on a video track (click ⧉ on the cut), are centred on the cut, and each has its own timing curve.
- **Keyframes:** position X/Y, scale, rotation and opacity (video), volume (audio), and every effect parameter.
  - Click ◆ to keyframe at the playhead. Once a property is animated, editing its value writes a keyframe.
  - You can also drag the preview to move the selected clip.
- **Timing curves (CSS-style):** every keyframe and every transition has an easing button that opens a curve editor, like the cubic-bezier editor in browser devtools.
  - Presets: linear, ease, ease-in/out/in-out, expo, back (overshoot), hold.
  - Drag the two control points of the curve, or type the `cubic-bezier(x1, y1, x2, y2)` numbers. Up/down past the box overshoots.
  - An animated dot previews the timing.
- **Effects** (✦ Effects button in the inspector's tab bar opens a panel to the left of the inspector). Every parameter is keyframeable (◆, ‹ ›, easing), and effects can be bypassed, reordered and reset.
  - **Video and images:** brightness, contrast, saturation, hue shift, blur, black & white, sepia, invert and vignette. They render through canvas filters.
  - **Audio:** gain (dB, can boost above 100%), pan, low cut, high cut, bass, treble and echo. They run through Web Audio.
  - Effects carry over when you split or duplicate a clip.
- **Selecting several things:** drag on empty timeline space (track or keyframe lanes) to draw a selection box; it selects every clip and keyframe it touches. Shift or Ctrl/⌘ while starting the box, or Shift/Ctrl/⌘-click, adds to the selection. Dragging any selected clip moves the whole selection (with linked audio/video), and Delete removes it. A plain click on empty space still moves the playhead.
- **Closing gaps:** hover a segment with empty space before it and click **⇤** to slide it left against the previous segment (or 0). **Shift+⇤** also pulls everything after it on the track (ripple). **⇥** slides a segment right against the next one.
- **Deleting a segment after a split:** a split pins the animated value at the cut on both halves. Deleting one half also removes that pinned keyframe from the other half, so nothing from the deleted segment is left behind. Pins you've edited are kept.
- **Keyframe lanes:** click ▸ on a track header to show one lane per animated property (transform, volume, and each effect parameter) under the track.
  - Click a keyframe to select it; Shift or Ctrl/⌘-click adds to the selection, and Ctrl/⌘+A selects every keyframe on the same clips.
  - Drag to move the whole selection. It snaps to the playhead, clip edges and other keyframes; hold Alt to drag without snapping.
  - Ctrl/⌘+C, X and V copy, cut and paste. Pasting goes into the selected clip at the playhead with the spacing kept, and adds a missing effect if needed.
  - Delete removes the selected keyframes, and double-clicking a keyframe jumps the playhead to it.
  - Every keyframe gets a random colour when it's created, the same everywhere it appears (lanes, clip markers, ◆ buttons, the inspector's list). Click its swatch in the list for a new colour.
- **Alignment toolbar** (above the preview), for the selected clip at the playhead: align left/centre/right and top/middle/bottom, plus Fit, Fill and Reset. It accounts for scale and rotation, and animated properties get a keyframe at the playhead.
- **Export** (⤓ Export in the toolbar, File → Export video…, or Ctrl/⌘+E): renders the timeline to MP4.
  - **Presets:** YouTube (best quality), YouTube HDR (when the timeline has HDR clips), Discord under 10 MB / Nitro under 50 MB (bitrate from the export's length; resolution and frame rate drop as needed), and Shorts / TikTok / Reels (9:16, the centre of the frame).
  - **Range:** the whole timeline, the selected clips, between two markers, or custom start/end times.
  - **Queue (original-files mode):** **Add to queue** snapshots the timeline and renders in the background while you keep editing. Progress, cancel and "Show in folder" are under ⏳ in the toolbar.
  - **Render mode:** **Match preview** renders every frame with the preview engine, so the output looks exactly like the preview. **Original files (HQ)** has ffmpeg render the edit straight from the source recordings: footage is only encoded once, it can output **HDR10** (HEVC/AV1, PQ, BT.2020, 10-bit; SDR clips and images are mapped into HDR), and it doesn't need the preview copies. The choice is remembered.
  - **Options:** output file; resolution (100/75/50/25% of the project); frame rate; format (H.264, HEVC or AV1, using the fastest working encoder: NVENC/AMF/QSV/VideoToolbox on the GPU, else x264/x265/SVT-AV1); quality (High/Balanced/Small); audio on/off.
  - **Match preview picture:** every frame is rendered by the preview engine at its exact time, so the output matches the preview (transitions, effects, keyframes, curves). The raw frames stream straight into ffmpeg.
  - **Audio:** taken from the original files and mixed offline with the same volume, fade, mute/solo and audio-effect logic as the preview, then encoded as AAC.
  - **Progress:** a progress bar with fps, speed and time remaining, and Cancel. Exports are written under a temporary name and only renamed when complete.
  - **Match preview limits:** output is SDR (BT.709), and it renders from the preview copies, so it waits for any that are still being made.
  - **Original files (HQ):** `lib/exportHq.ts` turns the timeline into one ffmpeg filter graph. Each clip is decoded, converted to the output's colour space (HDR tone mapped with libplacebo BT.2390 like the previews, or zscale on the CPU), fitted, filtered and warped (position/scale/rotation as per-frame `perspective` expressions). Touching clips are joined with `concat`/`xfade`, and tracks are overlaid bottom-up. Animated effect parameters and opacity are driven by `sendcmd` files. Colour effects use the same CSS filter matrices as the preview. Audio is trimmed, gain-enveloped (volume keyframes × fades), processed (volume, stereotools, highpass/lowpass, bass/treble, aecho) and mixed with `amix`.
  - **HQ approximations** (listed in the dialog when they apply): transitions use ffmpeg's built-in `xfade` versions with linear timing ("Zoom out" becomes a crossfade, "Blur dissolve" uses `hblur`); animated vignette and echo use their first values; colour effects in HDR output act on HDR values.
- **Timeline visuals:** video clips show thumbnail strips and audio clips real waveforms. Both are made in the background by ffmpeg (keyframes only, tone-mapped for HDR) and cached in the app's cache folder (`src-tauri/src/visuals.rs`, `lib/visuals.ts`). Only the visible part of each clip is drawn.
- **Speed & speed ramps:** each video/audio clip has a Speed property (5–1600%; presets 25–400% in the inspector and the clip's right-click menu). Keyframe it for ramps, e.g. normal → 30% at the kill → normal. Speed changes the clip's length; the linked clip follows, and a clip that would run into the next one is shortened. Trims and splits work in timeline time (`lib/speed.ts` maps timeline ↔ source time). Audio keeps its pitch: `playbackRate` in the preview, `atempo` in exports.
- **Markers:** **M** (or ⚑ Marker) drops one at the playhead, also while playing. **[ / ]** jump to the previous / next marker. Drag a flag to move it, click it to jump there, double-click it to rename it, and right-click for colour and delete. Clips snap to markers, and exports can use the range between two markers.
- **Text clips:** **T Text** (Ctrl/⌘+T) adds one at the playhead on the highest free video track. The inspector edits the text (multi-line), font, size, colour, bold/italic, alignment, outline, shadow and background box. Position, scale, rotation, opacity, crop and effects work like on any clip.
- **Crop:** crop left/right/top/bottom (keyframeable) under Crop in the inspector. **Zoom to crop** scales and moves the clip so the cropped area fills the frame, e.g. to zoom into a minimap or scope.
- **Music tracks:** ♪ on an audio track header marks it as music. It's ducked (turned down, −12 dB by default; right-click ♪ for −6/−18/−24) while other audible tracks are loud, with look-ahead, quick attack and slow release, computed from the waveforms. Beats detected in its clips show as ticks and become snap points.
- **Clip names & colour labels:** double-click a clip's name to rename it, or use the name field in the inspector. Colour labels are in the right-click menu and the inspector.
- **Copy / paste attributes:** right-click → Copy attributes (Ctrl/⌘+Alt+C), then select clips and Paste attributes… (Ctrl/⌘+Alt+V). Choose what to paste: transform, crop, speed, effects, volume & fades, colour label.
- **Number fields:** drag left or right on any number field to change it (Shift: faster, Alt: finer), or click it to type. Arrow keys step the value while typing. Sliders work as before.
- **Timeline actions:** **✂ Split** cuts at the playhead: the selected clip with its linked clip, or with nothing selected, every clip under the playhead. **📷 Screenshot** saves the current preview frame (with effects, at project resolution) as a PNG and adds it to the media bin. Saved projects keep screenshots in `<project folder>/Screenshots/`.
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

### Bundled ffmpeg

The app ships its own ffmpeg and ffprobe as Tauri sidecars, so users don't need to install anything. `scripts/prepare-ffmpeg.mjs` puts them in `src-tauri/binaries/` (gitignored). It runs automatically before `tauri dev` and `tauri build`, and it skips the work when the files are already there.
- **Windows/Linux:** a pinned BtbN FFmpeg 9.0 GPL build is downloaded. Windows uses the shared build: two small exes plus DLLs, installed next to the app by `tauri.windows.conf.json`.
- **macOS, or a custom build:** set `VCB_FFMPEG_SRC` to a folder containing ffmpeg and ffprobe.
- **Commands:** `pnpm ffmpeg` prepares the files manually; `pnpm ffmpeg --force` downloads them again. Run it once after a fresh clone before `cargo test`/`cargo check`, because the Tauri build script requires the sidecars to exist.
- **Lookup order at runtime:** `VCB_FFMPEG_DIR`, then the app's own folder (the bundled copy), then system installs.
- **Licence:** the bundled build is GPL, so pass on its licence and source link (https://github.com/BtbN/FFmpeg-Builds) if you distribute the app.

### Releases and updates

```bash
pnpm release "What's new"
```

This builds the installers (`pnpm tauri build`), signs the update and writes `src-tauri/target/release/bundle/latest.json`. Create a GitHub release tagged `v<version>` and upload the `-setup.exe` and `latest.json` it lists. Installed apps check `releases/latest/download/latest.json` a few seconds after starting (and from File → Check for updates), then offer **Update & restart**.

- **Signing key:** `~/.tauri/video-cutting-bruh.key`, or the `TAURI_SIGNING_PRIVATE_KEY` environment variable. Back it up: without it, existing installs can't verify new versions. The public key is in `tauri.conf.json` (`plugins.updater.pubkey`).
- **Plain `pnpm tauri build`** needs `TAURI_SIGNING_PRIVATE_KEY` set too, because updater artifacts are enabled.

The output goes to `src-tauri/target/release/bundle/`: `nsis/*-setup.exe` (about 55 MB, the one to share) and `msi/*.msi`. Bump `version` in `src-tauri/tauri.conf.json` for each release. The installers aren't code-signed, so Windows SmartScreen asks users to click "More info → Run anyway".

## Architecture

```
src/
  types.ts             data model (MediaItem, Clip, Keyframe, Transition…)
  store.ts             zustand store + all editing actions
  engine/player.ts     preview engine: one <video> per clip, clock sync, canvas compositing
  lib/timeline.ts      clip layout (transitions = overlap), frame lookup, timecode
  lib/keyframes.ts     interpolation + easing
  lib/props.ts         registry of animatable properties  ← add new keyframeable props here
  lib/effects.ts       effect registry, canvas filter/vignette rendering, Web Audio effect chains  ← add effects here
  lib/screenshot.ts    capture the preview frame as a PNG image asset
  lib/keyframeClipboard.ts  copy/paste of keyframes selected in the timeline lanes
  lib/marquee.ts       box selection of clips and keyframes in the timeline
  lib/export.ts        export: offline audio mix + frame-by-frame render streamed to ffmpeg
  lib/exportHq.ts      HQ export: timeline → ffmpeg inputs, filter_complex script, sendcmd files
  lib/easing.ts        cubic-bezier timing curves (presets + custom), shared by keyframes and transitions
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
  export.rs            export: encoder detection, audio segments, ffmpeg fed with raw frames; HQ jobs (script + progress)
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

- Multiple tracks, audio waveforms, timeline thumbnails
- More keyframeable properties (crop, anchor point, blur…) and bezier easing
