import asyncio
import os

import structlog
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from google import genai

from app.gemini_live import open_live_session
from app.relay import relay_browser_to_gemini, relay_gemini_to_browser

load_dotenv()
logger = structlog.get_logger()

app = FastAPI(title="live-chat-poc")

_api_key = os.environ.get("GEMINI_API_KEY")
if not _api_key:
    raise RuntimeError(
        "GEMINI_API_KEY not set — copy .env.example to .env and fill it in"
    )
_client = genai.Client(api_key=_api_key)


@app.websocket("/ws/live-chat")
async def live_chat(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        async with open_live_session(_client) as session:
            to_gemini = asyncio.create_task(relay_browser_to_gemini(websocket, session))
            to_browser = asyncio.create_task(relay_gemini_to_browser(websocket, session))
            done, pending = await asyncio.wait(
                {to_gemini, to_browser}, return_when=asyncio.FIRST_EXCEPTION
            )
            for task in pending:
                task.cancel()
            for task in done:
                exc = task.exception()
                if exc is not None:
                    raise exc
    except WebSocketDisconnect:
        logger.info("live_chat_disconnected")
    except Exception as exc:  # noqa: BLE001
        logger.error("live_chat_session_error", error=str(exc))
        try:
            await websocket.close(code=1011, reason=str(exc)[:120])
        except Exception:  # noqa: BLE001
            # The connection may already be dead; don't let a failure here
            # mask the original exception we just logged above.
            pass
