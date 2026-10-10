import "./App.css";
import { useEffect, type CSSProperties } from "react";
import { Toolbar } from "./components/Toolbar";
import { MediaBin } from "./components/MediaBin";
import { Preview } from "./components/Preview";
import { Inspector } from "./components/Inspector";
import { Timeline } from "./components/Timeline";
import { Notices } from "./components/Notices";
import { DialogHost, Splitter } from "./components/ui";
import { TooltipLayer } from "./components/Tooltip";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { MediaDragGhost } from "./components/MediaDragGhost";
import { useFileDrop, useShortcuts } from "./hooks";
import { installHistory } from "./lib/history";
import { installProjectLifecycle } from "./lib/project";
import { usePanelSizes } from "./lib/layout";

export default function App() {
  const drop = useFileDrop();
  const { sizes, begin, resize, reset } = usePanelSizes();
  useShortcuts();
  useEffect(() => installHistory(), []);
  useEffect(() => installProjectLifecycle(), []);

  const vars = {
    "--bin-w": `${sizes.bin}px`,
    "--insp-w": `${sizes.inspector}px`,
    "--tl-h": `${sizes.timeline}px`,
  } as CSSProperties;

  return (
    <div className={`app ${drop.active ? "dragging-files" : ""}`} data-drop-target={drop.zone ?? ""} style={vars}>
      <Toolbar />
      <main className="workspace">
        <MediaBin />
        <Splitter orientation="vertical" onStart={begin} onDrag={(d) => resize("bin", d)} onReset={reset} />
        <Preview />
        <Splitter orientation="vertical" onStart={begin} onDrag={(d) => resize("inspector", -d)} onReset={reset} />
        <Inspector />
      </main>
      <Splitter orientation="horizontal" onStart={begin} onDrag={(d) => resize("timeline", -d)} onReset={reset} />
      <Timeline />
      {drop.active && (
        <div className="drop-hint">
          {drop.zone === "timeline" ? "Drop to add to the timeline" : "Drop to add to the media bin"}
        </div>
      )}
      <Notices />
      <MediaDragGhost />
      <NewProjectDialog />
      <DialogHost />
      <TooltipLayer />
    </div>
  );
}
