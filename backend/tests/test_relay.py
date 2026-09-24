from app.relay import build_tool_event


def test_build_tool_event_shape():
    event = build_tool_event("generate_quiz", {"topic": "algebra", "questions": []})
    assert event == {
        "type": "tool_result",
        "tool": "generate_quiz",
        "payload": {"topic": "algebra", "questions": []},
    }
