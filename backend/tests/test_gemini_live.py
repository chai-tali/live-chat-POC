from app.gemini_live import build_tool_declarations, TOOL_DISPATCH


def test_build_tool_declarations_lists_both_mock_tools():
    declarations = build_tool_declarations()
    names = {d["name"] for d in declarations}
    assert names == {"generate_quiz", "generate_mindmap"}
    for d in declarations:
        assert "description" in d
        assert d["parameters"]["type"] == "object"
        assert "topic" in d["parameters"]["properties"]


def test_tool_dispatch_maps_names_to_callables():
    assert set(TOOL_DISPATCH.keys()) == {"generate_quiz", "generate_mindmap"}
    result = TOOL_DISPATCH["generate_quiz"]("algebra")
    assert result["tool"] == "generate_quiz"
    assert result["payload"]["topic"] == "algebra"
