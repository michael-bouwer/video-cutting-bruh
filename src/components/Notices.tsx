import { useStore } from "../store";

export function Notices() {
  const notices = useStore((s) => s.notices);
  const dismiss = useStore((s) => s.dismiss);
  return (
    <div className="notices">
      {notices.map((n) => (
        <div key={n.id} className={`notice ${n.level}`} onClick={() => dismiss(n.id)}>
          {n.text}
        </div>
      ))}
    </div>
  );
}
