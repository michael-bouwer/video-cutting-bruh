import { useEffect, useState } from "react";
import { useStore, type AttributePart } from "../store";
import { ATTRIBUTE_PARTS, useAttributes } from "../lib/attributes";

const REMEMBER_KEY = "vcb.pasteParts";

function rememberedParts(): AttributePart[] {
  try {
    const v = JSON.parse(localStorage.getItem(REMEMBER_KEY) ?? "null");
    if (Array.isArray(v)) return v;
  } catch {
    /* default below */
  }
  return ["transform", "crop", "effects", "volume"];
}

/** "Paste attributes" — pick which groups of the copied clip's settings to apply. */
export function PasteAttributesDialog() {
  const targets = useAttributes((s) => s.pasteTargets);
  const copied = useAttributes((s) => s.copied);
  const [parts, setParts] = useState<AttributePart[]>(rememberedParts);
  const close = () => useAttributes.setState({ pasteTargets: null });

  useEffect(() => {
    if (!targets) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [targets]);

  if (!targets || !copied) return null;
  const toggle = (p: AttributePart) => setParts((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  const apply = () => {
    try {
      localStorage.setItem(REMEMBER_KEY, JSON.stringify(parts));
    } catch {
      /* per-device preference */
    }
    useStore.getState().pasteAttributes(targets, copied, parts);
    close();
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal paste-attrs" role="dialog" aria-modal="true" aria-labelledby="paste-title">
        <h2 id="paste-title">Paste attributes</h2>
        <p className="muted small">
          Onto {targets.length} clip{targets.length === 1 ? "" : "s"}. Video-only settings skip audio clips and vice versa.
        </p>
        <div className="paste-parts">
          {ATTRIBUTE_PARTS.map((p) => (
            <label key={p.key} className="checkbox-row">
              <input type="checkbox" checked={parts.includes(p.key)} onChange={() => toggle(p.key)} />
              <span>
                {p.label}
                <span className="muted small"> — {p.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button onClick={close}>Cancel</button>
          <button className="primary" disabled={parts.length === 0} onClick={apply}>
            Paste
          </button>
        </div>
      </div>
    </div>
  );
}
