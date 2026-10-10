import { useStore } from "../store";
import { clipDuration, clipEnd, formatTime, transitionLength } from "../lib/timeline";
import { propsFor, type PropDef } from "../lib/props";
import type { Clip, Track } from "../types";

/** The selected clip with its derived timing and track. */
interface Placed {
  clip: Clip;
  track: Track;
  start: number;
  end: number;
  duration: number;
}
import { EASINGS, keyframeNear, valueAt } from "../lib/keyframes";
import { TRANSITIONS } from "../lib/transitions";
import { hdrLabel } from "../lib/media";
import type { Easing, TransitionType } from "../types";
import { kbd } from "./ui";
import { ProjectPanel } from "./ProjectPanel";
import { tip } from "./Tooltip";

const TRANSFER_NAMES: Record<number, string> = { 1: "BT.709", 13: "sRGB", 14: "BT.2020 10-bit", 16: "PQ (ST 2084)", 18: "HLG" };
const PRIMARY_NAMES: Record<number, string> = { 1: "BT.709", 9: "BT.2020", 12: "Display P3" };

/** Right-hand panel: clip/transition inspector and project settings tabs. */
export function Inspector() {
  const tab = useStore((s) => s.rightTab);
  const setTab = useStore((s) => s.setRightTab);
  const hasSelection = useStore((s) => s.selection !== null);
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
          {TRANSITIONS.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
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

  return (
    <>
      <div className="panel-title">{isAudio ? "Audio clip" : media?.kind === "image" ? "Image clip" : "Video clip"} · {track.name}</div>
      <div className="clip-name">{media?.name}</div>
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
          <span>{p.container.toUpperCase()}</span>
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

      <div className="section-title" {...tip("Which part of the source file this clip uses, in seconds. Dragging the clip's edges on the timeline does the same — drag back out to restore trimmed footage.")}>
        Trim
      </div>
      <div className="field">
        <label>In</label>
        <input
          type="number"
          step={1 / fps}
          min={0}
          value={clip.trimIn.toFixed(3)}
          {...tip("Start point in the source file (seconds). Keyframes stay on the same video frames when you trim.")}
          onChange={(e) => trimClip(clip.id, Number(e.target.value), clip.trimOut)}
        />
        <span className="value">s</span>
      </div>
      <div className="field">
        <label>Out</label>
        <input
          type="number"
          step={1 / fps}
          max={media?.duration}
          value={clip.trimOut.toFixed(3)}
          {...tip(`End point in the source file (seconds), up to ${media?.duration.toFixed(2) ?? "?"}s`)}
          onChange={(e) => trimClip(clip.id, clip.trimIn, Number(e.target.value))}
        />
        <span className="value">s</span>
      </div>

      {isAudio && (
        <>
          <div className="section-title">Fades</div>
          <div className="field">
            <label>Fade in</label>
            <input
              type="number"
              min={0}
              step={0.1}
              value={clip.fadeIn.toFixed(2)}
              onChange={(e) => setFades(clip.id, { fadeIn: Number(e.target.value) })}
              {...tip("Seconds to fade up from silence. You can also drag the small handle at the clip's top-left on the timeline.")}
            />
            <span className="value">s</span>
          </div>
          <div className="field">
            <label>Fade out</label>
            <input
              type="number"
              min={0}
              step={0.1}
              value={clip.fadeOut.toFixed(2)}
              onChange={(e) => setFades(clip.id, { fadeOut: Number(e.target.value) })}
              {...tip("Seconds to fade down to silence at the end. You can also drag the handle at the clip's top-right.")}
            />
            <span className="value">s</span>
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
      {propsFor(track.kind).map((def) => (
        <PropRow key={def.key} def={def} placed={placed} local={local} />
      ))}

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
        <input
          className="prop-number"
          type="number"
          step={def.step}
          value={Math.round(value * 100) / 100}
          onChange={(e) => set(Number(e.target.value))}
        />
        <span className="unit">{def.unit}</span>
      </div>
      <div className="prop-body">
        <input type="range" min={def.min} max={def.max} step={def.step} value={value} onChange={(e) => set(Number(e.target.value))} />
        {here && (
          <select
            className="ease"
            value={here.ease}
            {...tip("How the value moves from this keyframe to the next. Ease in/out start or end slowly; Hold keeps the value, then jumps at the next keyframe.", { title: "Easing" })}
            onChange={(e) => updateKeyframe(clip.id, def.key, here.id, { ease: e.target.value as Easing })}
          >
            {EASINGS.map((x) => (
              <option key={x.key} value={x.key}>
                {x.label}
              </option>
            ))}
          </select>
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
            <button className="link" onClick={() => seek(placed.start + kf.t)} {...tip("Move the playhead to this keyframe")}>
              {formatTime(kf.t, fps)}
            </button>
            <span>{def.label}</span>
            <span className="muted">
              {Math.round(kf.v * 10) / 10}
              {def.unit}
            </span>
            <span className="muted small kf-ease">{EASINGS.find((e) => e.key === kf.ease)?.label}</span>
            <button className="icon" onClick={() => removeKeyframe(clip.id, def.key, kf.id)} {...tip("Delete this keyframe", { label: "Delete keyframe" })}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
