import { invoke, isTauri } from "@tauri-apps/api/core";
import { player } from "../engine/player";
import { useStore } from "../store";
import { importFiles, importPaths } from "./media";
import { formatTime } from "./timeline";

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/**
 * Saves the current preview frame (with effects, at project resolution) as a PNG
 * and adds it to the media bin as an image.
 * Saved projects keep screenshots in `<project folder>/Screenshots/`.
 */
export async function createScreenshot() {
  const { currentTime, settings, projectPath, notify, clips } = useStore.getState();
  if (clips.length === 0) return notify("info", "Add something to the timeline first — the screenshot captures the preview.");

  let blob: Blob;
  try {
    blob = await player.capture();
  } catch (e) {
    // A "tainted" canvas (media loaded without CORS) can't be read back.
    const msg = e instanceof DOMException && e.name === "SecurityError" ? "the preview contains media the app isn't allowed to read" : String(e instanceof Error ? e.message : e);
    return notify("error", `Couldn't capture the preview: ${msg}`);
  }

  const name = `Screenshot ${formatTime(currentTime, settings.fps).replace(/:/g, "-")}`;
  try {
    if (isTauri()) {
      const path = await invoke<string>("save_screenshot", { projectPath, name, dataBase64: await blobToDataUrl(blob) });
      await importPaths([path]);
      notify("info", `Screenshot saved to ${path}`);
    } else {
      await importFiles([new File([blob], `${name}.png`, { type: "image/png" })]);
      notify("info", `Added ${name}.png to the media bin`);
    }
  } catch (e) {
    notify("error", `Couldn't save the screenshot: ${e}`);
  }
}
