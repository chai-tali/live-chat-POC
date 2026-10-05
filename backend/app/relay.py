"""Bidirectional relay between a browser WebSocket and an open Gemini Live
session: forwards mic PCM in, streams response PCM out, and turns Gemini
function calls into mock tool results relayed both back into the Live
session and out to the browser as a `tool_result` event."""

import json
from dataclasses import dataclass

import structlog
from fastapi import WebSocket, WebSocketDisconnect
from google.genai import types

from app.gemini_live import TOOL_DISPATCH

logger = structlog.get_logger()


@dataclass
class RelayState:
    discard_current_response: bool = False


def build_tool_event(tool_name: str, result: dict) -> dict:
    return {
        "type": "tool_result",
        "tool": tool_name,
        "payload": result,
    }


async def relay_browser_to_gemini(websocket: WebSocket, session, state: RelayState | None = None) -> None:
    """Buffers mic PCM between the browser's activity_start/activity_end
    control messages (client-side amplitude-based speech detection) and
    flushes each complete utterance as one send_client_content(...,
    turn_complete=True) call with the audio as an inline_data Part.

    send_realtime_input(audio=...)'s automatic-VAD turn detection was tried
    extensively (see gemini_live.py's config comment) and reliably worked
    for turn 1 but never triggered a second turn — audio kept reaching
    Gemini but produced zero response. A standalone diagnostic proved the
    session/model/project are otherwise healthy for multi-turn: driving two
    turns via send_client_content(text=..., turn_complete=True) worked
    correctly both times, including cross-turn context recall. Routing
    audio through that same reliable API (as inline_data instead of text)
    is the fix — this trades continuous streaming for one buffered send per
    utterance, which is still fully voice-driven, just utterance-batched
    rather than word-by-word streamed."""
    state = state or RelayState()
    audio_buffer = bytearray()
    is_speaking = False
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            raise WebSocketDisconnect(message.get("code", 1000))

        raw_bytes = message.get("bytes")
        if raw_bytes is not None:
            if is_speaking:
                audio_buffer.extend(raw_bytes)
            continue

        raw_text = message.get("text")
        if raw_text is None:
            continue
        control = json.loads(raw_text)
        control_type = control.get("type")

        if control_type == "activity_start":
            is_speaking = True
            audio_buffer.clear()
            logger.info("utterance_start")
        elif control_type == "activity_end":
            is_speaking = False
            if audio_buffer:
                logger.info("utterance_end", bytes=len(audio_buffer))
                await session.send_client_content(
                    turns=types.Content(
                        role="user",
                        parts=[
                            types.Part(
                                inline_data=types.Blob(
                                    data=bytes(audio_buffer),
                                    mime_type="audio/pcm;rate=16000",
                                )
                            )
                        ],
                    ),
                    turn_complete=True,
                )
            audio_buffer.clear()
        elif control_type == "activity_cancel":
            is_speaking = False
            audio_buffer.clear()
            logger.info("utterance_cancelled")
        elif control_type == "interrupt":
            state.discard_current_response = True
            logger.info("assistant_interrupted")


async def relay_gemini_to_browser(websocket: WebSocket, session, state: RelayState | None = None) -> None:
    """Reads Gemini Live responses and forwards audio to the browser as
    binary frames; on a function call, runs the mock tool, feeds the result
    back to Gemini, and pushes a `tool_result` JSON event to the browser.

    `session.receive()` completes when the current model turn completes; it
    does not stream every turn for the lifetime of the session. Re-enter it
    after each completed iterator so follow-up turns are received too.
    """
    state = state or RelayState()
    while True:
        async for response in session.receive():
            server_content = getattr(response, "server_content", None)
            discarding_response = state.discard_current_response
            logger.info(
                "gemini_response",
                has_data=response.data is not None,
                data_bytes=len(response.data) if response.data else 0,
                turn_complete=getattr(server_content, "turn_complete", None) if server_content else None,
                turn_complete_reason=getattr(server_content, "turn_complete_reason", None) if server_content else None,
                waiting_for_input=getattr(server_content, "waiting_for_input", None) if server_content else None,
                interaction_status=getattr(server_content, "interaction_status", None) if server_content else None,
                interrupted=getattr(server_content, "interrupted", None) if server_content else None,
                has_tool_call=getattr(response, "tool_call", None) is not None,
                voice_activity=getattr(response, "voice_activity", None),
                vad_signal=getattr(response, "voice_activity_detection_signal", None),
                input_transcription=getattr(server_content, "input_transcription", None) if server_content else None,
                interim_input_transcription=getattr(server_content, "interim_input_transcription", None) if server_content else None,
            )
            if response.data is not None and not discarding_response:
                await websocket.send_bytes(response.data)

            if server_content is not None and getattr(server_content, "interrupted", False):
                # Barge-in: Gemini signals the user interrupted the model mid-turn.
                # Forward this so the frontend can stop scheduled playback
                # immediately instead of letting stale audio keep playing.
                await websocket.send_text(json.dumps({"type": "interrupted"}))

            output_transcription = getattr(server_content, "output_transcription", None) if server_content else None
            if (
                output_transcription is not None
                and output_transcription.text
                and not discarding_response
            ):
                await websocket.send_text(json.dumps({
                    "type": "transcript",
                    "role": "assistant",
                    "text": output_transcription.text,
                    # The server-level turn_complete event below is the only
                    # authoritative boundary for closing an assistant bubble.
                    "finished": False,
                }))

            input_transcription = getattr(server_content, "input_transcription", None) if server_content else None
            if input_transcription is not None and input_transcription.text:
                await websocket.send_text(json.dumps({
                    "type": "transcript",
                    "role": "user",
                    "text": input_transcription.text,
                    "finished": bool(input_transcription.finished),
                }))

            # Output transcription chunks do not consistently mark their last
            # chunk as finished. The server turn boundary is authoritative,
            # so explicitly flush the assistant transcript there. This keeps
            # each tutor answer in its own chat bubble.
            if server_content is not None and getattr(server_content, "turn_complete", False):
                state.discard_current_response = False
                await websocket.send_text(json.dumps({
                    "type": "transcript",
                    "role": "assistant",
                    "text": "",
                    "finished": True,
                }))

            tool_call = getattr(response, "tool_call", None)
            if tool_call is not None and not discarding_response:
                for fn_call in tool_call.function_calls:
                    tool_fn = TOOL_DISPATCH.get(fn_call.name)
                    if tool_fn is None:
                        logger.warning("unknown_tool_call", name=fn_call.name)
                        continue
                    topic = fn_call.args.get("topic", "")
                    result = tool_fn(topic)
                    payload = result["payload"]
                    await session.send_tool_response(
                        function_responses=[
                            {"id": fn_call.id, "name": fn_call.name, "response": payload}
                        ]
                    )
                    await websocket.send_text(json.dumps(build_tool_event(fn_call.name, payload)))
