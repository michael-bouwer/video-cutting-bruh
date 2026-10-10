import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { tip } from "./Tooltip";

export interface NewProjectChoice {
  name: string;
  folder: string;
}

const FOLDER_KEY = "vcb.projectsFolder";
const SEP = navigator.userAgent.includes("Windows") ? "\\" : "/";

/** Strips characters that aren't allowed in file names on Windows/macOS/Linux. */
export function safeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/[. ]+$/, "")
    .trim()
    .slice(0, 120);
}

async function defaultFolder(): Promise<string> {
  try {
    const saved = localStorage.getItem(FOLDER_KEY);
    if (saved) return saved;
  } catch {
    /* ignore */
  }
  try {
    const { documentDir, join } = await import("@tauri-apps/api/path");
    return await join(await documentDir(), "video-cutting-bruh");
  } catch {
    return "";
  }
}

/** Asks for a project name and location. Resolves null if cancelled. */
export function requestNewProject(): Promise<NewProjectChoice | null> {
  return new Promise((resolve) => {
    useStore.setState({
      newProjectDialog: {
        resolve: (choice) => {
          useStore.setState({ newProjectDialog: null });
          if (choice) {
            try {
              localStorage.setItem(FOLDER_KEY, choice.folder);
            } catch {
              /* ignore */
            }
          }
          resolve(choice);
        },
      },
    });
  });
}

export function NewProjectDialog() {
  const request = useStore((s) => s.newProjectDialog);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!request) return;
    const d = new Date();
    setName(`Project ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    defaultFolder().then(setFolder);
    requestAnimationFrame(() => nameRef.current?.select());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        request.resolve(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [request]);

  if (!request) return null;
  const clean = safeFileName(name);
  const valid = clean.length > 0 && folder.length > 0;
  const base = `${folder}${folder.endsWith(SEP) ? "" : SEP}${clean}`;

  const browse = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, defaultPath: folder || undefined });
    if (typeof picked === "string") setFolder(picked);
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && request.resolve(null)}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) request.resolve({ name: clean, folder });
        }}
      >
        <h2 id="new-project-title">New project</h2>
        <label className="form-row">
          <span>Name</span>
          <input ref={nameRef} type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <div className="form-row">
          <span>Location</span>
          <div className="path-picker">
            <input type="text" value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} />
            <button type="button" onClick={browse}>
              Browse…
            </button>
          </div>
        </div>
        {valid && (
          <p
            className="muted small path-preview"
            {...tip("The project file and its cache folder (converted preview copies) are kept together, so you can move or delete the whole project as one folder. Your source videos stay where they are.")}
          >
            {base}
            {SEP}
            {clean}.vcbproj
            <br />
            {base}
            {SEP}vcb-cache{SEP} <span className="muted">(preview copies)</span>
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={() => request.resolve(null)}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            Create project
          </button>
        </div>
      </form>
    </div>
  );
}
