"use client";

import { useCallback, useRef, useState } from "react";
import { connectLiveChat, type ToolResultEvent } from "@/lib/ws";
import { floatTo16BitPCM, pcm16ToFloat32 } from "@/lib/audio";
import ToolResultCard from "./ToolResultCard";

type Status = "idle" | "connecting" | "listening" | "speaking" | "error";

type Message = { role: "user" | "assistant"; text: string };

const WS_URL = process.env.NEXT_PUBLIC_LIVE_CHAT_WS_URL || "ws://localhost:8100/ws/live-chat";

const STATUS_COLORS: Record<Status, string> = {
  idle: "#9ca3af",
  connecting: "#f59e0b",
  listening: "#3b82f6",
  speaking: "#10b981",
  error: "#ef4444",
};

// Audio is buffered client-side per utterance and flushed as one message —
// see relay.py's send_client_content approach (send_realtime_input's
// automatic VAD only ever triggered a first turn, never a second, across
// every config tried; this buffer-and-flush design routes audio through
// the API that a standalone diagnostic proved reliably multi-turn).
const SPEECH_RMS_THRESHOLD = 0.015;
// ~8 consecutive silent 4096-sample/16kHz chunks (~2s) before declaring the
// utterance over — long enough to survive a normal mid-sentence pause.
const SILENCE_CHUNKS_TO_END_TURN = 8;

function computeRms(samples: Float32Array): number {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
  return Math.sqrt(sumSquares / samples.length);
}

export default function LiveChat() {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [toolResults, setToolResults] = useState<ToolResultEvent[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inProgressUserText, setInProgressUserText] = useState("");
  const [inProgressAssistantText, setInProgressAssistantText] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  // Single persistent playback AudioContext, created lazily on first chunk,
  // instead of a new AudioContext per chunk (which overlaps audio and hits
  // Chrome's ~6-concurrent-context cap). Chunks are scheduled back-to-back
  // via nextStartTimeRef rather than started with no argument.
  const playbackContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  const isSpeakingRef = useRef(false);
  const silentChunkCountRef = useRef(0);

  // Guards against a spurious barge-in: the mic can pick up the tail of the
  // assistant's own audio (even with echoCancellation) right as it finishes,
  // which reads as the user starting a new utterance before the assistant
  // is actually done. Turn detection is suppressed while the assistant is
  // actively speaking, plus a short cooldown after playback truly ends.
  const assistantSpeakingRef = useRef(false);
  const assistantCooldownUntilRef = useRef(0);
  const ASSISTANT_COOLDOWN_MS = 400;

  const start = useCallback(async () => {
    setErrorMessage(null);
    setStatus("connecting");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      setStatus("error");
      setErrorMessage("Microphone permission denied.");
      return;
    }

    const audioContext = new AudioContext({ sampleRate: 16000 });
    audioContextRef.current = audioContext;

    const ws = connectLiveChat(
      WS_URL,
      (chunk) => {
        const playbackCtx = (playbackContextRef.current ??= new AudioContext({
          sampleRate: 24000,
        }));
        const floatData = pcm16ToFloat32(chunk);
        const buffer = playbackCtx.createBuffer(1, floatData.length, 24000);
        buffer.copyToChannel(floatData as Float32Array<ArrayBuffer>, 0);
        const source = playbackCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(playbackCtx.destination);

        const startAt = Math.max(playbackCtx.currentTime, nextStartTimeRef.current);
        source.start(startAt);
        nextStartTimeRef.current = startAt + buffer.duration;
        scheduledSourcesRef.current.push(source);
        assistantSpeakingRef.current = true;
        setStatus("speaking");

        source.onended = () => {
          scheduledSourcesRef.current = scheduledSourcesRef.current.filter(
            (s) => s !== source
          );
          if (scheduledSourcesRef.current.length === 0) {
            assistantSpeakingRef.current = false;
            assistantCooldownUntilRef.current = Date.now() + ASSISTANT_COOLDOWN_MS;
            setStatus("listening");
          }
        };
      },
      (event) => setToolResults((prev) => [...prev, event]),
      () => {
        // Barge-in: stop everything currently scheduled and reset the
        // playback clock so new audio starts immediately.
        scheduledSourcesRef.current.forEach((s) => {
          try {
            s.stop();
          } catch {
            // source may have already finished/been stopped; ignore.
          }
        });
        scheduledSourcesRef.current = [];
        const playbackCtx = playbackContextRef.current;
        if (playbackCtx) nextStartTimeRef.current = playbackCtx.currentTime;
        setStatus("listening");
      },
      (event) => {
        const setInProgress = event.role === "user" ? setInProgressUserText : setInProgressAssistantText;
        if (event.finished) {
          setInProgress((prevInProgress) => {
            const fullText = prevInProgress + event.text;
            if (fullText) {
              setMessages((prev) => [...prev, { role: event.role, text: fullText }]);
            }
            return "";
          });
        } else {
          setInProgress((prev) => prev + event.text);
        }
      },
      (message) => {
        setStatus("error");
        setErrorMessage(message);
      }
    );
    wsRef.current = ws;

    ws.onopen = () => setStatus("listening");

    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(audioContext.destination);
    processor.onaudioprocess = (event) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);

      const suppressTurnDetection =
        assistantSpeakingRef.current || Date.now() < assistantCooldownUntilRef.current;

      const rms = computeRms(input);
      if (!suppressTurnDetection && rms > SPEECH_RMS_THRESHOLD) {
        silentChunkCountRef.current = 0;
        if (!isSpeakingRef.current) {
          isSpeakingRef.current = true;
          ws.send(JSON.stringify({ type: "activity_start" }));
        }
      } else if (isSpeakingRef.current) {
        silentChunkCountRef.current += 1;
        if (silentChunkCountRef.current >= SILENCE_CHUNKS_TO_END_TURN) {
          isSpeakingRef.current = false;
          silentChunkCountRef.current = 0;
          ws.send(JSON.stringify({ type: "activity_end" }));
        }
      }

      // The backend only buffers audio while it considers the user
      // "speaking" (between activity_start/activity_end) and flushes it as
      // one send_client_content call on activity_end — see relay.py.
      if (isSpeakingRef.current) {
        ws.send(floatTo16BitPCM(input));
      }
    };
  }, []);

  return (
    <div
      style={{
        maxWidth: 560,
        margin: "40px auto",
        padding: "0 16px",
        fontFamily: "sans-serif",
      }}
    >
      <h1 style={{ marginBottom: 4 }}>Live Chat POC</h1>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: STATUS_COLORS[status],
          }}
        />
        <span style={{ color: "#374151" }}>{status}</span>
      </div>

      {errorMessage && (
        <p style={{ color: "#ef4444", marginBottom: 16 }}>{errorMessage}</p>
      )}

      {status === "idle" && (
        <button
          onClick={start}
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            border: "1px solid #d1d5db",
            background: "#111827",
            color: "white",
            cursor: "pointer",
          }}
        >
          Start conversation
        </button>
      )}

      {(messages.length > 0 || inProgressUserText || inProgressAssistantText) && (
        <div
          style={{
            marginTop: 16,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            maxHeight: 360,
            overflowY: "auto",
          }}
        >
          {messages.map((message, i) => (
            <div
              key={i}
              style={{
                alignSelf: message.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "85%",
                background: message.role === "user" ? "#dbeafe" : "#f3f4f6",
                borderRadius: 10,
                padding: "8px 12px",
                color: "#111827",
              }}
            >
              {message.text}
            </div>
          ))}
          {inProgressUserText && (
            <div
              style={{
                alignSelf: "flex-end",
                maxWidth: "85%",
                background: "#dbeafe",
                borderRadius: 10,
                padding: "8px 12px",
                color: "#6b7280",
              }}
            >
              {inProgressUserText}
            </div>
          )}
          {inProgressAssistantText && (
            <div
              style={{
                alignSelf: "flex-start",
                maxWidth: "85%",
                background: "#f3f4f6",
                borderRadius: 10,
                padding: "8px 12px",
                color: "#6b7280",
              }}
            >
              {inProgressAssistantText}
            </div>
          )}
        </div>
      )}

      {toolResults.map((event, i) => (
        <ToolResultCard key={i} event={event} />
      ))}
    </div>
  );
}
