"""Mock tool implementations for the live-chat POC.

These stand in for the real Kyros tool implementations (quiz/mindmap
generation) — the POC only needs to prove that a tool call fired mid-voice
conversation round-trips correctly, not produce real content.
"""


def generate_quiz(topic: str) -> dict:
    # The "tool" key is descriptive/for-caller-convenience only (and is
    # asserted by tests) — relay.py does not read it; it gets the tool
    # name from the Gemini function-call itself (fn_call.name).
    return {
        "tool": "generate_quiz",
        "payload": {
            "topic": topic,
            "questions": [
                {
                    "prompt": f"What is one key idea behind {topic}?",
                    "answer": f"A placeholder answer about {topic}.",
                },
                {
                    "prompt": f"Why does {topic} matter?",
                    "answer": f"A placeholder rationale for {topic}.",
                },
            ],
        },
    }


def generate_mindmap(topic: str) -> dict:
    # See the note in generate_quiz above: "tool" is descriptive only,
    # asserted by tests, not read by relay.py.
    return {
        "tool": "generate_mindmap",
        "payload": {
            "topic": topic,
            "nodes": [
                {"label": topic, "children": ["Concept A", "Concept B"]},
                {"label": "Concept A", "children": []},
                {"label": "Concept B", "children": []},
            ],
        },
    }
