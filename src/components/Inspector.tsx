import { useStore } from "../store";
import { clipDuration, clipEnd, formatTime, transitionLength } from "../lib/timeline";
import { propsFor, SPEED_MAX, SPEED_MIN, type PropDef } from "../lib/props";
import { CLIP_COLORS, clipName } from "../lib/clipLabels";
import { TITLE_FONTS } from "../lib/titles";
import { hasSpeedChange, speedRange } from "../lib/speed";
import { copyAttributes, pasteAttributes, useAttributes } from "../lib/attributes";
import type { TitleStyle } from "../types";
import type { Clip, Track } from "../types";

/** The selected clip with its derived timing and track. */
interface Placed {
  clip: Clip;
  track: Track;
  start: number;
  end: number;
  duration: number;
}
import { keyframeColor, keyframeNear, valueAt } from "../lib/keyframes";
import { easingLabel } from "../lib/easing";
import { TRANSITIONS } from "../lib/transitions";
import { hdrLabel } from "../lib/media";
import type { TransitionType } from "../types";
import { kbd } from "./ui";
import { NumberField } from "./NumberField";
import { EasingButton } from "./CurveEditor";
import { ProjectPanel } from "./ProjectPanel";
import { tip } from "./Tooltip";

const TRANSFER_NAMES: Record<number, string> = { 1: "BT.709", 13: "sRGB", 14: "BT.2020 10-bit", 16: "PQ (ST 2084)", 18: "HLG" };
const PRIMARY_NAMES: Record<number, string> = { 1: "BT.709", 9: "BT.2020", 12: "Display P3" };

/** Right-hand panel: clip/transition inspector and project settings tabs. */
export function Inspector() {
  const tab = useStore((s) => s.rightTab);
  const setTab = useStore((s) => s.setRightTab);
  const hasSelection = useStore((s) => s.selection !== null);
  const effectsOpen = useStore((s) => s.effectsOpen);
  const setEffectsOpen = useStore((s) => s.setEffectsOpen);
  const fxCount = useStore((s) => (s.selection?.kind === "clip" ? (s.clips.find((c) => c.id === s.selection!.clipId)?.effects.length ?? 0) : 0));
  const tabs = [
    { key: "inspector" as const, label: "Inspector", tip: "Properties of the selected clip or transition" },
    { key: "project" as const, label: "Project", tip: "Resolution, frame rate, HDR, preview proxies and storage for this project" },
  ];
  return (
    <aside className="right-panel inspector">
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`tab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
            {...tip(t.tip)}
          >
            {t.label}
            {t.key === "inspector" && hasSelection && tab !== "inspector" && <span className="tab-dot" />}
          </button>
        ))}
        <button
          className={`tab fx-toggle ${effectsOpen ? "active-fx" : ""}`}
          aria-pressed={effectsOpen}
          onClick={() => setEffectsOpen(!effectsOpen)}
          {...tip("Show or hide the effects panel: brightness, blur, vignette… for video and images; gain, EQ, echo… for audio — all keyframeable.", { title: "Effects" })}
        >
          <span className="fx-toggle-arrow">{effectsOpen ? "◂" : "▸"} </span>✦<span className="fx-toggle-label"> Effects</span>
          {fxCount > 0 && <span className="fx-count">{fxCount}</span>}
        </button>
      </div>
      <div className="panel tab-body" role="tabpanel">
        {tab === "project" ? <ProjectPanel /> : <InspectorBody />}
      </div>
    </aside>
  );
}

function InspectorBody() {
  const selection = useStore((s) => s.selection);
  const clips = useStore((s) => s.clips);
  const tracks = useStore((s) => s.tracks);
  const clip = selection ? clips.find((c) => c.id === selection.clipId) : undefined;
  const track = clip && tracks.find((t) => t.id === clip.trackId);
  const placed: Placed | undefined =
    clip && track ? { clip, track, start: clip.start, end: clipEnd(clip), duration: clipDuration(clip) } : undefined;

  return (
    <>
      {!placed ? (
        <div className="muted inspector-empty">
          Select a clip or transition on the timeline.
          <ul className="shortcuts">
            <li><kbd>Space</kbd> play / pause</li>
            <li><kbd>S</kbd> split at playhead</li>
            <li><kbd>K</kbd> keyframe all transform props</li>
            <li><kbd>Del</kbd> delete selection</li>
            <li><kbd>←</kbd>/<kbd>→</kbd> step frame (Shift: 1s)</li>
            <li><kbd>{kbd("Mod+Z")}</kbd> / <kbd>{kbd("Mod+Shift+Z")}</kbd> undo / redo</li>
            <li><kbd>{kbd("Mod+D")}</kbd> duplicate clip</li>
            <li><kbd>\</kbd> zoom timeline to fit</li>
            <li><kbd>M</kbd> add marker · <kbd>[</kbd>/<kbd>]</kbd> previous / next marker</li>
            <li><kbd>{kbd("Mod+T")}</kbd> add text</li>
            <li><kbd>{kbd("Mod+Alt+C")}</kbd> / <kbd>{kbd("Mod+Alt+V")}</kbd> copy / paste attributes</li>
            <li><kbd>{kbd("Mod+S")}</kbd> save · <kbd>{kbd("Mod+O")}</kbd> open</li>
          </ul>
        </div>
      ) : selection!.kind === "transition" ? (
        <TransitionInspector placed={placed} />
      ) : (
        <ClipInspector placed={placed} />
      )}
    </>
  );
}

function TransitionInspector({ placed }: { placed: Placed }) {
  const setTransition = useStore((s) => s.setTransition);
  const transIn = useStore((s) => transitionLength(s.clips, placed.clip));
  const { type, duration } = placed.clip.transitionIn;
  return (
    <>
      <div className="panel-title">Transition</div>
      <div className="field">
        <label>Type</label>
        <select
          value={type}
          onChange={(e) => setTransition(placed.clip.id, { type: e.target.value as TransitionType })}
          {...tip("How the previous clip changes into this one. \"Cut\" removes the transition (Delete key does too).")}
        >
          {[...new Set(TRANSITIONS.map((t) => t.group))].map((g) => (
            <optgroup key={g} label={g}>
              {TRANSITIONS.filter((t) => t.group === g).map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Duration</label>
        <input
          type="range"
          min={0.1}
          max={5}
          step={0.05}
          value={duration}
          disabled={type === "cut"}
          onChange={(e) => setTransition(placed.clip.id, { duration: Number(e.target.value) })}
          {...tip("Length of the blend, centred on the cut. It can't be longer than either clip.")}
        />
        <span className="value">{duration.toFixed(2)}s</span>
      </div>
      {type !== "cut" && (
        <div className="field">
          <label>Timing</label>
          <EasingButton
            ease={placed.clip.transitionIn.ease ?? "easeInOut"}
            curve={placed.clip.transitionIn.curve}
            title="Transition timing"
            onChange={(ease, curve) => setTransition(placed.clip.id, { ease, curve: ease === "custom" ? curve : undefined })}
          />
        </div>
      )}
      {type !== "cut" && transIn < duration - 1e-3 && (
        <p className="muted small">
          {transIn > 0
            ? `Limited to ${transIn.toFixed(2)}s (the length of the shorter clip).`
            : "The clips no longer touch, so this transition is inactive. Move them together again to use it."}
        </p>
      )}
      <p className="muted small">The transition is centred on the cut: each clip runs on for half its length past the cut, using extra footage beyond its trim point where available.</p>
    </>
  );
}

function ClipInspector({ placed }: { placed: Placed }) {
  const { clip, track } = placed;
  const isAudio = track.kind === "audio";
  // Select a number, not a new array: zustand selectors must return stable values.
  const linkedCount = useStore((s) => (clip.linkId ? s.clips.filter((c) => c.linkId === clip.linkId && c.id !== clip.id).length : 0));
  const unlinkClip = useStore((s) => s.unlinkClip);
  const setFades = useStore((s) => s.setFades);
  const media = useStore((s) => s.media.find((m) => m.id === clip.mediaId));
  const currentTime = useStore((s) => s.currentTime);
  const fps = useStore((s) => s.settings.fps);
  const trimClip = useStore((s) => s.trimClip);
  const resetTransform = useStore((s) => s.resetTransform);
  const removeClip = useStore((s) => s.removeClip);
  const local = Math.min(placed.duration, Math.max(0, currentTime - placed.start));
  const inside = currentTime >= placed.start && currentTime <= placed.end;
  const p = media?.probe;

  const setClipMeta = useStore((s) => s.setClipMeta);
  const hasCopied = useAttributes((s) => !!s.copied);
  const isStill = !!clip.title || media?.kind === "image";
  const groups = (g: PropDef["group"]) => propsFor(track.kind).filter((d) => d.group === g && !(d.mediaOnly && isStill));

  return (
    <>
      <div className="panel-title">
        {clip.title ? "Text clip" : isAudio ? "Audio clip" : media?.kind === "image" ? "Image clip" : "Video clip"} · {track.name}
      </div>
      <input
        key={clip.id}
        className="clip-name-field"
        defaultValue={clip.label ?? ""}
        placeholder={clipName({ ...clip, label: undefined }, media)}
        onBlur={(e) => setClipMeta([clip.id], { label: e.target.value.trim() })}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        aria-label="Clip name"
        {...tip("Name shown on the timeline (leave empty to use the file name). You can also double-click the clip's name on the timeline.")}
      />
      <div className="swatch-row inspector-swatches" {...tip("Colour label on the timeline")}>
        {CLIP_COLORS.map((c) => (
          <button
            key={c.key}
            className={`swatch ${clip.color === c.key ? "on" : ""}`}
            style={{ background: `hsl(${c.hue} 60% 50%)` }}
            aria-label={c.label}
            onClick={() => setClipMeta([clip.id], { color: clip.color === c.key ? "" : c.key })}
          />
        ))}
        <span className="grow" />
        <button className="small-btn" onClick={() => copyAttributes(clip.id)} {...tip("Copy this clip's settings (transform, crop, speed, effects, volume, colour) to paste onto other clips.", { kbd: kbd("Mod+Alt+C") })}>
          Copy attrs
        </button>
        <button className="small-btn" disabled={!hasCopied} onClick={() => pasteAttributes()} {...tip("Paste copied settings onto the selected clips — you choose which ones.", { kbd: kbd("Mod+Alt+V") })}>
          Paste…
        </button>
      </div>
      <dl className="stats">
        <dt>Starts at</dt>
        <dd>{formatTime(placed.start, fps)}</dd>
        <dt>Length</dt>
        <dd>{formatTime(placed.duration, fps)}</dd>
      </dl>
      {clip.linkId && (
        <div className="link-row">
          <span className="muted small" {...tip("Linked clips move, trim, split and delete together. Shift+Delete removes only this one.")}>
            ⛓ Linked with its {isAudio ? "video" : "audio"}{linkedCount > 1 ? ` (${linkedCount})` : ""}
          </span>
          <button onClick={() => unlinkClip(clip.id)} {...tip(`Separate the ${isAudio ? "audio from its video" : "video from its audio"} so each can be moved and trimmed on its own`)}>
            Unlink
          </button>
        </div>
      )}
      {p && !isAudio && (
        <div className="media-info small">
          <span>{p.container?.toUpperCase()}</span>
          {p.videoCodec && <span>{p.videoCodec}</span>}
          {p.bitDepth && <span>{p.bitDepth}-bit</span>}
          {p.color?.primaries != null && <span>{PRIMARY_NAMES[p.color.primaries] ?? `prim ${p.color.primaries}`}</span>}
          {p.color?.transfer != null && <span>{TRANSFER_NAMES[p.color.transfer] ?? `trc ${p.color.transfer}`}</span>}
          {p.hdr && (
            <span className="badge hdr" {...tip("Captured in HDR. The preview shows it tone-mapped to normal (SDR) range.")}>
              {hdrLabel(p.hdr)}
            </span>
          )}
        </div>
      )}

      {clip.title && <TitleEditor clipId={clip.id} style={clip.title} />}

      {!clip.title && (
      <>
      <div className="section-title" {...tip("Which part of the source file this clip uses, in seconds. Dragging the clip's edges on the timeline does the same — drag back out to restore trimmed footage.")}>
        Trim
      </div>
      <div className="field">
        <label>In</label>
        <NumberField
          value={clip.trimIn}
          min={0}
          max={clip.trimOut - 0.1}
          step={0.01}
          precision={3}
          unit="s"
          onChange={(v) => trimClip(clip.id, v, clip.trimOut)}
          aria-label="In point"
          {...tip("Start point in the source file (seconds). Keyframes stay on the same video frames when you trim. Drag left/right to change (Shift: faster, Alt: finer), or click to type.")}
        />
      </div>
      <div className="field">
        <label>Out</label>
        <NumberField
          value={clip.trimOut}
          min={clip.trimIn + 0.1}
          max={media?.kind === "image" ? 3600 : (media?.duration ?? clip.trimOut)}
          step={0.01}
          precision={3}
          unit="s"
          onChange={(v) => trimClip(clip.id, clip.trimIn, v)}
          aria-label="Out point"
          {...tip(`End point in the source file (seconds), up to ${media?.duration.toFixed(2) ?? "?"}s. Drag left/right to change (Shift: faster, Alt: finer), or click to type.`)}
        />
      </div>
      </>
      )}

      {groups("speed").length > 0 && <SpeedSection placed={placed} local={local} />}

      {isAudio && (
        <>
          <div className="section-title">Fades</div>
          <div className="field">
            <label>Fade in</label>
            <NumberField
              value={clip.fadeIn}
              min={0}
              max={placed.duration}
              step={0.05}
              precision={2}
              unit="s"
              onChange={(v) => setFades(clip.id, { fadeIn: v })}
              aria-label="Fade in"
              {...tip("Seconds to fade up from silence. You can also drag the small handle at the clip's top-left on the timeline. Drag left/right to change (Shift: faster, Alt: finer), or click to type.")}
            />
          </div>
          <div className="field">
            <label>Fade out</label>
            <NumberField
              value={clip.fadeOut}
              min={0}
              max={placed.duration}
              step={0.05}
              precision={2}
              unit="s"
              onChange={(v) => setFades(clip.id, { fadeOut: v })}
              aria-label="Fade out"
              {...tip("Seconds to fade down to silence at the end. You can also drag the handle at the clip's top-right. Drag left/right to change (Shift: faster, Alt: finer), or click to type.")}
            />
          </div>
        </>
      )}

      <div className="section-title">
        {isAudio ? "Volume" : "Transform"}
        <span
          className="muted small"
          {...tip(
            inside
              ? "Values below are shown at the playhead, as time from this clip's first frame. Move the playhead to see or edit other moments."
              : "The playhead isn't over this clip, so values from its nearest end are shown. Move the playhead over the clip to keyframe it.",
          )}
        >
          {inside ? `@ ${formatTime(local, fps)} in clip` : "playhead outside clip"}
        </span>
      </div>
      {groups(isAudio ? "volume" : "transform").map((def) => (
        <PropRow key={def.key} def={def} placed={placed} local={local} />
      ))}

      {!isAudio && (
        <>
          <div className="section-title">
            Crop
            <span className="muted small">% of the picture from each edge</span>
          </div>
          {groups("crop").map((def) => (
            <PropRow key={def.key} def={def} placed={placed} local={local} />
          ))}
          <div className="inspector-actions">
            <button onClick={() => zoomToCrop(placed, local)} {...tip("Scale and move the clip so the cropped area fills the frame (at the playhead; keyframed if the transform is animated). Great for zooming into a minimap or scope.")}>
              Zoom to crop
            </button>
            <button onClick={() => resetCrop(placed, local)} {...tip("Remove the crop (and its keyframes)")}>
              Reset crop
            </button>
          </div>
        </>
      )}

      <KeyframeList placed={placed} />

      <div className="inspector-actions">
        <button
          onClick={() => resetTransform(clip.id)}
          {...tip(isAudio ? "Remove volume keyframes and fades. Undo restores them." : "Remove all keyframes and reset position, scale, rotation and opacity to their defaults. Undo restores them.")}
        >
          {isAudio ? "Reset audio" : "Reset transform"}
        </button>
        <button
          className="danger"
          onClick={() => removeClip(clip.id)}
          {...tip(`Remove this clip${clip.linkId ? " and its linked clip" : ""} from the timeline (the file stays in the media bin). Shift+Delete removes only this one.`, { kbd: "Del" })}
        >
          Delete clip
        </button>
      </div>
    </>
  );
}

function PropRow({ def, placed, local }: { def: PropDef; placed: Placed; local: number }) {
  const { clip } = placed;
  const fps = useStore((s) => s.settings.fps);
  const setPropValue = useStore((s) => s.setPropValue);
  const toggleKeyframe = useStore((s) => s.toggleKeyframe);
  const updateKeyframe = useStore((s) => s.updateKeyframe);
  const seek = useStore((s) => s.seek);

  const kfs = clip.keyframes[def.key];
  const here = keyframeNear(kfs, local, fps);
  const value = valueAt(clip, def.key, local);
  const prev = [...kfs].reverse().find((k) => k.t < local - 0.5 / fps);
  const next = kfs.find((k) => k.t > local + 0.5 / fps);
  const set = (v: number) => Number.isFinite(v) && setPropValue(clip.id, def.key, local, v);

  return (
    <div className="prop-row">
      <div className="prop-head">
        <button
          className={`kf-toggle ${here ? "on" : kfs.length ? "animated" : ""}`}
          style={here ? { color: keyframeColor(here) } : undefined}
          onClick={() => toggleKeyframe(clip.id, def.key, local)}
          {...tip(
            here
              ? "There's a keyframe here. Click to remove it."
              : kfs.length
                ? "This property is animated. Click to add a keyframe at the playhead — or just change the value, which adds one automatically. Press K to keyframe every property at once."
                : "Animate this property: adds a keyframe at the playhead. After that, changing the value at another time adds a keyframe there, and the app animates between them. Press K to keyframe every property at once.",
            { title: here ? "Keyframe" : kfs.length ? "Animated" : "Not animated", label: here ? "Remove keyframe" : "Add keyframe" },
          )}
        >
          ◆
        </button>
        <label>{def.label}</label>
        <button className="kf-nav" disabled={!prev} onClick={() => prev && seek(placed.start + prev.t)} {...tip("Jump to the previous keyframe", { label: "Previous keyframe" })}>
          ‹
        </button>
        <button className="kf-nav" disabled={!next} onClick={() => next && seek(placed.start + next.t)} {...tip("Jump to the next keyframe", { label: "Next keyframe" })}>
          ›
        </button>
        <NumberField
          className="prop-number"
          value={value}
          min={def.key === "speed" ? SPEED_MIN : def.min === -100 ? -1000 : def.min}
          max={def.key === "scale" ? 2000 : def.key === "speed" ? SPEED_MAX : def.max}
          step={def.step}
          // Drag speed follows the slider's range even though typing can go beyond it.
          perPx={Math.max(def.step / 2, (def.max - def.min) / 600)}
          unit={def.unit}
          onChange={set}
          aria-label={def.label}
          {...tip("Drag left/right to change (Shift: faster, Alt: finer), or click to type. Typed values can go beyond the slider's range.")}
        />
      </div>
      <div className="prop-body">
        <input type="range" min={def.min} max={def.max} step={def.step} value={value} onChange={(e) => set(Number(e.target.value))} />
        {here && (
          <EasingButton
            ease={here.ease}
            curve={here.curve}
            title="Easing to next keyframe"
            onChange={(ease, curve) => updateKeyframe(clip.id, def.key, here.id, { ease, curve: ease === "custom" ? curve : undefined })}
          />
        )}
      </div>
    </div>
  );
}

function KeyframeList({ placed }: { placed: Placed }) {
  const { clip } = placed;
  const fps = useStore((s) => s.settings.fps);
  const seek = useStore((s) => s.seek);
  const removeKeyframe = useStore((s) => s.removeKeyframe);
  const rerollKeyframeColor = useStore((s) => s.rerollKeyframeColor);
  const rows = propsFor(placed.track.kind)
    .flatMap((def) => clip.keyframes[def.key].map((kf) => ({ def, kf })))
    .sort((a, b) => a.kf.t - b.kf.t);
  if (rows.length === 0) {
    return <p className="muted small">No keyframes yet — click ◆ next to a property to animate it.</p>;
  }
  return (
    <>
      <div className="section-title">Keyframes</div>
      <ul className="kf-list">
        {rows.map(({ def, kf }) => (
          <li key={kf.id}>
            <button
              className="kf-swatch"
              style={{ background: keyframeColor(kf) }}
              onClick={() => rerollKeyframeColor({ clipId: clip.id, fx: null, key: def.key, kfId: kf.id })}
              {...tip("This keyframe's colour (the same in the timeline lanes). Click for a new random colour.", { label: "New colour" })}
            />
            <button className="link" onClick={() => seek(placed.start + kf.t)} {...tip("Move the playhead to this keyframe")}>
              {formatTime(kf.t, fps)}
            </button>
            <span>{def.label}</span>
            <span className="muted">
              {Math.round(kf.v * 10) / 10}
              {def.unit}
            </span>
            <span className="muted small kf-ease">{easingLabel(kf.ease)}</span>
            <button className="icon" onClick={() => removeKeyframe(clip.id, def.key, kf.id)} {...tip("Delete this keyframe", { label: "Delete keyframe" })}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

const SPEED_PRESETS = [25, 50, 100, 150, 200, 400];

function SpeedSection({ placed, local }: { placed: Placed; local: number }) {
  const { clip } = placed;
  const setSpeed = useStore((s) => s.setSpeed);
  const def = propsFor(placed.track.kind).find((d) => d.key === "speed")!;
  const ramp = clip.keyframes.speed.length > 0;
  const [lo, hi] = speedRange(clip);
  return (
    <>
      <div className="section-title">
        Speed
        <span className="muted small">
          {ramp ? `ramp ${Math.round(lo * 100)}–${Math.round(hi * 100)}%` : hasSpeedChange(clip) ? `${Math.round(lo * 100)}%` : "normal"}
        </span>
      </div>
      <div className="speed-presets">
        {SPEED_PRESETS.map((p) => (
          <button
            key={p}
            className={!ramp && Math.round(clip.base.speed) === p ? "active" : ""}
            onClick={() => setSpeed([clip.id], p)}
            {...tip(p < 100 ? `Slow motion at ${p}% — 120 fps recordings stay smooth down to 50%` : p === 100 ? "Normal speed (removes any ramp)" : `Fast forward at ${p}%`)}
          >
            {p}%
          </button>
        ))}
      </div>
      <PropRow def={def} placed={placed} local={local} />
      <p className="muted small">
        Changing the speed changes the clip's length{clip.linkId ? " (its linked audio follows)" : ""}. Keyframe it (◆) for speed ramps — e.g. normal → 30% at the kill → normal. Audio keeps its pitch.
      </p>
    </>
  );
}

/** Scales and moves a clip so its cropped area fills the frame (rotation is left as is). */
function zoomToCrop(placed: Placed, local: number) {
  const st = useStore.getState();
  const { clip } = placed;
  const { width: W, height: H } = st.settings;
  const m = st.media.find((x) => x.id === clip.mediaId);
  const sw = clip.title ? W : m?.width || W;
  const sh = clip.title ? H : m?.height || H;
  const fit = Math.min(W / sw, H / sh);
  const dw = sw * fit;
  const dh = sh * fit;
  const v = (k: "cropLeft" | "cropRight" | "cropTop" | "cropBottom") => valueAt(clip, k, local) / 100;
  const [l, r, t, b] = [v("cropLeft"), v("cropRight"), v("cropTop"), v("cropBottom")];
  const cw = dw * Math.max(0.01, 1 - l - r);
  const ch = dh * Math.max(0.01, 1 - t - b);
  const s = Math.min(W / cw, H / ch);
  // The crop area's centre, relative to the clip's centre, moved to the frame centre.
  const ox = (dw * (l - r)) / 2;
  const oy = (dh * (t - b)) / 2;
  st.setPropValue(clip.id, "scale", local, s * 100);
  st.setPropValue(clip.id, "x", local, ((-ox * s) / W) * 100);
  st.setPropValue(clip.id, "y", local, ((-oy * s) / H) * 100);
}

function resetCrop(placed: Placed, local: number) {
  const st = useStore.getState();
  for (const k of ["cropLeft", "cropRight", "cropTop", "cropBottom"] as const) {
    for (const kf of placed.clip.keyframes[k]) st.removeKeyframe(placed.clip.id, k, kf.id);
    st.setPropValue(placed.clip.id, k, local, 0);
  }
}

function TitleEditor({ clipId, style }: { clipId: string; style: TitleStyle }) {
  const update = useStore((s) => s.updateTitle);
  const set = (patch: Partial<TitleStyle>) => update(clipId, patch);
  return (
    <>
      <div className="section-title">Text</div>
      <textarea
        className="title-text"
        value={style.text}
        rows={3}
        onChange={(e) => set({ text: e.target.value })}
        onKeyDown={(e) => e.stopPropagation()}
        aria-label="Text"
        {...tip("The text to show. Use Enter for more lines. Move, scale and fade it with the Transform properties below.")}
      />
      <div className="field">
        <label>Font</label>
        <select value={TITLE_FONTS.some((f) => f.value === style.font) ? style.font : TITLE_FONTS[0].value} onChange={(e) => set({ font: e.target.value })}>
          {TITLE_FONTS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Size</label>
        <NumberField value={style.size} min={8} max={600} step={1} precision={0} unit="px" onChange={(v) => set({ size: v })} aria-label="Text size" {...tip("Text height in pixels at 1080p (scales with the output resolution)")} />
      </div>
      <div className="field title-style-row">
        <label>Style</label>
        <input type="color" value={style.color} onChange={(e) => set({ color: e.target.value })} aria-label="Text colour" {...tip("Text colour")} />
        <button className={style.bold ? "active" : ""} onClick={() => set({ bold: !style.bold })} {...tip("Bold")}>
          <b>B</b>
        </button>
        <button className={style.italic ? "active" : ""} onClick={() => set({ italic: !style.italic })} {...tip("Italic")}>
          <i>I</i>
        </button>
        {(["left", "center", "right"] as const).map((a) => (
          <button key={a} className={style.align === a ? "active" : ""} onClick={() => set({ align: a })} {...tip(`Align ${a} (for several lines)`)}>
            {a === "left" ? "⇤" : a === "center" ? "≡" : "⇥"}
          </button>
        ))}
      </div>
      <div className="field title-style-row">
        <label>Outline</label>
        <NumberField value={style.outline} min={0} max={40} step={0.5} precision={1} unit="px" onChange={(v) => set({ outline: v })} aria-label="Outline width" />
        <input type="color" value={style.outlineColor} onChange={(e) => set({ outlineColor: e.target.value })} aria-label="Outline colour" {...tip("Outline colour")} />
        <label className="checkbox-row">
          <input type="checkbox" checked={style.shadow} onChange={(e) => set({ shadow: e.target.checked })} /> Shadow
        </label>
      </div>
      <div className="field title-style-row">
        <label>Box</label>
        <input type="checkbox" checked={style.box} onChange={(e) => set({ box: e.target.checked })} aria-label="Background box" {...tip("Background box behind the text")} />
        <input type="color" value={style.boxColor} disabled={!style.box} onChange={(e) => set({ boxColor: e.target.value })} aria-label="Box colour" />
        <NumberField value={style.boxOpacity} min={0} max={100} step={1} precision={0} unit="%" onChange={(v) => set({ boxOpacity: v })} aria-label="Box opacity" />
      </div>
    </>
  );
}
