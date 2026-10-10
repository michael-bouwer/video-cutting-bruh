import { useStore } from "../store";

/** Follows the pointer while media is dragged from the bin (see lib/mediaDrag.ts). */
export function MediaDragGhost() {
  const drag = useStore((s) => s.mediaDrag);
  const media = useStore((s) => (drag ? s.media.find((m) => m.id === drag.mediaId) : undefined));
  if (!drag || !media) return null;
  const x = Math.min(drag.x + 14, window.innerWidth - 240);
  const y = Math.min(drag.y + 14, window.innerHeight - 60);
  return (
    <div className={`drag-ghost ${drag.over ? "over" : ""}`} style={{ left: x, top: y }}>
      <span className="drag-ghost-name">{media.name}</span>
      <span className="small">{drag.over ? `Insert as clip ${drag.index + 1}` : "Drop on the timeline"}</span>
    </div>
  );
}
