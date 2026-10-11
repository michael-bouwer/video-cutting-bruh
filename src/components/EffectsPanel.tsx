import { useState } from "react";
import { useStore } from "../store";
import { canvasFiltersSupported, effectDef, effectsFor, type EffectParam } from "../lib/effects";
import { effectValueAt, keyframeColor, keyframeNear } from "../lib/keyframes";
import { clipDuration, formatTime } from "../lib/timeline";
import { NumberField } from "./NumberField";
import { EasingButton } from "./CurveEditor";
import { tip } from "./Tooltip";
import type { Clip, Effect, TrackKind } from "../types";

/**
 * Pop-out panel (left of the inspector): the selected clip's effect stack with
 * keyframeable parameters, and a library of effects for that kind of clip.
 */
export function EffectsPanel() {
  const setOpen = useStore((s) => s.setEffectsOpen);
  const clip = useStore((s) => (s.selection?.kind === "clip" ? s.clips.find((c) => c.id === s.selection!.clipId) : undefined));
  const kind = useStore((s) => (clip ? s.tracks.find((t) => t.id === clip.trackId)?.kind : undefined));
  const mediaName = useStore((s) => (clip ? s.media.find((m) => m.id === clip.mediaId)?.name : undefined));

  return (
    <aside className="effects-panel" aria-label="Effects">
      <div className="effects-header">
        <span className="panel-title">✦ Effects</span>
        <button className="icon" onClick={() => setOpen(false)} {...tip("Close the effects panel", { label: "Close effects" })}>
          ×
        </button>
      </div>
      <div className="panel effects-body">
        {!clip || !kind ? (
          <>
            <p className="muted small">Select a clip on the timeline to add effects to it. Video and image clips get visual effects; audio clips get audio effects.</p>
            <Library kind="video" clip={null} />
            <Library kind="audio" clip={null} />
          </>
        ) : (
          <>
            <div className="fx-target">
              <span className="muted small">{kind === "audio" ? "Audio clip" : "Clip"}</span>
              <span className="fx-target-name">{mediaName}</span>
            </div>
            <Stack clip={clip} />
            <Library kind={kind} clip={clip} />
          </>
        )}
      </div>
    </aside>
  );
}

function Library({ kind, clip }: { kind: TrackKind; clip: Clip | null }) {
  const addEffect = useStore((s) => s.addEffect);
  return (
    <section className="fx-library">
      <div className="section-title">
        {kind === "video" ? "Visual effects" : "Audio effects"}
        {kind === "video" && !canvasFiltersSupported && (
          <span className="badge error" {...tip("This system's web view can't apply canvas filters, so only the vignette shows in the preview.")}>
            limited
          </span>
        )}
      </div>
      <div className="fx-grid">
        {effectsFor(kind).map((def) => (
          <button
            key={def.type}
            className="fx-tile"
            disabled={!clip}
            onClick={() => clip && addEffect(clip.id, def.type)}
            {...tip(`${def.description}.${clip ? " Click to add it to the selected clip." : ""}`, { title: def.label })}
          >
            <span className="fx-icon" aria-hidden>
              {def.icon}
            </span>
            <span className="fx-label">{def.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function Stack({ clip }: { clip: Clip }) {
  if (clip.effects.length === 0) {
    return <p className="muted small fx-empty">No effects on this clip yet — pick one below.</p>;
  }
  return (
    <section className="fx-stack">
      <div className="section-title">
        Applied
        <span className="muted small" {...tip("Effects run top to bottom; reorder them with ↑ ↓.")}>
          {clip.effects.length}
        </span>
      </div>
      {clip.effects.map((fx, i) => (
        <EffectCard key={fx.id} clip={clip} fx={fx} first={i === 0} last={i === clip.effects.length - 1} />
      ))}
    </section>
  );
}

function EffectCard({ clip, fx, first, last }: { clip: Clip; fx: Effect; first: boolean; last: boolean }) {
  const def = effectDef(fx.type);
  const [collapsed, setCollapsed] = useState(false);
  const st = useStore.getState;
  return (
    <div className={`fx-card ${fx.enabled ? "" : "disabled"}`}>
      <div className="fx-card-head">
        <button className="icon fx-caret" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)} {...tip(collapsed ? "Show parameters" : "Hide parameters")}>
          {collapsed ? "▸" : "▾"}
        </button>
        <label className="fx-enable" {...tip(fx.enabled ? "On — click to bypass this effect" : "Bypassed — click to turn it back on")}>
          <input type="checkbox" checked={fx.enabled} onChange={(e) => st().setEffectEnabled(clip.id, fx.id, e.target.checked)} />
          <span>{def.icon} {def.label}</span>
        </label>
        <div className="fx-actions">
          <button className="icon" disabled={first} onClick={() => st().moveEffect(clip.id, fx.id, -1)} {...tip("Move up (applied earlier)", { label: "Move up" })}>
            ↑
          </button>
          <button className="icon" disabled={last} onClick={() => st().moveEffect(clip.id, fx.id, 1)} {...tip("Move down (applied later)", { label: "Move down" })}>
            ↓
          </button>
          <button className="icon" onClick={() => st().resetEffect(clip.id, fx.id)} {...tip("Reset parameters and remove this effect's keyframes", { label: "Reset effect" })}>
            ↺
          </button>
          <button className="icon" onClick={() => st().removeEffect(clip.id, fx.id)} {...tip("Remove this effect", { label: "Remove effect" })}>
            ×
          </button>
        </div>
      </div>
      {!collapsed && def.params.map((p) => <ParamRow key={p.key} clip={clip} fx={fx} param={p} />)}
    </div>
  );
}

function ParamRow({ clip, fx, param }: { clip: Clip; fx: Effect; param: EffectParam }) {
  const currentTime = useStore((s) => s.currentTime);
  const fps = useStore((s) => s.settings.fps);
  const seek = useStore((s) => s.seek);
  const st = useStore.getState;
  const local = Math.min(clipDuration(clip), Math.max(0, currentTime - clip.start));
  const kfs = fx.keyframes[param.key] ?? [];
  const here = keyframeNear(kfs, local, fps);
  const value = effectValueAt(fx, param.key, local);
  const prev = [...kfs].reverse().find((k) => k.t < local - 0.5 / fps);
  const next = kfs.find((k) => k.t > local + 0.5 / fps);
  const set = (v: number) => st().setEffectParam(clip.id, fx.id, param.key, local, v);

  return (
    <div className="prop-row fx-param">
      <div className="prop-head">
        <button
          className={`kf-toggle ${here ? "on" : kfs.length ? "animated" : ""}`}
          style={here ? { color: keyframeColor(here) } : undefined}
          onClick={() => st().toggleEffectKeyframe(clip.id, fx.id, param.key, local)}
          {...tip(
            here
              ? "There's a keyframe here. Click to remove it."
              : kfs.length
                ? "Animated. Click to add a keyframe at the playhead — or just change the value."
                : `Animate ${param.label.toLowerCase()}: adds a keyframe at the playhead (${formatTime(local, fps)} into the clip).`,
            { label: here ? "Remove keyframe" : "Add keyframe" },
          )}
        >
          ◆
        </button>
        <label>{param.label}</label>
        <button className="kf-nav" disabled={!prev} onClick={() => prev && seek(clip.start + prev.t)} {...tip("Previous keyframe", { label: "Previous keyframe" })}>
          ‹
        </button>
        <button className="kf-nav" disabled={!next} onClick={() => next && seek(clip.start + next.t)} {...tip("Next keyframe", { label: "Next keyframe" })}>
          ›
        </button>
        <NumberField
          className="prop-number"
          value={value}
          min={param.min}
          max={param.max}
          step={param.step}
          unit={param.unit}
          onChange={set}
          aria-label={param.label}
          {...tip(`Drag left/right to change (Shift: faster, Alt: finer), or click to type.${param.neutral !== undefined ? ` ${param.neutral}${param.unit} = no effect.` : ""}`)}
        />
      </div>
      <div className="prop-body">
        <input type="range" min={param.min} max={param.max} step={param.step} value={value} onChange={(e) => set(Number(e.target.value))} aria-label={`${param.label} slider`} />
        {here && (
          <EasingButton
            ease={here.ease}
            curve={here.curve}
            title="Easing to next keyframe"
            onChange={(ease, curve) => st().setEffectKeyframeEase(clip.id, fx.id, param.key, here.id, ease, curve)}
          />
        )}
      </div>
    </div>
  );
}
