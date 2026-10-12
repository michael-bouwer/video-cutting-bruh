import { isTauri } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { ask, confirmUnsaved } from "./dialog";
import { saveProject } from "./project";
import { queueBusy } from "./exportQueue";

/**
 * In-app updates (Tauri updater plugin). Releases publish a signed installer
 * plus `latest.json` on GitHub (see scripts/release.mjs); the app checks it
 * shortly after starting and from File → Check for updates.
 */

let checking = false;

/** `manual`: report "up to date" and errors (the automatic check stays quiet). */
export async function checkForUpdates(manual = false) {
  if (!isTauri() || checking) return;
  // Dev builds aren't installed, so there's nothing to update (manual checks still show the result).
  if (import.meta.env.DEV && !manual) return;
  checking = true;
  const notify = useStore.getState().notify;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      if (manual) {
        const { getVersion } = await import("@tauri-apps/api/app");
        notify("info", `You're on the latest version (${await getVersion()}).`);
      }
      return;
    }
    const notes = update.body?.trim();
    const choice = await ask(
      `Version ${update.version} is available`,
      `${notes ? `${notes}\n\n` : ""}You have ${update.currentVersion}. The update downloads, installs and restarts the app.${queueBusy() ? " Exports still in the queue will be stopped." : ""}`,
      [
        { id: "later", label: "Later" },
        { id: "install", label: "Update & restart", kind: "primary" },
      ],
      "later",
    );
    if (choice !== "install") return;
    if (useStore.getState().dirty) {
      const save = await confirmUnsaved("updating");
      if (save === "cancel") return;
      if (save === "save" && !(await saveProject())) return;
    }
    notify("info", "Downloading the update…");
    await update.downloadAndInstall();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    if (manual) notify("error", `Couldn't check for updates: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    checking = false;
  }
}

/** Checks once, a few seconds after start-up (so it never slows down opening the app). */
export function installUpdateCheck(): () => void {
  const timer = setTimeout(() => checkForUpdates(false), 8000);
  return () => clearTimeout(timer);
}
