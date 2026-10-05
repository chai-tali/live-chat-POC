import asyncio
from types import SimpleNamespace

from app.relay import build_tool_event, relay_gemini_to_browser


def test_build_tool_event_shape():
    event = build_tool_event("generate_quiz", {"topic": "algebra", "questions": []})
    assert event == {
        "type": "tool_result",
        "tool": "generate_quiz",
        "payload": {"topic": "algebra", "questions": []},
    }


def test_gemini_relay_keeps_receiving_after_first_turn():
    class FakeWebSocket:
        def __init__(self):
            self.audio = []
            self.text = []

        async def send_bytes(self, data):
            self.audio.append(data)

        async def send_text(self, data):
            self.text.append(data)

    class FakeSession:
        def __init__(self):
            self.receive_calls = 0

        def receive(self):
            self.receive_calls += 1
            turn_number = self.receive_calls

            async def responses():
                if turn_number <= 2:
                    yield SimpleNamespace(
                        data=f"turn-{turn_number}".encode(),
                        server_content=SimpleNamespace(turn_complete=True),
                        tool_call=None,
                    )
                else:
                    await asyncio.Event().wait()
                    yield  # pragma: no cover - makes this an async generator

            return responses()

    async def run_test():
        websocket = FakeWebSocket()
        session = FakeSession()
        task = asyncio.create_task(relay_gemini_to_browser(websocket, session))
        try:
            async with asyncio.timeout(1):
                while len(websocket.audio) < 2:
                    await asyncio.sleep(0)
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        assert websocket.audio == [b"turn-1", b"turn-2"]
        assert sum('"finished": true' in event for event in websocket.text) == 2
        assert session.receive_calls == 3

    asyncio.run(run_test())
