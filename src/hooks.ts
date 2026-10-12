import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { importFiles, importPaths } from "./lib/media";
import { useStore } from "./store";
import { clipDuration } from "./lib/timeline";
import { TRANSFORM_KEYS } from "./lib/props";
import { keyframeNear } from "./lib/keyframes";
import { redo, undo } from "./lib/history";
import { newProject, openProject, saveProject } from "./lib/project";
import { openImportDialog } from "./lib/media";

/** Opens the export dialog (desktop app only, needs something on the timeline). */
export function openExport() {
  const s = useStore.getState();
  if (!isTauri()) return s.notify("info", "Export is available in the desktop app.");
  if (s.clips.length === 0) return s.notify("info", "Add something to the timeline before exporting.");
  useStore.setState({ exportOpen: true, playing: false });
}
import { zoomToFit } from "./components/Timeline";
import { copyKeyframes, hasCopiedKeyframes, pasteKeyframes } from "./lib/keyframeClipboard";
import type { KeyframeRef } from "./types";
import { addMarkerAtPlayhead, jumpToMarker } from "./components/Markers";
import { copyAttributes, pasteAttributes, useAttributes } from "./lib/attributes";

/** Ctrl+A in the lanes: extend the keyframe selection to every keyframe on the same clips. */
function selectAllKeyframesOnSameClips() {
  const s = useStore.getState();
  const clipIds = new Set(s.kfSelection.map((r) => r.clipId));
  const refs: KeyframeRef[] = [];
  for (const c of s.clips) {
    if (!clipIds.has(c.id)) continue;
    for (const [key, kfs] of Object.entries(c.keyframes)) for (const kf of kfs) refs.push({ clipId: c.id, fx: null, key, kfId: kf.id });
    for (const fx of c.effects) for (const [key, kfs] of Object.entries(fx.keyframes)) for (const kf of kfs) refs.push({ clipId: c.id, fx: fx.id, key, kfId: kf.id });
  }
  s.selectKeyframes(refs);
}

export type DropZone = "timeline" | "bin" | null;

/** Which drop zone sits under a viewport point (CSS pixels). */
function zoneAt(x: number, y: number): DropZone {
  const el = document.elementFromPoint(x, y)?.closest("[data-drop-zone]");
  return (el?.getAttribute("data-drop-zone") as DropZone) ?? null;
}

/**
 * File drag & drop. In Tauri the webview's native drop handler gives real file
 * paths on every platform (HTML5 drops don't expose paths, and on Windows
 * native drops replace HTML5 file drops entirely). In a plain browser we fall
 * back to HTML5 drag & drop with blob URLs.
 *
 * Dropping on the timeline appends clips; anywhere else only adds to the bin.
 */
export function useFileDrop(): { active: boolean; zone: DropZone } {
  const [state, setState] = useState<{ active: boolean; zone: DropZone }>({ active: false, zone: null });

  useEffect(() => {
    if (isTauri()) {
      let unlisten: (() => void) | undefined;
      let cancelled = false;
      import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
        const un = await getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "leave") return setState({ active: false, zone: null });
          // Positions are physical pixels; elementFromPoint wants CSS pixels.
          const dpr = window.devicePixelRatio || 1;
          const zone = zoneAt(p.position.x / dpr, p.position.y / dpr);
          if (p.type === "drop") {
            setState({ active: false, zone: null });
            importPaths(p.paths, zone === "timeline");
          } else {
            setState({ active: true, zone });
          }
        });
        if (cancelled) un();
        else unlisten = un;
      });
      return () => {
        cancelled = true;
        unlisten?.();
      };
    }

    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setState({ active: true, zone: zoneAt(e.clientX, e.clientY) });
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setState({ active: true, zone: zoneAt(e.clientX, e.clientY) });
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setState({ active: false, zone: null });
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setState({ active: false, zone: null });
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) importFiles(files, zoneAt(e.clientX, e.clientY) === "timeline");
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return state;
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (s.dialog || s.newProjectDialog || s.exportOpen || useAttributes.getState().pasteTargets) return; // modals handle their own keys
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod) {
        const run = (fn: () => unknown) => {
          e.preventDefault();
          fn();
        };
        if (key === "s") return run(() => saveProject(e.shiftKey));
        if (key === "o") return run(() => openProject());
        if (key === "n") return run(newProject);
        if (key === "i") return run(openImportDialog);
        if (key === "e") return run(openExport);
        if (!typing && key === "t") return run(() => s.addTitle());
        // Ctrl/⌘+Alt+C / V: copy / paste clip attributes (e.code: Alt changes e.key on some layouts).
        if (!typing && e.altKey && e.code === "KeyC") return run(() => copyAttributes());
        if (!typing && e.altKey && e.code === "KeyV") return run(() => pasteAttributes());
        // Let text fields keep their own undo.
        if (!typing && key === "z") return run(e.shiftKey ? redo : undo);
        if (!typing && key === "y") return run(redo);
        if (!typing && key === "d" && s.selection?.kind === "clip") return run(() => s.duplicateClip(s.selection!.clipId));
        // Keyframes selected in the timeline's keyframe lanes.
        if (!typing && (key === "c" || key === "x") && s.kfSelection.length) return run(() => copyKeyframes(key === "x"));
        if (!typing && key === "v" && hasCopiedKeyframes()) return run(pasteKeyframes);
        if (!typing && key === "a" && s.kfSelection.length) return run(selectAllKeyframesOnSameClips);
        // Accidental reloads would throw away the edit (allowed in dev for HMR work).
        if ((key === "r" || key === "p" || key === "f") && !import.meta.env.DEV) return e.preventDefault();
        return;
      }
      if (e.key === "F5" && !import.meta.env.DEV) return e.preventDefault();
      if (typing) return;
      const frame = 1 / s.settings.fps;
      switch (e.key) {
        case " ":
          e.preventDefault();
          s.setPlaying(!s.playing);
          break;
        case "s":
        case "S":
          s.splitAtPlayhead();
          break;
        case "k":
        case "K": {
          // Keyframe every transform property of the selected clip at the playhead.
          if (s.selection?.kind !== "clip") break;
          const clip = s.clips.find((c) => c.id === s.selection!.clipId);
          const kind = clip && s.tracks.find((t) => t.id === clip.trackId)?.kind;
          if (!clip || !kind) break;
          const local = Math.min(clipDuration(clip), Math.max(0, s.currentTime - clip.start));
          for (const key of kind === "video" ? TRANSFORM_KEYS : (["volume"] as const)) {
            if (!keyframeNear(clip.keyframes[key], local, s.settings.fps)) s.toggleKeyframe(clip.id, key, local);
          }
          break;
        }
        case "Delete":
        case "Backspace":
          if (s.clipSelection.length > 1 || (s.clipSelection.length && s.kfSelection.length)) {
            // A box selection can hold clips and keyframes: remove the clips, then any other keyframes.
            const ids = [...s.clipSelection];
            s.removeClips(ids);
            const rest = useStore.getState().kfSelection;
            if (rest.length) useStore.getState().deleteKeyframes(rest);
          }
          // Selected keyframes take priority over the clip they belong to.
          else if (s.kfSelection.length) s.deleteKeyframes(s.kfSelection);
          // Shift+Delete removes only this clip, leaving its linked video/audio.
          else if (s.selection?.kind === "clip") s.removeClip(s.selection.clipId, e.shiftKey);
          else if (s.selection?.kind === "transition") {
            s.setTransition(s.selection.clipId, { type: "cut" });
            s.select(null);
          }
          break;
        case "ArrowLeft":
          e.preventDefault();
          s.setPlaying(false);
          s.seek(s.currentTime - (e.shiftKey ? 1 : frame));
          break;
        case "ArrowRight":
          e.preventDefault();
          s.setPlaying(false);
          s.seek(s.currentTime + (e.shiftKey ? 1 : frame));
          break;
        case "Home":
          s.seek(0);
          break;
        case "End":
          s.seek(Infinity);
          break;
        case "Escape":
          if (s.kfSelection.length) s.selectKeyframes([]);
          else s.select(null);
          s.selectClips([]);
          break;
        case "\\":
          zoomToFit();
          break;
        case "m":
        case "M":
          addMarkerAtPlayhead();
          break;
        case "[":
          jumpToMarker(-1);
          break;
        case "]":
          jumpToMarker(1);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
