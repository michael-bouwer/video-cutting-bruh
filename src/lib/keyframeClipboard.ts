import { useStore } from "../store";
import { PROP_KEYS, propsFor } from "./props";
import { clipDuration, clipEnd } from "./timeline";
import type { AnimProp, Clip, EffectType, Easing, Keyframe, KeyframeRef } from "../types";

/**
 * Copy / paste of keyframes selected in the timeline's keyframe lanes.
 *
 * Copied keyframes remember what they animate (a transform property, or an
 * effect *type* + parameter) and their timing relative to the earliest copied
 * keyframe, so a paste at the playhead keeps their spacing. Pasting into a clip
 * without that effect adds the effect first.
 */
interface CopiedKeyframe {
  fxType: EffectType | null;
  key: string;
  /** Seconds after the earliest copied keyframe. */
  dt: number;
  v: number;
  ease: Easing;
}

let clipboard: { items: CopiedKeyframe[]; sourceClipId: string } | null = null;

export const hasCopiedKeyframes = () => !!clipboard?.items.length;

/** Resolves a ref to its clip and keyframe (null if it no longer exists). */
export function resolveRef(clips: Clip[], ref: KeyframeRef): { clip: Clip; kf: Keyframe; fxType: EffectType | null } | null {
  const clip = clips.find((c) => c.id === ref.clipId);
  if (!clip) return null;
  if (ref.fx) {
    const fx = clip.effects.find((e) => e.id === ref.fx);
    const kf = fx?.keyframes[ref.key]?.find((k) => k.id === ref.kfId);
    return fx && kf ? { clip, kf, fxType: fx.type } : null;
  }
  if (!PROP_KEYS.includes(ref.key as AnimProp)) return null;
  const kf = clip.keyframes[ref.key as AnimProp].find((k) => k.id === ref.kfId);
  return kf ? { clip, kf, fxType: null } : null;
}

export function copyKeyframes(cut = false): boolean {
  const { clips, kfSelection, notify, deleteKeyframes } = useStore.getState();
  const resolved = kfSelection.map((ref) => resolveRef(clips, ref)).filter((x): x is NonNullable<typeof x> => !!x);
  if (resolved.length === 0) return false;
  const abs = (r: (typeof resolved)[number]) => r.clip.start + r.kf.t;
  const t0 = Math.min(...resolved.map(abs));
  clipboard = {
    sourceClipId: resolved[0].clip.id,
    items: resolved.map((r, i) => ({ fxType: r.fxType, key: kfSelection[i].key, dt: abs(r) - t0, v: r.kf.v, ease: r.kf.ease })),
  };
  if (cut) deleteKeyframes(kfSelection);
  notify("info", `${cut ? "Cut" : "Copied"} ${resolved.length} keyframe${resolved.length === 1 ? "" : "s"} — select a clip, move the playhead and press ${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}V to paste.`);
  return true;
}

/** Pastes at the playhead into the selected clip (or the clip they were copied from). */
export function pasteKeyframes(): boolean {
  if (!clipboard?.items.length) return false;
  const st = useStore.getState();
  const selected = st.selection?.kind === "clip" ? st.clips.find((c) => c.id === st.selection!.clipId) : undefined;
  const target = selected ?? st.clips.find((c) => c.id === clipboard!.sourceClipId);
  if (!target) {
    st.notify("info", "Select a clip to paste the keyframes into.");
    return true;
  }
  const kind = st.tracks.find((t) => t.id === target.trackId)?.kind ?? "video";
  const allowed = new Set<string>(propsFor(kind).map((p) => p.key));
  const anchor = st.currentTime - target.start;
  if (anchor < -1e-6 || st.currentTime > clipEnd(target) + 1e-6) {
    st.notify("info", "Move the playhead over the target clip — keyframes are pasted at the playhead.");
    return true;
  }

  let skipped = 0;
  const items: Parameters<typeof st.insertKeyframes>[0] = [];
  for (const it of clipboard.items) {
    let fxId: string | null = null;
    if (it.fxType) {
      let fx = useStore.getState().clips.find((c) => c.id === target.id)!.effects.find((e) => e.type === it.fxType);
      if (!fx) {
        // Audio effects only fit audio clips and visual effects only visual ones.
        const visual = !["gain", "pan", "lowcut", "highcut", "bass", "treble", "echo"].includes(it.fxType);
        if (visual !== (kind === "video")) {
          skipped++;
          continue;
        }
        useStore.getState().addEffect(target.id, it.fxType);
        fx = useStore.getState().clips.find((c) => c.id === target.id)!.effects.find((e) => e.type === it.fxType)!;
      }
      fxId = fx.id;
    } else if (!allowed.has(it.key)) {
      skipped++;
      continue;
    }
    const t = anchor + it.dt;
    if (t > clipDuration(target) + 1e-6) {
      skipped++;
      continue;
    }
    items.push({ clipId: target.id, fx: fxId, key: it.key, t, v: it.v, ease: it.ease });
  }
  const refs = useStore.getState().insertKeyframes(items);
  useStore.getState().selectKeyframes(refs);
  if (skipped) st.notify("info", `Pasted ${refs.length}; skipped ${skipped} that don't fit this clip (wrong kind of property, or past its end).`);
  return true;
}
