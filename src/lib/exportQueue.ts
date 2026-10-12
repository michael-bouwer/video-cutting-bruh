import { create } from "zustand";
import { useStore, uid } from "../store";
import type { ExportHandle, ExportProgress, ExportSettings } from "./export";
import { planFor, renderTitles, startHqExport, type HqPlan } from "./exportHq";

/**
 * Background export queue (original-files mode). A job snapshots the timeline
 * when it's added (the ffmpeg plan is built right away), so you can keep
 * editing while it renders. Jobs run one at a time, in order.
 */

export interface QueueJob {
  id: string;
  /** File name, for the list. */
  name: string;
  opts: ExportSettings;
  encoder: string;
  hdr: boolean;
  plan: HqPlan;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  progress: ExportProgress | null;
  output?: string;
  error?: string;
}

interface QueueState {
  jobs: QueueJob[];
}

export const useExportQueue = create<QueueState>(() => ({ jobs: [] }));

const handles = new Map<string, ExportHandle>();
const update = (id: string, patch: Partial<QueueJob>) =>
  useExportQueue.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }));

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Adds an export to the queue (snapshotting the current timeline) and starts it when it's its turn. */
export async function enqueueExport(opts: ExportSettings, encoder: string, hdr: boolean) {
  const plan = planFor(opts, hdr, await renderTitles(opts));
  const job: QueueJob = { id: uid(), name: baseName(opts.path), opts, encoder, hdr, plan, status: "queued", progress: null };
  useExportQueue.setState((s) => ({ jobs: [...s.jobs, job] }));
  pump();
}

function pump() {
  const { jobs } = useExportQueue.getState();
  if (jobs.some((j) => j.status === "running")) return;
  const next = jobs.find((j) => j.status === "queued");
  if (!next) return;
  update(next.id, { status: "running" });
  const h = startHqExport(next.opts, next.encoder, next.hdr, (progress) => update(next.id, { progress }), next.plan);
  handles.set(next.id, h);
  h.done
    .then((output) => {
      update(next.id, { status: "done", output });
      useStore.getState().notify("info", `Export finished: ${next.name}`);
    })
    .catch((e: Error) => {
      if (e.message === "cancelled") update(next.id, { status: "cancelled" });
      else {
        update(next.id, { status: "error", error: e.message });
        useStore.getState().notify("error", `Export failed: ${next.name} — ${e.message}`);
      }
    })
    .finally(() => {
      handles.delete(next.id);
      pump();
    });
}

export function cancelJob(id: string) {
  const job = useExportQueue.getState().jobs.find((j) => j.id === id);
  if (!job) return;
  if (job.status === "running") handles.get(id)?.cancel();
  else if (job.status === "queued") update(id, { status: "cancelled" });
}

export function removeJob(id: string) {
  useExportQueue.setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== id || j.status === "running") }));
}

export function clearFinished() {
  useExportQueue.setState((s) => ({ jobs: s.jobs.filter((j) => j.status === "running" || j.status === "queued") }));
}

/** True while something is queued or rendering (e.g. to warn before closing). */
export const queueBusy = () => useExportQueue.getState().jobs.some((j) => j.status === "running" || j.status === "queued");
