# DialogLab evaluation for Kyros

## Decision

DialogLab proves that a browser-based Kyros tutor can render a convincing 3D
talking head. Kyros should reuse the avatar renderer as an optional presentation
layer, not adopt DialogLab as its conversation backend.

The POC in this repository connects DialogLab's TalkingHead renderer to the
existing Gemini Live voice stream. The existing Kyros/Gemini path continues to
own turn taking, tutor instructions, transcripts, tools, and interruption. A
Web Audio analyser measures each outbound audio chunk and drives the avatar's
mouth while the tutor speaks.

```text
Student microphone
       |
       v
Kyros WebSocket relay <----> Gemini Live
       |                         |
       | transcript/tool events  | PCM tutor audio
       v                         v
Kyros chat UI          Web Audio -> speakers
                              |
                              v
                   DialogLab TalkingHead avatar
```

## What DialogLab does

DialogLab is a research authoring application for human/AI multi-party
conversations. Its React/Vite client provides a node editor, scene composition,
3D Ready Player Me avatars, preview/replay, and conversation verification. Its
Express server orchestrates multiple agents, calls OpenAI or Gemini text models,
maintains conversation summaries, and generates speech with Google Cloud TTS.

This is broader than Kyros needs for a single tutor. DialogLab's strongest
reusable part is the browser avatar renderer (`TalkingHead`, Three.js, and a GLB
avatar). The node editor, Express orchestration, memory implementation, and TTS
pipeline overlap with systems Kyros already has.

## Fit by capability

| Capability | DialogLab | Kyros decision |
| --- | --- | --- |
| 3D avatar rendering | Ready Player Me GLB through Three.js/TalkingHead | Reuse or replace behind a small React component |
| Lip movement | Word/viseme timing for generated TTS | POC uses streamed-audio amplitude; add phoneme timing only if quality requires it |
| Speech conversation | Text LLM response followed by cloud TTS | Keep Gemini Live for lower latency and barge-in |
| Tutor reasoning and tools | General multi-agent prompts and conversation patterns | Keep Kyros LangGraph, content retrieval, BKT, and UI tools |
| Authoring | Visual multi-agent node/scene editor | Reconsider later only for scripted role-play lessons |
| Memory | In-process conversation history and summaries | Keep Kyros session state, PostgreSQL, and MemPalace |

## POC acceptance criteria

1. The 3D avatar loads without an LLM or TTS key of its own.
2. Existing Gemini Live speech still plays at the same sample rate and supports
   interruption.
3. The avatar moves its mouth only while tutor audio is playing and returns to
   idle when playback ends or the learner interrupts.
4. Existing transcript and mock tool events still render.
5. The production frontend build and audio unit tests pass.

## Production gaps

- The POC mouth motion follows volume, so it looks responsive but is not
  phoneme-accurate. Gemini Live does not currently supply viseme timestamps.
- The bundled GLB is a DialogLab demo asset governed by Ready Player Me terms.
  Kyros needs its own licensed model and a product decision on appearance.
- The vendored TalkingHead module produces a webpack dynamic-dependency warning.
  It builds successfully, but a production integration should package or wrap
  the library cleanly and pin its upstream revision.
- A 3D avatar adds roughly 5 MB for the current model plus the Three.js runtime.
  Lazy loading, a static fallback, reduced-motion support, and mobile GPU testing
  are required before general release.
- Learners should be able to disable the avatar while keeping voice and text.

## Recommended next experiment

Run five short tutoring sessions on a mid-range laptop and phone. Record time to
first avatar frame, animation smoothness, CPU/GPU use, audio latency, and learner
preference with the avatar on and off. If the visual adds value without hurting
voice latency, move `TutorAvatar` into the Kyros frontend and place it beside the
existing voice panel behind a program-level feature flag.
