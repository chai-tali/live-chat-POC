export type ToolResultEvent = {
  type: "tool_result";
  tool: string;
  payload: Record<string, unknown>;
};

export type InterruptedEvent = {
  type: "interrupted";
};

export type TranscriptEvent = {
  type: "transcript";
  role: "user" | "assistant";
  text: string;
  finished: boolean;
};

export type LiveChatEvent = ToolResultEvent | InterruptedEvent | TranscriptEvent;

export function connectLiveChat(
  url: string,
  onAudioChunk: (chunk: ArrayBuffer) => void,
  onToolResult: (event: ToolResultEvent) => void,
  onInterrupted: () => void,
  onTranscript: (event: TranscriptEvent) => void,
  onError: (message: string) => void
): WebSocket {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      const parsed = JSON.parse(event.data) as LiveChatEvent;
      if (parsed.type === "tool_result") {
        onToolResult(parsed);
      } else if (parsed.type === "interrupted") {
        onInterrupted();
      } else if (parsed.type === "transcript") {
        onTranscript(parsed);
      }
      return;
    }
    onAudioChunk(event.data as ArrayBuffer);
  };
  ws.onerror = () => onError("WebSocket connection error.");
  ws.onclose = (event) => {
    if (event.code !== 1000) onError(event.reason || "Connection closed unexpectedly.");
  };
  return ws;
}
