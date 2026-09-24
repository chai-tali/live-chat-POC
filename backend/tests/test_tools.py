from app.tools import generate_quiz, generate_mindmap


def test_generate_quiz_returns_tool_envelope():
    result = generate_quiz("photosynthesis")
    assert result["tool"] == "generate_quiz"
    assert result["payload"]["topic"] == "photosynthesis"
    assert len(result["payload"]["questions"]) >= 1
    question = result["payload"]["questions"][0]
    assert "prompt" in question
    assert "answer" in question


def test_generate_mindmap_returns_tool_envelope():
    result = generate_mindmap("cell biology")
    assert result["tool"] == "generate_mindmap"
    assert result["payload"]["topic"] == "cell biology"
    assert len(result["payload"]["nodes"]) >= 1
    node = result["payload"]["nodes"][0]
    assert "label" in node
