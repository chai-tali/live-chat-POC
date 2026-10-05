"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { connectLiveChat, type ToolResultEvent } from "@/lib/ws";
import { floatTo16BitPCM, pcm16ToFloat32 } from "@/lib/audio";
import ToolResultCard from "./ToolResultCard";
import TutorAvatar from "./TutorAvatar";

type Status = "idle" | "connecting" | "listening" | "generating" | "speaking" | "error";

type Message = { role: "user" | "assistant"; text: string };

const INTRO_MESSAGE: Message = {
  role: "assistant",
  text: "Hi! I’m your tutor. Start the conversation and ask me anything you’d like to learn.",
};

const VOICES = ["Kore", "Puck", "Charon", "Aoede"] as const;
type VoiceName = (typeof VOICES)[number];

const WS_URL = process.env.NEXT_PUBLIC_LIVE_CHAT_WS_URL || "ws://localhost:8100/ws/live-chat";

const STATUS_COLORS: Record<Status, string> = {
  idle: "#9ca3af",
  connecting: "#f59e0b",
  listening: "#3b82f6",
  generating: "#8b5cf6",
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
  const [messages, setMessages] = useState<Message[]>([INTRO_MESSAGE]);
  const [isMuted, setIsMuted] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState<VoiceName>("Kore");
  const [inProgressUserText, setInProgressUserText] = useState("");
  const [inProgressAssistantText, setInProgressAssistantText] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const isMutedRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const discardIncomingAudioRef = useRef(false);

  // Single persistent playback AudioContext, created lazily on first chunk,
  // instead of a new AudioContext per chunk (which overlaps audio and hits
  // Chrome's ~6-concurrent-context cap). Chunks are scheduled back-to-back
  // via nextStartTimeRef rather than started with no argument.
  const playbackContextRef = useRef<AudioContext | null>(null);
  const playbackAnalyserRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  const isSpeakingRef = useRef(false);
  const silentChunkCountRef = useRef(0);

  // A short cooldown after playback ends prevents its audio tail from being
  // mistaken for a new user utterance. While playback is active we use a
  // higher speech threshold, allowing deliberate speech to barge in.
  const assistantSpeakingRef = useRef(false);
  const assistantCooldownUntilRef = useRef(0);
  const ASSISTANT_COOLDOWN_MS = 400;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, inProgressUserText, inProgressAssistantText]);

  const stopAssistantPlayback = useCallback(() => {
    discardIncomingAudioRef.current = true;
    scheduledSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        // The source may already have ended.
      }
    });
    scheduledSourcesRef.current = [];
    assistantSpeakingRef.current = false;
    const playbackCtx = playbackContextRef.current;
    if (playbackCtx) nextStartTimeRef.current = playbackCtx.currentTime;
    setStatus("listening");
  }, []);

  const interruptTutor = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "interrupt" }));
    }
    stopAssistantPlayback();
  }, [stopAssistantPlayback]);

  const toggleMute = useCallback(() => {
    const nextMuted = !isMutedRef.current;
    isMutedRef.current = nextMuted;
    setIsMuted(nextMuted);
    mediaStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    if (nextMuted && isSpeakingRef.current) {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "activity_cancel" }));
      }
      isSpeakingRef.current = false;
      silentChunkCountRef.current = 0;
    }
  }, []);

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

    mediaStreamRef.current = stream;

    const audioContext = new AudioContext({ sampleRate: 16000 });
    audioContextRef.current = audioContext;

    const separator = WS_URL.includes("?") ? "&" : "?";
    const wsUrl = WS_URL + separator + "voice=" + encodeURIComponent(selectedVoice);
    const ws = connectLiveChat(
      wsUrl,
      (chunk) => {
        if (discardIncomingAudioRef.current) return;
        const playbackCtx = (playbackContextRef.current ??= new AudioContext({
          sampleRate: 24000,
        }));
        const floatData = pcm16ToFloat32(chunk);
        const buffer = playbackCtx.createBuffer(1, floatData.length, 24000);
        buffer.copyToChannel(floatData as Float32Array<ArrayBuffer>, 0);
        const source = playbackCtx.createBufferSource();
        source.buffer = buffer;
        let analyser = playbackAnalyserRef.current;
        if (!analyser) {
          analyser = playbackCtx.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.45;
          analyser.connect(playbackCtx.destination);
          playbackAnalyserRef.current = analyser;
        }
        source.connect(analyser);

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
      stopAssistantPlayback,
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
      if (ws.readyState !== WebSocket.OPEN || isMutedRef.current) return;
      const input = event.inputBuffer.getChannelData(0);

      const assistantWasSpeaking = assistantSpeakingRef.current;
      const suppressTurnDetection = Date.now() < assistantCooldownUntilRef.current;
      const speechThreshold = assistantWasSpeaking ? 0.04 : SPEECH_RMS_THRESHOLD;

      const rms = computeRms(input);
      if (!suppressTurnDetection && rms > speechThreshold) {
        silentChunkCountRef.current = 0;
        if (!isSpeakingRef.current) {
          if (assistantWasSpeaking) {
            ws.send(JSON.stringify({ type: "interrupt" }));
            stopAssistantPlayback();
          }
          isSpeakingRef.current = true;
          ws.send(JSON.stringify({ type: "activity_start" }));
        }
      } else if (isSpeakingRef.current) {
        silentChunkCountRef.current += 1;
        if (silentChunkCountRef.current >= SILENCE_CHUNKS_TO_END_TURN) {
          isSpeakingRef.current = false;
          silentChunkCountRef.current = 0;
          ws.send(JSON.stringify({ type: "activity_end" }));
          discardIncomingAudioRef.current = false;
          setStatus("generating");
        }
      }

      // The backend only buffers audio while it considers the user
      // "speaking" (between activity_start/activity_end) and flushes it as
      // one send_client_content call on activity_end — see relay.py.
      if (isSpeakingRef.current) {
        ws.send(floatTo16BitPCM(input));
      }
    };
  }, [selectedVoice, stopAssistantPlayback]);

  return (
    <div
      style={{
        maxWidth: 920,
        margin: "40px auto",
        padding: "0 16px",
        fontFamily: "sans-serif",
      }}
    >
      <h1 style={{ marginBottom: 4 }}>Live Chat POC</h1>

      <div style={{ margin: "18px 0" }}>
        <TutorAvatar analyserRef={playbackAnalyserRef} speaking={status === "speaking"} />
      </div>

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
        <span style={{ color: "#374151" }}>{isMuted ? "microphone muted" : status}</span>
      </div>

      {errorMessage && (
        <p style={{ color: "#ef4444", marginBottom: 16 }}>{errorMessage}</p>
      )}

      {status === "idle" && (
        <div style={{ display: "flex", alignItems: "end", gap: 10, flexWrap: "wrap" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, color: "#374151", fontSize: 14 }}>
            Tutor voice
            <select
              value={selectedVoice}
              onChange={(event) => setSelectedVoice(event.target.value as VoiceName)}
              style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "white" }}
            >
              {VOICES.map((voice) => (
                <option key={voice} value={voice}>{voice}</option>
              ))}
            </select>
          </label>
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
        </div>
      )}

      {(messages.length > 0 || inProgressUserText || inProgressAssistantText) && (
        <div
          style={{
            marginTop: 16,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            paddingBottom: 96,
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
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
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
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
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
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {inProgressAssistantText}
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      {status !== "idle" && status !== "connecting" && status !== "error" && (
        <div
          style={{
            position: "fixed",
            left: "50%",
            bottom: 24,
            transform: "translateX(-50%)",
            zIndex: 10,
            display: "flex",
            gap: 10,
          }}
        >
          <button
            type="button"
            onClick={toggleMute}
            aria-pressed={isMuted}
            aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
            style={{
              minWidth: 112,
              padding: "12px 18px",
              borderRadius: 999,
              border: isMuted ? "1px solid #b91c1c" : "1px solid #374151",
              background: isMuted ? "#dc2626" : "#111827",
              color: "white",
              fontSize: 15,
              cursor: "pointer",
              boxShadow: "0 8px 24px rgba(0, 0, 0, 0.2)",
            }}
          >
            {isMuted ? "Unmute mic" : "Mute mic"}
          </button>
          {(status === "speaking" || status === "generating") && (
            <button
              type="button"
              onClick={interruptTutor}
              aria-label="Stop tutor response and listen"
              style={{
                minWidth: 128,
                padding: "12px 18px",
                borderRadius: 999,
                border: "1px solid #d1d5db",
                background: "white",
                color: "#111827",
                fontSize: 15,
                cursor: "pointer",
                boxShadow: "0 8px 24px rgba(0, 0, 0, 0.16)",
              }}
            >
              Stop response
            </button>
          )}
        </div>
      )}

      {toolResults.map((event, i) => (
        <ToolResultCard key={i} event={event} />
      ))}
    </div>
  );
}
