import { useStore } from "../store";

/** Follows the pointer while media is dragged from the bin (see lib/mediaDrag.ts). */
export function MediaDragGhost() {
  const drag = useStore((s) => s.mediaDrag);
  const media = useStore((s) => (drag ? s.media.find((m) => m.id === drag.mediaId) : undefined));
  const track = useStore((s) => (drag?.trackId ? s.tracks.find((t) => t.id === drag.trackId) : undefined));
  if (!drag || !media) return null;
  const x = Math.min(drag.x + 14, window.innerWidth - 240);
  const y = Math.min(drag.y + 14, window.innerHeight - 60);
  return (
    <div className={`drag-ghost ${drag.over ? "over" : ""}`} style={{ left: x, top: y }}>
      <span className="drag-ghost-name">{media.name}</span>
      <span className="small">
        {!drag.over
          ? "Drop on the timeline"
          : drag.toNewTrack || !track
            ? `New ${drag.kind} track at ${drag.at.toFixed(2)}s`
            : `${track.name} at ${drag.at.toFixed(2)}s${media.kind === "video" && media.probe?.hasAudio !== false ? " (+ linked audio)" : ""}`}
      </span>
    </div>
  );
}
