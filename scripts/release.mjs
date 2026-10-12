#!/usr/bin/env node
// Builds a signed release and writes the `latest.json` the in-app updater reads.
//
//   pnpm release ["What's new in this version"]
//
// 1. Bump "version" in src-tauri/tauri.conf.json first (e.g. 0.1.0 → 0.1.1).
// 2. Run this: it builds the installer with the updater signature, using the
//    private key in ~/.tauri/video-cutting-bruh.key (or TAURI_SIGNING_PRIVATE_KEY).
// 3. Create a GitHub release tagged v<version> and upload the two files it lists.
//    Installed apps find the update via
//    https://github.com/michael-bouwer/video-cutting-bruh/releases/latest/download/latest.json

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "michael-bouwer/video-cutting-bruh";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const notes = process.argv.slice(2).join(" ").trim() || `Version ${version}`;

const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const key = path.join(os.homedir(), ".tauri", "video-cutting-bruh.key");
  if (!fs.existsSync(key)) {
    console.error(`No signing key: set TAURI_SIGNING_PRIVATE_KEY or create ${key} (pnpm tauri signer generate -w "${key}").`);
    process.exit(1);
  }
  env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(key, "utf8").trim();
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";

console.log(`[release] building ${version} …`);
const build = spawnSync("pnpm tauri build", { cwd: root, env, stdio: "inherit", shell: true });
if (build.status !== 0) process.exit(build.status ?? 1);

const bundle = path.join(root, "src-tauri", "target", "release", "bundle");
/** Updater artifact per platform: [platform key, folder, file test]. */
const targets = [
  ["windows-x86_64", "nsis", (f) => f.endsWith(`${version}_x64-setup.exe`)],
  ["windows-aarch64", "nsis", (f) => f.endsWith(`${version}_arm64-setup.exe`)],
  ["darwin-aarch64", "macos", (f) => f.endsWith(".app.tar.gz") && os.arch() === "arm64"],
  ["darwin-x86_64", "macos", (f) => f.endsWith(".app.tar.gz") && os.arch() === "x64"],
  ["linux-x86_64", "appimage", (f) => f.endsWith(".AppImage")],
];

const platforms = {};
const uploads = [];
for (const [key, dir, test] of targets) {
  const folder = path.join(bundle, dir);
  if (!fs.existsSync(folder)) continue;
  const file = fs.readdirSync(folder).find(test);
  if (!file || !fs.existsSync(path.join(folder, `${file}.sig`))) continue;
  const signature = fs.readFileSync(path.join(folder, `${file}.sig`), "utf8").trim();
  // GitHub replaces spaces in asset names with dots.
  const asset = file.replace(/ /g, ".");
  platforms[key] = { signature, url: `https://github.com/${REPO}/releases/download/v${version}/${encodeURIComponent(asset)}` };
  uploads.push(path.join(folder, file));
}
if (uploads.length === 0) {
  console.error("[release] no signed installer found — is bundle.createUpdaterArtifacts enabled?");
  process.exit(1);
}

const latest = path.join(bundle, "latest.json");
fs.writeFileSync(latest, JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2) + "\n");

console.log(`
[release] done. Create a GitHub release with tag v${version} and upload:
${[...uploads, latest].map((f) => `  - ${f}`).join("\n")}
`);
