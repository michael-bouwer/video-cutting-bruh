#!/usr/bin/env node
// Puts ffmpeg + ffprobe where Tauri bundles them with the app (src-tauri/binaries).
//
// Tauri "sidecars" must be named <name>-<target triple>[.exe]; they're installed
// next to the app's executable (the first place the app looks for ffmpeg). On
// Windows we use a *shared* build: small exes plus one set of DLLs, which
// tauri.windows.conf.json installs alongside them (about half the size of two
// static exes).
//
// Source, in order:
//   VCB_FFMPEG_SRC=<folder with ffmpeg + ffprobe (+ DLLs)>  — use your own build
//   otherwise a pinned BtbN FFmpeg 9.0 GPL build is downloaded (Windows/Linux).
// macOS has no BtbN builds: point VCB_FFMPEG_SRC at static binaries
// (e.g. from https://evermeet.cx/ffmpeg/ or https://www.osxexperts.net/).
//
// Runs before `tauri dev` / `tauri build`; does nothing if already up to date.
// `node scripts/prepare-ffmpeg.mjs --force` re-downloads.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "src-tauri", "binaries");
const libDir = path.join(outDir, "lib");
const cacheDir = path.join(outDir, ".download");
const force = process.argv.includes("--force");

const BTBN = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/";
const DOWNLOADS = {
  "x86_64-pc-windows-msvc": "ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip",
  "aarch64-pc-windows-msvc": "ffmpeg-n9.0-latest-winarm64-gpl-shared-9.0.zip",
  "x86_64-unknown-linux-gnu": "ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz",
  "aarch64-unknown-linux-gnu": "ffmpeg-n9.0-latest-linuxarm64-gpl-9.0.tar.xz",
};

function targetTriple() {
  // Set by the Tauri CLI for before*Command hooks (also when cross-compiling).
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = out.match(/^host: (\S+)/m)?.[1];
  if (!host) throw new Error("Couldn't determine the Rust target triple (is rustc installed?)");
  return host;
}

const triple = targetTriple();
const windows = triple.includes("windows");
const ext = windows ? ".exe" : "";
const sidecar = (name) => path.join(outDir, `${name}-${triple}${ext}`);
const stampFile = path.join(outDir, ".source");

const src = process.env.VCB_FFMPEG_SRC;
const source = src ? `dir:${path.resolve(src)}` : DOWNLOADS[triple] ? `btbn:${DOWNLOADS[triple]}` : null;
if (!source) {
  console.error(
    `[ffmpeg] No ffmpeg download is configured for ${triple}.\n` +
      `         Set VCB_FFMPEG_SRC to a folder containing static ffmpeg and ffprobe builds, then try again.`,
  );
  process.exit(1);
}

const upToDate =
  !force &&
  fs.existsSync(sidecar("ffmpeg")) &&
  fs.existsSync(sidecar("ffprobe")) &&
  fs.existsSync(stampFile) &&
  fs.readFileSync(stampFile, "utf8") === `${source}|${triple}`;
if (upToDate) {
  console.log(`[ffmpeg] bundled ffmpeg is ready (${triple})`);
  process.exit(0);
}

/** Extracts an archive with the system tar (Windows' bsdtar reads .zip too). */
function extract(archive, into) {
  fs.mkdirSync(into, { recursive: true });
  const tar = windows && process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", archive, "-C", into], { stdio: "inherit" });
}

/** The folder inside an extracted build that holds ffmpeg[.exe]. */
function findBin(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === `ffmpeg${ext}`) return dir;
    if (entry.isDirectory()) {
      const found = findBin(p);
      if (found) return found;
    }
  }
  return null;
}

async function download(file) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, file);
  if (force || !fs.existsSync(archive)) {
    console.log(`[ffmpeg] downloading ${file} …`);
    const res = await fetch(BTBN + file);
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText} (${BTBN + file})`);
    const partial = `${archive}.partial`;
    fs.writeFileSync(partial, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(partial, archive);
  }
  const unpacked = path.join(cacheDir, "unpacked");
  fs.rmSync(unpacked, { recursive: true, force: true });
  console.log(`[ffmpeg] extracting …`);
  extract(archive, unpacked);
  return unpacked;
}

const from = src ? path.resolve(src) : await download(DOWNLOADS[triple]);
const bin = findBin(from);
if (!bin || !fs.existsSync(path.join(bin, `ffprobe${ext}`))) {
  throw new Error(`ffmpeg${ext} and ffprobe${ext} weren't found in ${from}`);
}

// Checked where it was unpacked: in binaries/ the exes only run once installed next to their DLLs.
const version = execFileSync(path.join(bin, `ffmpeg${ext}`), ["-hide_banner", "-version"], { encoding: "utf8" }).split(" Copyright")[0];

// Start clean so files from a previous source never linger in the bundle.
for (const f of fs.readdirSync(outDir, { withFileTypes: true }).filter((e) => e.isFile())) fs.rmSync(path.join(outDir, f.name));
fs.rmSync(libDir, { recursive: true, force: true });
fs.mkdirSync(libDir, { recursive: true });

for (const name of ["ffmpeg", "ffprobe"]) {
  fs.copyFileSync(path.join(bin, `${name}${ext}`), sidecar(name));
  if (!windows) fs.chmodSync(sidecar(name), 0o755);
}
// Shared builds: the DLLs must sit next to the exes once installed.
let libs = 0;
if (windows) {
  for (const f of fs.readdirSync(bin).filter((f) => f.toLowerCase().endsWith(".dll"))) {
    fs.copyFileSync(path.join(bin, f), path.join(libDir, f));
    libs++;
  }
}
// tauri.windows.conf.json bundles binaries/lib/*; keep the folder non-empty everywhere.
fs.writeFileSync(path.join(libDir, "ffmpeg-libs.txt"), "Shared libraries for the bundled ffmpeg (see scripts/prepare-ffmpeg.mjs).\n");
fs.writeFileSync(stampFile, `${source}|${triple}`);
fs.rmSync(path.join(cacheDir, "unpacked"), { recursive: true, force: true });
console.log(`[ffmpeg] bundled ${version} for ${triple}${libs ? ` (+${libs} DLLs)` : ""}`);
