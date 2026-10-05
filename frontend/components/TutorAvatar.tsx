"use client";

import { type MutableRefObject, useEffect, useRef, useState } from "react";

type TalkingHeadInstance = {
  showAvatar(options: Record<string, unknown>): Promise<void>;
  setView(view: string, options?: Record<string, unknown>): Promise<void>;
  setFixedValue(morphTarget: string, value: number, transitionMs?: number): void;
  setMood(mood: string): void;
  stop(): Promise<void> | void;
};

type Props = {
  analyserRef: MutableRefObject<AnalyserNode | null>;
  speaking: boolean;
};

export default function TutorAvatar({ analyserRef, speaking }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const avatarRef = useRef<TalkingHeadInstance | null>(null);
  const frameRef = useRef<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;

    async function initialize() {
      if (!containerRef.current) return;

      try {
        // DialogLab vendors TalkingHead as an ES module rather than an npm package.
        const { TalkingHead } = await import("@/src/vendor/talkinghead.mjs");
        if (disposed || !containerRef.current) return;

        const avatar = new TalkingHead(containerRef.current, {
          cameraView: "upper",
          // Gemini streams raw PCM without word timing, so this POC drives
          // morph targets from audio energy and does not load text lip-sync modules.
          lipsyncModules: [],
          modelFPS: 30,
        }) as unknown as TalkingHeadInstance;
        avatarRef.current = avatar;

        await avatar.showAvatar({
          url: "/dialoglab/male-avatar1.glb",
          body: "F",
          avatarMood: "neutral",
          lipsyncLang: "en",
          transparent: true,
        });
        await avatar.setView("upper", { cameraDistance: 0.55 });
      } catch (error) {
        console.error("Unable to initialize DialogLab avatar", error);
        setLoadError("The 3D tutor could not be loaded.");
      }
    }

    void initialize();
    return () => {
      disposed = true;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      void avatarRef.current?.stop();
      avatarRef.current = null;
    };
  }, []);

  useEffect(() => {
    const avatar = avatarRef.current;
    if (!avatar) return;
    avatar.setMood(speaking ? "happy" : "neutral");

    if (!speaking) {
      avatar.setFixedValue("viseme_aa", 0, 90);
      avatar.setFixedValue("jawOpen", 0, 90);
      return;
    }

    const samples = new Uint8Array(128);
    const animateMouth = () => {
      const analyser = analyserRef.current;
      const currentAvatar = avatarRef.current;
      if (!analyser || !currentAvatar) {
        frameRef.current = requestAnimationFrame(animateMouth);
        return;
      }

      analyser.getByteTimeDomainData(samples);
      let sumSquares = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        sumSquares += centered * centered;
      }
      const rms = Math.sqrt(sumSquares / samples.length);
      const mouthOpen = Math.min(0.85, Math.max(0, (rms - 0.015) * 8));
      currentAvatar.setFixedValue("viseme_aa", mouthOpen, 45);
      currentAvatar.setFixedValue("jawOpen", mouthOpen * 0.45, 45);
      frameRef.current = requestAnimationFrame(animateMouth);
    };

    animateMouth();
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [analyserRef, speaking]);

  return (
    <div
      style={{
        position: "relative",
        height: 360,
        overflow: "hidden",
        borderRadius: 18,
        background: "linear-gradient(145deg, #eef2ff, #f8fafc)",
        boxShadow: "inset 0 0 0 1px rgba(148, 163, 184, 0.35)",
      }}
    >
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      <div
        style={{
          position: "absolute",
          left: 14,
          bottom: 12,
          padding: "5px 9px",
          borderRadius: 999,
          color: "#334155",
          background: "rgba(255, 255, 255, 0.82)",
          fontSize: 12,
          backdropFilter: "blur(8px)",
        }}
      >
        DialogLab avatar · {speaking ? "speaking" : "ready"}
      </div>
      {loadError && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#b91c1c" }}>
          {loadError}
        </div>
      )}
    </div>
  );
}
