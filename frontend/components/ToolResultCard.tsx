import type { ToolResultEvent } from "@/lib/ws";

export default function ToolResultCard({ event }: { event: ToolResultEvent }) {
  return (
    <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, marginTop: 12 }}>
      <strong>{event.tool}</strong>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
        {JSON.stringify(event.payload, null, 2)}
      </pre>
    </div>
  );
}
