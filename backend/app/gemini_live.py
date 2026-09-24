"""Gemini Live session setup for the POC: system prompt, tool declarations,
and a thin async-context-manager wrapper around client.aio.live.connect.

NOTE for implementer: this targets the google-genai SDK's Live API as
documented at https://aistudio.google.com/docs/live-api. If the installed
SDK version's `client.aio.live.connect` signature or `types.LiveConnectConfig`
shape differs, adjust `open_live_session` to match — the tool declaration
and dispatch logic above it is SDK-version-independent and should not need
to change.
"""

import os
from contextlib import asynccontextmanager
from typing import Callable

from google import genai
from google.genai import types

from app.persona import TUTOR_SYSTEM_PROMPT
from app.tools import generate_mindmap, generate_quiz

# Default Live API model (Gemini API key auth, not Vertex) for low-latency
# voice agents, per https://aistudio.google.com/docs/models (checked
# 2026-09-23). Supersedes gemini-3.1-flash-live-preview, which was current
# in the installed google-genai SDK's (2.25.0) own test fixtures but had
# already fallen behind the live docs by the time this POC was built —
# these model ids move fast; re-verify against the docs page above before
# trusting this default long-term. gemini-3.8-live-extended-thinking is the
# higher-reasoning sibling, if lower latency ever needs to be traded for it.
GEMINI_LIVE_MODEL = os.environ.get("GEMINI_LIVE_MODEL", "gemini-3.8-live")

TOOL_DISPATCH: dict[str, Callable[[str], dict]] = {
    "generate_quiz": generate_quiz,
    "generate_mindmap": generate_mindmap,
}


def build_tool_declarations() -> list[dict]:
    topic_param = {
        "type": "object",
        "properties": {
            "topic": {
                "type": "string",
                "description": "The subject the learner wants this tool run on.",
            }
        },
        "required": ["topic"],
    }
    return [
        {
            "name": "generate_quiz",
            "description": "Generate a short quiz on a topic the learner asked about.",
            "parameters": topic_param,
        },
        {
            "name": "generate_mindmap",
            "description": "Generate a mindmap breakdown of a topic the learner asked about.",
            "parameters": topic_param,
        },
    ]


@asynccontextmanager
async def open_live_session(client: genai.Client):
    config = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=TUTOR_SYSTEM_PROMPT,
        tools=[{"function_declarations": build_tool_declarations()}],
        # Transcribes Gemini's own spoken audio so the frontend can show a
        # text transcript alongside the voice response. User speech is not
        # transcribed via this config — the relay separately shows what the
        # user said by echoing what it sent, since audio input is routed
        # through send_client_content (see relay.py), not the realtime/VAD
        # audio path.
        output_audio_transcription=types.AudioTranscriptionConfig(),
        # NOTE: send_realtime_input(audio=...)'s automatic VAD was tried
        # extensively (default config, explicit activity_start/end, and
        # turn_coverage=TURN_INCLUDES_ONLY_ACTIVITY matching Google's own
        # reference implementation) and in every case reliably triggered
        # turn 1 but never triggered turn 2+ in the same session — audio
        # kept reaching Gemini (confirmed server-side) but produced zero
        # response of any kind. A standalone diagnostic script confirmed
        # session/model/project health by driving two turns via
        # send_client_content(text=..., turn_complete=True) instead — both
        # turns worked, including correct cross-turn context recall. So
        # audio input here is deliberately NOT streamed via
        # send_realtime_input; see relay.py's buffer-and-flush approach
        # using send_client_content with an inline_data audio Part instead.
    )
    async with client.aio.live.connect(model=GEMINI_LIVE_MODEL, config=config) as session:
        yield session
