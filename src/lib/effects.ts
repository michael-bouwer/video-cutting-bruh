import type { Clip, Effect, EffectType, TrackKind } from "../types";
import { effectValueAt } from "./keyframes";

/**
 * Effect registry.
 *
 * Visual effects (clips on video tracks: videos and stills) render through the
 * canvas 2D `filter` (CSS filter functions) plus a hand-drawn vignette. Audio
 * effects (clips on audio tracks) are small Web Audio node chains. Every
 * parameter can be keyframed. To add an effect: extend `EffectType`, add an
 * entry to EFFECTS, and implement it in `cssFilter`/`drawOverlays` or
 * `buildAudioEffect`.
 */

export interface EffectParam {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  /** Value when the effect is added — chosen so the effect is visible/audible straight away. */
  default: number;
  /** Value at which the parameter does nothing (shown as a hint, used for "reset"). */
  neutral?: number;
}

export interface EffectDef {
  type: EffectType;
  label: string;
  icon: string;
  track: TrackKind;
  description: string;
  params: EffectParam[];
}

export const EFFECTS: EffectDef[] = [
  // ---- Visual ----
  {
    type: "brightness",
    label: "Brightness",
    icon: "☀",
    track: "video",
    description: "Make the picture lighter or darker",
    params: [{ key: "amount", label: "Brightness", unit: "%", min: 0, max: 300, step: 1, default: 130, neutral: 100 }],
  },
  {
    type: "contrast",
    label: "Contrast",
    icon: "◐",
    track: "video",
    description: "Increase or reduce the difference between light and dark",
    params: [{ key: "amount", label: "Contrast", unit: "%", min: 0, max: 300, step: 1, default: 130, neutral: 100 }],
  },
  {
    type: "saturation",
    label: "Saturation",
    icon: "🎨",
    track: "video",
    description: "Make colours more vivid, or wash them out",
    params: [{ key: "amount", label: "Saturation", unit: "%", min: 0, max: 400, step: 1, default: 150, neutral: 100 }],
  },
  {
    type: "hue",
    label: "Hue shift",
    icon: "🌈",
    track: "video",
    description: "Rotate every colour around the colour wheel",
    params: [{ key: "angle", label: "Angle", unit: "°", min: -180, max: 180, step: 1, default: 45, neutral: 0 }],
  },
  {
    type: "blur",
    label: "Blur",
    icon: "◌",
    track: "video",
    description: "Soften the picture (radius measured at 1080p, scaled to the project resolution)",
    params: [{ key: "radius", label: "Radius", unit: "px", min: 0, max: 60, step: 0.5, default: 8, neutral: 0 }],
  },
  {
    type: "grayscale",
    label: "Black & white",
    icon: "◑",
    track: "video",
    description: "Remove colour",
    params: [{ key: "amount", label: "Amount", unit: "%", min: 0, max: 100, step: 1, default: 100, neutral: 0 }],
  },
  {
    type: "sepia",
    label: "Sepia",
    icon: "🟫",
    track: "video",
    description: "Warm, old-photo tone",
    params: [{ key: "amount", label: "Amount", unit: "%", min: 0, max: 100, step: 1, default: 80, neutral: 0 }],
  },
  {
    type: "invert",
    label: "Invert",
    icon: "⊘",
    track: "video",
    description: "Turn the picture into its negative",
    params: [{ key: "amount", label: "Amount", unit: "%", min: 0, max: 100, step: 1, default: 100, neutral: 0 }],
  },
  {
    type: "vignette",
    label: "Vignette",
    icon: "◉",
    track: "video",
    description: "Darken the edges to draw the eye to the centre",
    params: [
      { key: "amount", label: "Darkness", unit: "%", min: 0, max: 100, step: 1, default: 60, neutral: 0 },
      { key: "size", label: "Size", unit: "%", min: 0, max: 100, step: 1, default: 55 },
    ],
  },
  // ---- Audio ----
  {
    type: "gain",
    label: "Gain",
    icon: "🔊",
    track: "audio",
    description: "Boost or cut loudness in decibels — can go above 100% volume",
    params: [{ key: "db", label: "Gain", unit: "dB", min: -30, max: 24, step: 0.5, default: 6, neutral: 0 }],
  },
  {
    type: "pan",
    label: "Pan",
    icon: "↔",
    track: "audio",
    description: "Move the sound left or right",
    params: [{ key: "pan", label: "Pan", unit: "", min: -100, max: 100, step: 1, default: -50, neutral: 0 }],
  },
  {
    type: "lowcut",
    label: "Low cut",
    icon: "⌐",
    track: "audio",
    description: "Remove rumble and low frequencies below the cutoff (high-pass filter)",
    params: [{ key: "freq", label: "Cutoff", unit: "Hz", min: 20, max: 2000, step: 5, default: 150, neutral: 20 }],
  },
  {
    type: "highcut",
    label: "High cut",
    icon: "¬",
    track: "audio",
    description: "Remove hiss and high frequencies above the cutoff (low-pass filter) — sounds muffled",
    params: [{ key: "freq", label: "Cutoff", unit: "Hz", min: 200, max: 20000, step: 10, default: 2500, neutral: 20000 }],
  },
  {
    type: "bass",
    label: "Bass",
    icon: "𝄢",
    track: "audio",
    description: "Boost or cut the low end (below ~200 Hz)",
    params: [{ key: "db", label: "Bass", unit: "dB", min: -15, max: 15, step: 0.5, default: 6, neutral: 0 }],
  },
  {
    type: "treble",
    label: "Treble",
    icon: "𝄞",
    track: "audio",
    description: "Boost or cut the high end (above ~4 kHz)",
    params: [{ key: "db", label: "Treble", unit: "dB", min: -15, max: 15, step: 0.5, default: 6, neutral: 0 }],
  },
  {
    type: "echo",
    label: "Echo",
    icon: "◎",
    track: "audio",
    description: "Repeating delay",
    params: [
      { key: "time", label: "Delay", unit: "ms", min: 20, max: 1000, step: 5, default: 280 },
      { key: "feedback", label: "Feedback", unit: "%", min: 0, max: 90, step: 1, default: 40 },
      { key: "mix", label: "Mix", unit: "%", min: 0, max: 100, step: 1, default: 35, neutral: 0 },
    ],
  },
];

export const effectDef = (type: EffectType) => EFFECTS.find((e) => e.type === type)!;
export const effectsFor = (track: TrackKind) => EFFECTS.filter((e) => e.track === track);

export function newEffect(type: EffectType, id: string): Effect {
  const def = effectDef(type);
  return {
    id,
    type,
    enabled: true,
    params: Object.fromEntries(def.params.map((p) => [p.key, p.default])),
    keyframes: Object.fromEntries(def.params.map((p) => [p.key, []])),
  };
}

const activeEffects = (clip: Clip) => (clip.effects ?? []).filter((fx) => fx.enabled);

// ---- Visual ----------------------------------------------------------------------------------

/** Canvas `filter` string for a clip's visual effects at clip-local time `t`. */
export function cssFilter(clip: Clip, t: number, frameHeight: number): string {
  const parts: string[] = [];
  for (const fx of activeEffects(clip)) {
    const v = (k: string) => effectValueAt(fx, k, t);
    switch (fx.type) {
      case "brightness":
        parts.push(`brightness(${v("amount")}%)`);
        break;
      case "contrast":
        parts.push(`contrast(${v("amount")}%)`);
        break;
      case "saturation":
        parts.push(`saturate(${v("amount")}%)`);
        break;
      case "hue":
        parts.push(`hue-rotate(${v("angle")}deg)`);
        break;
      case "blur": {
        const px = (v("radius") * frameHeight) / 1080;
        if (px > 0) parts.push(`blur(${px.toFixed(2)}px)`);
        break;
      }
      case "grayscale":
        parts.push(`grayscale(${v("amount")}%)`);
        break;
      case "sepia":
        parts.push(`sepia(${v("amount")}%)`);
        break;
      case "invert":
        parts.push(`invert(${v("amount")}%)`);
        break;
    }
  }
  return parts.length ? parts.join(" ") : "none";
}

/** Effects drawn on top of the clip's pixels (inside its transformed rectangle). */
export function drawOverlays(ctx: CanvasRenderingContext2D, clip: Clip, t: number, x: number, y: number, w: number, h: number) {
  for (const fx of activeEffects(clip)) {
    if (fx.type !== "vignette") continue;
    const amount = effectValueAt(fx, "amount", t) / 100;
    if (amount <= 0) continue;
    const size = effectValueAt(fx, "size", t) / 100;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const outer = Math.hypot(w, h) / 2;
    const g = ctx.createRadialGradient(cx, cy, outer * Math.max(0.05, size) * 0.9, cx, cy, outer);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${Math.min(1, amount)})`);
    ctx.save();
    ctx.filter = "none";
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
}

/** Whether this webview can apply canvas filters (Safari < 18 / old WebKitGTK can't). */
export const canvasFiltersSupported = (() => {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    return !!ctx && "filter" in ctx;
  } catch {
    return false;
  }
})();

// ---- Audio -------------------------------------------------------------------------------------

export interface AudioEffectNodes {
  input: AudioNode;
  output: AudioNode;
  /** Applies parameter values (called every frame). */
  update: (v: (key: string) => number) => void;
}

const smooth = (param: AudioParam, value: number, ac: BaseAudioContext) => param.setTargetAtTime(value, ac.currentTime, 0.015);

export function buildAudioEffect(ac: AudioContext, type: EffectType): AudioEffectNodes | null {
  switch (type) {
    case "gain": {
      const g = ac.createGain();
      return { input: g, output: g, update: (v) => smooth(g.gain, Math.pow(10, v("db") / 20), ac) };
    }
    case "pan": {
      const p = ac.createStereoPanner();
      return { input: p, output: p, update: (v) => smooth(p.pan, v("pan") / 100, ac) };
    }
    case "lowcut":
    case "highcut": {
      const f = ac.createBiquadFilter();
      f.type = type === "lowcut" ? "highpass" : "lowpass";
      f.Q.value = 0.707;
      return { input: f, output: f, update: (v) => smooth(f.frequency, v("freq"), ac) };
    }
    case "bass":
    case "treble": {
      const f = ac.createBiquadFilter();
      f.type = type === "bass" ? "lowshelf" : "highshelf";
      f.frequency.value = type === "bass" ? 200 : 4000;
      return { input: f, output: f, update: (v) => smooth(f.gain, v("db"), ac) };
    }
    case "echo": {
      const input = ac.createGain();
      const output = ac.createGain();
      const dry = ac.createGain();
      const wet = ac.createGain();
      const delay = ac.createDelay(2);
      const feedback = ac.createGain();
      input.connect(dry).connect(output);
      input.connect(delay);
      delay.connect(feedback).connect(delay);
      delay.connect(wet).connect(output);
      return {
        input,
        output,
        update: (v) => {
          const mix = v("mix") / 100;
          smooth(delay.delayTime, v("time") / 1000, ac);
          smooth(feedback.gain, Math.min(0.9, v("feedback") / 100), ac);
          smooth(wet.gain, mix, ac);
          smooth(dry.gain, 1 - mix * 0.5, ac);
        },
      };
    }
    default:
      return null;
  }
}
