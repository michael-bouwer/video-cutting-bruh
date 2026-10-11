import { invoke } from "@tauri-apps/api/core";
import type { Clip, Effect, MediaItem, Track, TransitionType } from "../types";
import { audioGain } from "../engine/player";
import { useStore } from "../store";
import { even, type ExportHandle, type ExportProgress, type ExportSettings } from "./export";
import { effectValueAt, transformAt } from "./keyframes";
import { clipDuration, clipEnd, TOUCH_EPS, timelineEnd, trackClips, transitionLength } from "./timeline";

/**
 * "Original files" export: translates the timeline into one ffmpeg run that
 * decodes the source recordings directly (no preview copies, no canvas), so
 * the footage is only encoded once and HDR can stay HDR.
 *
 * Every video clip becomes a full-frame stream with transparency:
 *   decode → frame rate → colour (tone map / HDR) → fit → effects → opacity
 *   → position/scale/rotation (a `perspective` warp driven by per-frame
 *   expressions) → padded to the frame.
 * Touching clips on a track are joined with `concat` or `xfade`, each run is
 * shifted to its place on the timeline and laid over black, tracks bottom-up.
 * Audio clips are trimmed, enveloped, processed, delayed and mixed.
 *
 * Animated filter parameters (effects, opacity) are driven by `sendcmd` files.
 * What can't be matched exactly is listed in `warnings`.
 */

export interface HqCaps {
  /** libplacebo over Vulkan works (same BT.2390 tone mapping as the previews). */
  vulkan: boolean;
  /** zscale is available (CPU tone mapping / colour conversion). */
  zscale: boolean;
}

export interface HqSettings {
  width: number;
  height: number;
  fps: number;
  /** HDR10 output (PQ, BT.2020, 10-bit) instead of SDR BT.709. */
  hdr: boolean;
  audio: boolean;
}

export interface HqPlan {
  inputs: string[][];
  graph: string;
  files: { name: string; content: string }[];
  audio: boolean;
  vulkan: boolean;
  duration: number;
  warnings: string[];
}

// ---- Small helpers ------------------------------------------------------------------

/** Compact number for filter arguments ("1.5", "-0.25", "3"). */
const num = (n: number, digits = 4) => {
  const s = (Math.abs(n) < 10 ** -digits ? 0 : n).toFixed(digits);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};
/** A number safe to use inside an expression. */
const ex = (n: number, digits = 4) => (n < 0 ? `(${num(n, digits)})` : num(n, digits));

/** Indices of the points kept when simplifying a sampled curve to within `tol` (Ramer–Douglas–Peucker). */
function simplify(xs: number[], ys: number[], tol: number): number[] {
  const n = ys.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let worstD = tol;
    for (let i = a + 1; i < b; i++) {
      const lin = ys[a] + ((ys[b] - ys[a]) * (xs[i] - xs[a])) / (xs[b] - xs[a]);
      const d = Math.abs(ys[i] - lin);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => k && out.push(i));
  return out;
}

/**
 * A piecewise-linear ffmpeg expression in variable `v` through the sampled
 * points (flat sum of segments, so long curves don't nest deeply).
 */
function curveExpr(xs: number[], ys: number[], v: string, tol: number, digits = 3): string {
  if (ys.every((y) => Math.abs(y - ys[0]) <= tol)) return num(ys[0], digits);
  const idx = simplify(xs, ys, tol);
  const terms: string[] = [];
  for (let j = 0; j < idx.length - 1; j++) {
    const a = idx[j];
    const b = idx[j + 1];
    const k = (ys[b] - ys[a]) / (xs[b] - xs[a]);
    const body = Math.abs(k) < 1e-9 ? ex(ys[a], digits) : `(${ex(ys[a], digits)}+(${v}-${num(xs[a], 6)})*${ex(k, 6)})`;
    const cond = j === 0 ? `lt(${v},${num(xs[b], 6)})` : `gte(${v},${num(xs[a], 6)})*lt(${v},${num(xs[b], 6)})`;
    terms.push(`${cond}*${body}`);
  }
  const last = idx[idx.length - 1];
  terms.push(`gte(${v},${num(xs[last], 6)})*${ex(ys[last], digits)}`);
  return terms.join("+");
}

/** Collects sendcmd/asendcmd lines: only parameters whose value changed are sent. */
class Commands {
  private lines: string[] = [];
  private last = new Map<string, string>();
  /** Records the value; returns it formatted (initial values go straight into the filter). */
  set(target: string, opt: string, value: number, pending: string[]) {
    const v = num(value, 5);
    const key = `${target} ${opt}`;
    if (this.last.get(key) === v) return;
    const first = !this.last.has(key);
    this.last.set(key, v);
    if (!first) pending.push(`${target} ${opt} ${v}`);
  }
  flush(time: number, pending: string[]) {
    if (pending.length) this.lines.push(`${num(time, 6)} ${pending.join(", ")};`);
  }
  get empty() {
    return this.lines.length === 0;
  }
  toString() {
    return this.lines.join("\n") + "\n";
  }
}

// ---- Colour --------------------------------------------------------------------------

type HdrTransfer = "PQ" | "HLG" | null;

function hdrTransfer(m: MediaItem): HdrTransfer {
  const p = m.probe;
  if (!p?.hdr) return null;
  if (p.color?.transfer === 18 || p.hdr === "HLG") return "HLG";
  return "PQ";
}

/** swscale name of the source's YUV matrix. */
function srcMatrix(m: MediaItem): string {
  const mx = m.probe?.color?.matrix;
  if (mx === 9 || mx === 10) return "bt2020";
  if (mx === 5 || mx === 6) return "bt601";
  if (mx === 1) return "bt709";
  return (m.height || 0) >= 720 ? "bt709" : "bt601";
}

// ---- Effects -----------------------------------------------------------------------------

/** CSS filter-effect matrices (row-major RGB), so colours match the preview's canvas filters. */
const MATRIX: Partial<Record<Effect["type"], (v: (k: string) => number) => number[]>> = {
  brightness: (v) => {
    const b = Math.max(0, v("amount") / 100);
    return [b, 0, 0, 0, b, 0, 0, 0, b];
  },
  saturation: (v) => {
    const s = Math.max(0, v("amount") / 100);
    return [
      0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
      0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
      0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
    ];
  },
  hue: (v) => {
    const a = (v("angle") * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
      0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
      0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
      0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
    ];
  },
  grayscale: (v) => {
    const g = 1 - Math.min(1, Math.max(0, v("amount") / 100));
    return [
      0.2126 + 0.7874 * g, 0.7152 - 0.7152 * g, 0.0722 - 0.0722 * g,
      0.2126 - 0.2126 * g, 0.7152 + 0.2848 * g, 0.0722 - 0.0722 * g,
      0.2126 - 0.2126 * g, 0.7152 - 0.7152 * g, 0.0722 + 0.9278 * g,
    ];
  },
  sepia: (v) => {
    const g = 1 - Math.min(1, Math.max(0, v("amount") / 100));
    return [
      0.393 + 0.607 * g, 0.769 - 0.769 * g, 0.189 - 0.189 * g,
      0.349 - 0.349 * g, 0.686 + 0.314 * g, 0.168 - 0.168 * g,
      0.272 - 0.272 * g, 0.534 - 0.534 * g, 0.131 + 0.869 * g,
    ];
  },
};
const MIX_KEYS = ["rr", "rg", "rb", "gr", "gg", "gb", "br", "bg", "bb"];

/** A per-frame-adjustable visual effect: filter name and its option values at a time. */
function visualEffect(fx: Effect, frameHeight: number): { filter: string; at: (v: (k: string) => number) => Record<string, number> } | null {
  const matrix = MATRIX[fx.type];
  if (matrix) return { filter: "colorchannelmixer", at: (v) => Object.fromEntries(matrix(v).map((x, i) => [MIX_KEYS[i], x])) };
  const levels = (imin: number, imax: number, omin: number, omax: number) =>
    Object.fromEntries(
      ["r", "g", "b"].flatMap((c) => [
        [`${c}imin`, imin],
        [`${c}imax`, imax],
        [`${c}omin`, omin],
        [`${c}omax`, omax],
      ]),
    );
  switch (fx.type) {
    case "contrast":
      // CSS contrast(c): out = (in − 0.5)·c + 0.5, as input or output levels.
      return {
        filter: "colorlevels",
        at: (v) => {
          const c = Math.max(0, v("amount") / 100);
          return c >= 1 ? levels(0.5 - 0.5 / c, 0.5 + 0.5 / c, 0, 1) : levels(0, 1, 0.5 - 0.5 * c, 0.5 + 0.5 * c);
        },
      };
    case "invert":
      // CSS invert(a): out = a + in·(1 − 2a).
      return {
        filter: "colorlevels",
        at: (v) => {
          const a = Math.min(1, Math.max(0, v("amount") / 100));
          return levels(0, 1, a, 1 - a);
        },
      };
    case "blur":
      return { filter: "gblur", at: (v) => ({ sigma: Math.max(0, (v("radius") * frameHeight) / 1080) }) };
    default:
      return null;
  }
}

const animated = (fx: Effect) => Object.values(fx.keyframes).some((k) => k.length > 0);

// ---- Transitions -------------------------------------------------------------------------

/** Closest ffmpeg xfade transition (directions checked against the preview's). */
const XFADE: Record<Exclude<TransitionType, "cut">, string> = {
  crossfade: "fade",
  blurDissolve: "hblur",
  dipToBlack: "fadeblack",
  dipToWhite: "fadewhite",
  wipeLeft: "wipeleft",
  wipeRight: "wiperight",
  wipeUp: "wipeup",
  wipeDown: "wipedown",
  diagonal: "diagbr",
  clockWipe: "radial",
  barnDoorH: "vertopen",
  barnDoorV: "horzopen",
  iris: "circleopen",
  slideLeft: "slideleft",
  slideRight: "slideright",
  slideUp: "slideup",
  slideDown: "slidedown",
  coverLeft: "coverleft",
  coverRight: "coverright",
  revealLeft: "revealleft",
  revealRight: "revealright",
  zoomIn: "zoomin",
  zoomOut: "fade",
};

// ---- Plan ------------------------------------------------------------------------------------

export function buildHqPlan(
  clips: Clip[],
  tracks: Track[],
  mediaList: MediaItem[],
  s: HqSettings,
  caps: HqCaps,
): HqPlan {
  const { width: W, height: H, fps, hdr } = s;
  const media = new Map(mediaList.map((m) => [m.id, m]));
  const inputs: string[][] = [];
  const files: { name: string; content: string }[] = [];
  const graph: string[] = [];
  const warnings = new Set<string>();
  let usedVulkan = false;

  const RGB = hdr ? "gbrap10le" : "gbrap";
  const YUVA = hdr ? "yuva444p10le" : "yuva444p";
  const OUT_MATRIX = hdr ? "bt2020" : "bt709";
  const maxv = hdr ? 1023 : 255;
  const total = timelineEnd(clips);
  const totalFrames = Math.max(1, Math.ceil(total * fps - 1e-6));
  const sec = (frames: number) => num(frames / fps, 6);
  const addInput = (args: string[]) => inputs.push(args) - 1;
  const usable = (m: MediaItem | undefined): m is MediaItem => !!m && m.status !== "missing" && m.status !== "error" && !!m.path;

  /** A clip as a W×H stream with alpha, `frames` long, starting `leadIn` frames before the clip. */
  const videoClip = (c: Clip, idx: number, leadIn: number, frames: number, startFrame: number): string => {
    const out = `v${idx}`;
    const m = media.get(c.mediaId);
    if (!usable(m) || m.kind === "audio") {
      warnings.add("Some clips' files are missing or unreadable — they're left empty (transparent) in the export.");
      graph.push(`color=c=black@0:s=${W}x${H}:r=${fps}:d=${sec(frames)},format=${YUVA}[${out}]`);
      return out;
    }
    const isImage = m.kind === "image";
    const f: string[] = [];
    const cmds = new Commands();
    const cmdFile = `c${idx}.cmd`;

    // Timeline time of stream frame n, and the clip-local time the keyframes use.
    const localAt = (n: number) => (startFrame - leadIn + n) / fps - c.start;

    // --- Source & timing
    let pre = 0;
    if (isImage) {
      addInput(["-loop", "1", "-framerate", String(fps), "-t", sec(frames + 2), "-i", m.path]);
    } else {
      let from = c.trimIn + localAt(0);
      if (from < 0) {
        pre = Math.ceil(-from * fps - 1e-6);
        from = 0;
      }
      const need = (frames - pre) / fps;
      const missing = m.duration > 0 ? Math.max(0, from + need - m.duration) : 0;
      addInput(["-an", "-sn", "-dn", "-hwaccel", "auto", "-ss", num(from, 6), "-t", num(need + 2 / fps, 6), "-i", m.path]);
      f.push("setpts=PTS-STARTPTS", `fps=${fps}`);
      // Hold the first/last frame where a transition reaches past the source.
      f.push(`tpad=start=${pre}:stop=${Math.ceil(missing * fps) + 2}:start_mode=clone:stop_mode=clone`);
    }
    if (isImage) f.push("setpts=PTS-STARTPTS", `fps=${fps}`);
    f.push(`trim=end_frame=${frames}`, "setpts=PTS-STARTPTS");
    const inputIndex = inputs.length - 1;

    // --- Colour: bring every source to the output's colour space
    let matrix = srcMatrix(m);
    let range = m.probe?.color?.fullRange ? "pc" : "tv";
    const tr = isImage ? null : hdrTransfer(m);
    if (!isImage) {
      if (!hdr && tr) {
        if (caps.vulkan) {
          usedVulkan = true;
          f.push("libplacebo=tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p10le");
        } else if (caps.zscale) {
          const tin = tr === "HLG" ? "arib-std-b67" : "smpte2084";
          f.push(
            `zscale=tin=${tin}:min=bt2020nc:pin=bt2020:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv444p`,
          );
          warnings.add("HDR clips are tone mapped on the CPU (slower, slightly different look than the preview).");
        } else {
          warnings.add("HDR clips can't be tone mapped with this ffmpeg — they'll look washed out.");
        }
        matrix = "bt709";
        range = "tv";
      } else if (hdr && tr === "HLG") {
        f.push("zscale=tin=arib-std-b67:min=bt2020nc:pin=bt2020:t=smpte2084:m=bt2020nc:p=bt2020:npl=1000,format=yuv444p10le");
        matrix = "bt2020";
        range = "tv";
      } else if (hdr && !tr) {
        // SDR footage in an HDR export: SDR white at the 203-nit reference level.
        const zm = matrix === "bt601" ? "170m" : matrix === "bt2020" ? "2020_ncl" : "709";
        f.push(
          `zscale=tin=709:min=${zm}:pin=709:rin=${range === "pc" ? "full" : "limited"}:t=smpte2084:m=2020_ncl:p=2020:r=limited:npl=203,format=yuv444p10le`,
        );
        matrix = "bt2020";
        range = "tv";
      }
    }

    // --- Fit ("contain") into the frame
    const sw = m.width || W;
    const sh = m.height || H;
    const fit = Math.min(W / sw, H / sh);
    const fw = Math.max(1, Math.round(sw * fit));
    const fh = Math.max(1, Math.round(sh * fit));

    const fxs = c.effects.filter((e) => e.enabled);
    const visual = fxs.map((fx) => ({ fx, def: visualEffect(fx, H) })).filter((x) => x.def);
    const vignettes = fxs.filter((fx) => fx.type === "vignette");
    const opacityAnimated = c.keyframes.opacity.length > 0;
    const needsOpacity = opacityAnimated || Math.abs(c.base.opacity - 100) > 1e-6;
    const rgbStage = isImage || visual.length > 0 || vignettes.length > 0 || needsOpacity;
    if (hdr && (visual.length || vignettes.length)) warnings.add("Colour effects are applied to HDR values, so they can look stronger or weaker than in the preview.");

    const pending: string[] = [];
    const names = visual.map((_, j) => `fx${idx}_${j}`);
    const opName = `op${idx}`;
    // Sample animated parameters once per frame; first values become the filter's initial options.
    const initial: Record<string, number>[] = visual.map(() => ({}));
    let initialOpacity = 1;
    for (let n = 0; n < frames; n++) {
      const local = localAt(n);
      visual.forEach(({ fx, def }, j) => {
        if (n > 0 && !animated(fx)) return;
        const opts = def!.at((k) => effectValueAt(fx, k, local));
        for (const [k, val] of Object.entries(opts)) {
          if (n === 0) initial[j][k] = val;
          cmds.set(`${def!.filter}@${names[j]}`, k, val, pending);
        }
      });
      if (needsOpacity && (n === 0 || opacityAnimated)) {
        const o = Math.min(1, Math.max(0, transformAt(c, local).opacity / 100));
        if (n === 0) initialOpacity = o;
        cmds.set(`colorchannelmixer@${opName}`, "aa", o, pending);
      }
      cmds.flush(n / fps, pending);
      pending.length = 0;
    }
    if (!cmds.empty) {
      files.push({ name: cmdFile, content: cmds.toString() });
      // Commands must reach the filters before the frame that triggers them does.
      f.push(`sendcmd=f=${cmdFile}`);
    }

    const head = `[${inputIndex}:v:0]`;
    if (rgbStage) {
      if (isImage) {
        f.push(`scale=${fw}:${fh}:flags=lanczos`, "format=gbrap");
        if (hdr) f.push("zscale=tin=iec61966-2-1:pin=709:t=smpte2084:p=2020:npl=203", `format=${RGB}`);
      } else {
        f.push(`scale=${fw}:${fh}:flags=lanczos:in_color_matrix=${matrix}:in_range=${range}`, `format=${RGB}`);
      }
      visual.forEach(({ def }, j) => {
        const opts = Object.entries(initial[j]).map(([k, v]) => `${k}=${num(v, 5)}`).join(":");
        f.push(`${def!.filter}@${names[j]}=${opts}`);
      });
      // Vignettes are drawn over the filtered picture (as in the preview), before opacity.
      let label = `${out}_pre`;
      if (vignettes.length) {
        graph.push(`${head}${f.join(",")}[${label}]`);
        f.length = 0;
        vignettes.forEach((fx, j) => {
          if (animated(fx)) warnings.add("Animated vignettes use their first keyframe's values in this export mode.");
          const amount = Math.min(1, Math.max(0, effectValueAt(fx, "amount", 0) / 100));
          const size = effectValueAt(fx, "size", 0) / 100;
          const outer = Math.hypot(fw, fh) / 2;
          const inner = outer * Math.max(0.05, size) * 0.9;
          const mask = `${out}_vig${j}`;
          const a = `${num(amount * maxv, 3)}*clip((hypot(X-${num(fw / 2)},Y-${num(fh / 2)})-${num(inner)})/${num(Math.max(1, outer - inner))},0,1)`;
          graph.push(`color=c=black:s=${fw}x${fh}:r=${fps}:d=${sec(1)},format=${RGB},geq=r=0:g=0:b=0:a='${a}',loop=loop=${frames - 1}:size=1[${mask}]`);
          const next = `${out}_v${j}`;
          graph.push(`[${label}][${mask}]overlay=shortest=1:format=auto[${next}]`);
          label = next;
        });
      }
      if (needsOpacity) f.push(`colorchannelmixer@${opName}=aa=${num(initialOpacity, 5)}`);
      f.push(`scale=out_color_matrix=${OUT_MATRIX}:out_range=tv`, `format=${YUVA}`);
      if (vignettes.length) {
        transformAndPad(c, f, fw, fh, frames, localAt);
        graph.push(`[${label}]${f.join(",")}[${out}]`);
        return out;
      }
    } else {
      f.push(`scale=${fw}:${fh}:flags=lanczos:in_color_matrix=${matrix}:in_range=${range}:out_color_matrix=${OUT_MATRIX}:out_range=tv`, `format=${YUVA}`);
    }
    transformAndPad(c, f, fw, fh, frames, localAt);
    graph.push(`${head}${f.join(",")}[${out}]`);
    return out;
  };

  /** Pads the fitted picture to the frame and applies position/scale/rotation. */
  const transformAndPad = (c: Clip, f: string[], fw: number, fh: number, frames: number, localAt: (n: number) => number) => {
    const moving = ["x", "y", "scale", "rotation"].some((k) => c.keyframes[k as "x"].length > 0);
    const identity = !moving && c.base.x === 0 && c.base.y === 0 && c.base.scale === 100 && c.base.rotation === 0;
    if (identity) {
      f.push(`pad=${W}:${H}:${Math.floor((W - fw) / 2)}:${Math.floor((H - fh) / 2)}:color=black@0`);
      return;
    }
    // A transparent margin so the warp's edge clamping only ever repeats transparent pixels.
    const P = 2;
    const cw = W + 2 * P;
    const ch = H + 2 * P;
    f.push(`pad=${cw}:${ch}:${Math.floor((cw - fw) / 2)}:${Math.floor((ch - fh) / 2)}:color=black@0`);
    const corners = (local: number) => {
      const t = transformAt(c, local);
      const s = t.scale / 100;
      const a = (t.rotation * Math.PI) / 180;
      const cos = Math.cos(a) * s;
      const sin = Math.sin(a) * s;
      const cx = cw / 2 + (t.x / 100) * W;
      const cy = ch / 2 + (t.y / 100) * H;
      return [
        [0, 0],
        [cw, 0],
        [0, ch],
        [cw, ch],
      ].flatMap(([u, v]) => {
        const dx = u - cw / 2;
        const dy = v - ch / 2;
        return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
      });
    };
    const keys = ["x0", "y0", "x1", "y1", "x2", "y2", "x3", "y3"];
    let opts: string[];
    if (moving) {
      const series: number[][] = keys.map(() => []);
      const xs: number[] = [];
      for (let n = 0; n < frames; n++) {
        xs.push(n);
        corners(localAt(n)).forEach((v, i) => series[i].push(v));
      }
      opts = keys.map((k, i) => `${k}='${curveExpr(xs, series[i], "in", 0.25, 2)}'`);
      opts.push("eval=frame");
    } else {
      opts = corners(localAt(0)).map((v, i) => `${keys[i]}=${num(v, 2)}`);
    }
    f.push(`perspective=${opts.join(":")}:sense=destination:interpolation=linear`, `crop=${W}:${H}:${P}:${P}`);
  };

  // ---- Video: tracks bottom-up, runs of touching clips joined with cuts/transitions
  graph.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${sec(totalFrames)},format=${hdr ? "yuv444p10le" : "yuv444p"}[base]`);
  let canvas = "base";
  let clipIdx = 0;
  let runIdx = 0;
  let hasTransitions = false;
  for (const track of tracks) {
    if (track.kind !== "video" || track.hidden) continue;
    const list = trackClips(clips, track.id).filter((c) => Math.round(clipEnd(c) * fps) > Math.round(c.start * fps));
    const runs: Clip[][] = [];
    for (const c of list) {
      const run = runs[runs.length - 1];
      const prev = run?.[run.length - 1];
      if (prev && Math.abs(c.start - clipEnd(prev)) < TOUCH_EPS) run.push(c);
      else runs.push([c]);
    }
    for (const run of runs) {
      // Transition frames into each clip (0 = cut), split around the cut.
      const d = run.map((c, i) => (i === 0 ? 0 : Math.round(transitionLength(clips, c) * fps)));
      let acc = "";
      let accLen = 0;
      run.forEach((c, i) => {
        const sF = Math.round(c.start * fps);
        const eF = Math.round(clipEnd(c) * fps);
        const leadIn = Math.floor(d[i] / 2);
        const leadOut = i + 1 < run.length ? d[i + 1] - Math.floor(d[i + 1] / 2) : 0;
        const frames = eF - sF + leadIn + leadOut;
        const label = videoClip(c, clipIdx++, leadIn, frames, sF);
        if (i === 0) {
          acc = label;
          accLen = frames;
          return;
        }
        const joined = `j${runIdx}_${i}`;
        if (d[i] > 0) {
          hasTransitions = true;
          const type = c.transitionIn.type as Exclude<TransitionType, "cut">;
          if (type === "zoomOut") warnings.add("“Zoom out” transitions become crossfades in this export mode.");
          graph.push(`[${acc}][${label}]xfade=transition=${XFADE[type]}:duration=${sec(d[i])}:offset=${sec(accLen - d[i])}[${joined}]`);
          accLen += frames - d[i];
        } else {
          graph.push(`[${acc}][${label}]concat=n=2:v=1:a=0[${joined}]`);
          accLen += frames;
        }
        acc = joined;
      });
      const placed = `r${runIdx}`;
      graph.push(`[${acc}]setpts=PTS-STARTPTS+${sec(Math.round(run[0].start * fps))}/TB[${placed}]`);
      const next = `o${runIdx}`;
      graph.push(`[${canvas}][${placed}]overlay=eof_action=pass:repeatlast=0:format=${hdr ? "yuv444p10" : "yuv444"}[${next}]`);
      canvas = next;
      runIdx++;
    }
  }
  if (hasTransitions) warnings.add("Transitions use ffmpeg's built-in versions with linear timing (custom timing curves are ignored).");
  const tags = hdr
    ? "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv"
    : "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";
  graph.push(`[${canvas}]format=${hdr ? "yuv420p10le" : "yuv420p"},${tags}[vout]`);

  // ---- Audio
  let audio = false;
  if (s.audio) {
    const anySolo = tracks.some((t) => t.kind === "audio" && t.solo);
    const audible = clips.filter((c) => {
      const t = tracks.find((x) => x.id === c.trackId);
      const m = media.get(c.mediaId);
      return t?.kind === "audio" && !t.muted && (!anySolo || t.solo) && usable(m) && m.kind !== "image" && m.probe?.hasAudio !== false;
    });
    const labels: string[] = [];
    audible.forEach((c, i) => {
      const m = media.get(c.mediaId)!;
      const dur = clipDuration(c);
      const k = addInput(["-vn", "-sn", "-dn", "-ss", num(c.trimIn, 6), "-t", num(dur, 6), "-i", m.path]);
      const f = ["aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo", "asetpts=PTS-STARTPTS", `apad=whole_dur=${num(dur, 6)}`, `atrim=end=${num(dur, 6)}`];

      // Volume keyframes × fades as a gain curve.
      const xs: number[] = [];
      const ys: number[] = [];
      for (let t = 0; t < dur; t += 0.01) {
        xs.push(t);
        ys.push(audioGain(c, c.start + t));
      }
      xs.push(dur);
      ys.push(audioGain(c, c.start + dur));
      const env = curveExpr(xs, ys, "t", 0.002, 4);

      const cmds = new Commands();
      const pending: string[] = [];
      const chain: string[] = [];
      const fxs = c.effects.filter((e) => e.enabled);
      fxs.forEach((fx, j) => {
        const name = `afx${i}_${j}`;
        const v0 = (key: string) => effectValueAt(fx, key, 0);
        // Animated parameters: sampled 20× a second into the asendcmd file (targets are "filter@name").
        const opt = (filter: string, key: string, val: (v: (k: string) => number) => number) => {
          if (!animated(fx)) return;
          for (let t = 0; t <= dur; t += 0.05) {
            cmds.set(`${filter}@${name}`, key, val((kk) => effectValueAt(fx, kk, t)), pending);
            cmds.flush(t, pending);
            pending.length = 0;
          }
        };
        switch (fx.type) {
          case "gain": {
            const lin = (v: (k: string) => number) => Math.pow(10, v("db") / 20);
            chain.push(`volume@${name}=volume=${num(lin(v0), 5)}`);
            opt("volume", "volume", lin);
            break;
          }
          case "pan": {
            const p = (v: (k: string) => number) => Math.max(-1, Math.min(1, v("pan") / 100));
            chain.push(`stereotools@${name}=balance_out=${num(p(v0), 4)}`);
            opt("stereotools", "balance_out", p);
            break;
          }
          case "lowcut":
          case "highcut": {
            const fr = (v: (k: string) => number) => v("freq");
            const filter = fx.type === "lowcut" ? "highpass" : "lowpass";
            chain.push(`${filter}@${name}=f=${num(fr(v0), 1)}:t=q:w=0.707`);
            opt(filter, "f", fr);
            break;
          }
          case "bass":
          case "treble": {
            const g = (v: (k: string) => number) => v("db");
            chain.push(`${fx.type}@${name}=f=${fx.type === "bass" ? 200 : 4000}:g=${num(g(v0), 2)}`);
            opt(fx.type, "g", g);
            break;
          }
          case "echo": {
            if (animated(fx)) warnings.add("Animated echo uses its first keyframe's values in this export mode.");
            const mix = v0("mix") / 100;
            if (mix <= 0) break;
            const time = Math.max(1, v0("time"));
            const fb = Math.min(0.9, v0("feedback") / 100);
            // Feedback delay ≈ a series of taps, each quieter by the feedback amount.
            const delays: string[] = [];
            const decays: string[] = [];
            for (let tap = 0, d = mix; tap < 8 && d > 0.01 && (tap + 1) * time < 90000; tap++, d *= fb) {
              delays.push(num((tap + 1) * time, 1));
              decays.push(num(Math.min(1, d), 4));
              if (fb <= 0) break;
            }
            chain.push(`aecho=in_gain=${num(1 - mix * 0.5, 4)}:out_gain=1:delays=${delays.join("|")}:decays=${decays.join("|")}`);
            break;
          }
        }
      });
      if (!cmds.empty) {
        const name = `a${i}.cmd`;
        files.push({ name, content: cmds.toString() });
        f.push(`asendcmd=f=${name}`);
      }
      if (env !== "1") f.push(`volume=eval=frame:volume='${env}'`);
      f.push(...chain);
      const ms = Math.round(c.start * 1000);
      if (ms > 0) f.push(`adelay=delays=${ms}:all=1`);
      graph.push(`[${k}:a:0]${f.join(",")}[a${i}]`);
      labels.push(`[a${i}]`);
    });
    if (labels.length) {
      audio = true;
      graph.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:dropout_transition=0:duration=longest,apad[aout]`);
    }
  }

  return {
    inputs,
    graph: graph.join(";\n") + "\n",
    files,
    audio,
    vulkan: usedVulkan,
    duration: totalFrames / fps,
    warnings: [...warnings],
  };
}

// ---- Run ---------------------------------------------------------------------------------------

interface HqStatus {
  state: "running" | "done" | "error";
  time: number;
  speed: number;
  output: string | null;
  error: string | null;
}

/** ffmpeg capabilities relevant to this mode (from the cached `ffmpeg_status`). */
export function hqCaps(): HqCaps {
  const caps = useStore.getState().ffmpeg?.caps;
  return { vulkan: !!caps?.gpuFilters, zscale: !!caps?.zscale };
}

/** The plan for the current timeline (also used by the dialog to list warnings). */
export function planFor(opts: ExportSettings, hdr: boolean): HqPlan {
  const st = useStore.getState();
  return buildHqPlan(
    st.clips,
    st.tracks,
    st.media,
    { width: even(st.settings.width * opts.scale), height: even(st.settings.height * opts.scale), fps: opts.fps, hdr, audio: opts.audio },
    hqCaps(),
  );
}

export function startHqExport(opts: ExportSettings, encoder: string, hdr: boolean, onProgress: (p: ExportProgress) => void): ExportHandle {
  let cancelled = false;
  let jobId: string | null = null;

  const done = (async () => {
    const plan = planFor(opts, hdr);
    const frames = Math.round(plan.duration * opts.fps);
    onProgress({ phase: "video", frame: 0, frames, speed: 0, eta: 0 });
    jobId = await invoke<string>("export_hq_begin", {
      opts: {
        path: opts.path,
        inputs: plan.inputs,
        graph: plan.graph,
        files: plan.files,
        audio: plan.audio,
        duration: plan.duration,
        encoder,
        codec: opts.codec,
        quality: opts.quality,
        hdr,
        vulkan: plan.vulkan,
      },
    });
    if (cancelled) await invoke("export_hq_cancel", { id: jobId });
    for (;;) {
      await new Promise((r) => setTimeout(r, 250));
      if (cancelled) await invoke("export_hq_cancel", { id: jobId });
      const st = await invoke<HqStatus>("export_hq_status", { id: jobId });
      if (st.state === "done") return st.output!;
      if (st.state === "error") throw new Error(st.error ?? "ffmpeg failed");
      const frame = Math.min(frames, Math.round(st.time * opts.fps));
      const fps = st.speed * opts.fps;
      onProgress({
        phase: frame >= frames ? "finishing" : "video",
        frame,
        frames,
        speed: fps,
        eta: st.speed > 0 ? (plan.duration - st.time) / st.speed : 0,
      });
    }
  })().catch((e) => {
    throw e instanceof Error ? e : new Error(String(e));
  });

  return {
    cancel: () => {
      cancelled = true;
    },
    done,
  };
}
