import { cancelJob, clearFinished, removeJob, useExportQueue, type QueueJob } from "../lib/exportQueue";
import { Dropdown } from "./ui";
import { tip } from "./Tooltip";

const STATUS: Record<QueueJob["status"], string> = {
  queued: "Waiting",
  running: "Rendering",
  done: "Done",
  error: "Failed",
  cancelled: "Cancelled",
};

/** Toolbar button + list of background exports (only shown while there are any). */
export function QueueMenu() {
  const jobs = useExportQueue((s) => s.jobs);
  if (jobs.length === 0) return null;
  const active = jobs.filter((j) => j.status === "running" || j.status === "queued").length;
  const running = jobs.find((j) => j.status === "running");
  const pct = running?.progress ? Math.round((running.progress.frame / Math.max(1, running.progress.frames)) * 100) : null;

  const reveal = async (path: string) => {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    revealItemInDir(path).catch(() => {});
  };

  return (
    <Dropdown
      align="right"
      className="queue-menu"
      tip={tip("Exports rendering in the background", { title: "Export queue" })}
      label={
        <span>
          ⏳ {active > 0 ? `${active}${pct !== null ? ` · ${pct}%` : ""}` : "✓"}
        </span>
      }
    >
      {() => (
        <div className="queue-panel">
          <div className="menu-heading">Export queue</div>
          {jobs.map((j) => {
            const p = j.progress && j.status === "running" ? (j.progress.frame / Math.max(1, j.progress.frames)) * 100 : j.status === "done" ? 100 : 0;
            return (
              <div key={j.id} className={`queue-job ${j.status}`}>
                <div className="queue-row">
                  <span className="queue-name" title={j.opts.path}>
                    {j.name}
                  </span>
                  <span className="muted small">{STATUS[j.status]}</span>
                </div>
                {(j.status === "running" || j.status === "done") && (
                  <div className="export-bar small-bar">
                    <div style={{ width: `${p}%` }} />
                  </div>
                )}
                {j.status === "running" && j.progress && j.progress.speed > 0 && (
                  <span className="muted small">
                    {(j.progress.speed / j.opts.fps).toFixed(2)}× real time · about {Math.max(1, Math.round(j.progress.eta))}s left
                  </span>
                )}
                {j.error && <span className="export-warn small">{j.error}</span>}
                <div className="queue-actions">
                  {(j.status === "running" || j.status === "queued") && <button onClick={() => cancelJob(j.id)}>Cancel</button>}
                  {j.status === "done" && j.output && <button onClick={() => reveal(j.output!)}>Show in folder</button>}
                  {j.status !== "running" && j.status !== "queued" && <button onClick={() => removeJob(j.id)}>Remove</button>}
                </div>
              </div>
            );
          })}
          {jobs.some((j) => j.status !== "running" && j.status !== "queued") && (
            <button className="link queue-clear" onClick={clearFinished}>
              Clear finished
            </button>
          )}
        </div>
      )}
    </Dropdown>
  );
}
