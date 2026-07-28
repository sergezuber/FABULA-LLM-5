"""The exact text a live turn produced instead of an answer, and everything that must NOT be touched."""
import json
from toolcall_text import parse_text_tool_calls, as_openai_tool_calls

# Verbatim from the session that produced markup instead of a reply (2026-07-28).
LIVE = """<tool_call>
<function=view>
<parameter=file_path>
/Users/x/notes_book.md
</parameter>
</function>
</tool_call>
<tool_call>
<function=view>
<parameter=file_path>
/Users/x/demo.txt
</parameter>
</function>
</tool_call>"""


def test_the_live_case_is_recognised_as_two_calls():
    calls = parse_text_tool_calls(LIVE)
    assert len(calls) == 2, calls
    assert calls[0]["name"] == "view"
    assert calls[0]["arguments"]["file_path"] == "/Users/x/notes_book.md"
    assert calls[1]["arguments"]["file_path"] == "/Users/x/demo.txt"


def test_it_becomes_the_shape_everything_downstream_expects():
    tc = as_openai_tool_calls(parse_text_tool_calls(LIVE))
    assert tc[0]["type"] == "function"
    assert tc[0]["function"]["name"] == "view"
    assert json.loads(tc[0]["function"]["arguments"])["file_path"] == "/Users/x/notes_book.md"
    assert tc[0]["id"] != tc[1]["id"], "each call needs its own id"


def test_several_parameters_survive():
    t = ("<tool_call><function=grep><parameter=pattern>needle</parameter>"
         "<parameter=path>/tmp</parameter></function></tool_call>")
    a = parse_text_tool_calls(t)[0]["arguments"]
    assert a == {"pattern": "needle", "path": "/tmp"}


# ── everything below must be left exactly as the model wrote it ──────────────────────────────────────

def test_prose_around_a_block_disqualifies_it():
    """A message ABOUT a call is not a call. Rewriting it would invent an action nobody saw."""
    t = "I would normally write <tool_call><function=view></function></tool_call> here, but I will not."
    assert parse_text_tool_calls(t) == []


def test_an_answer_that_merely_mentions_the_syntax_is_untouched():
    t = "The model sometimes prints <tool_call> markup as text. That is the defect."
    assert parse_text_tool_calls(t) == []


def test_a_block_we_do_not_fully_understand_disqualifies_the_whole_content():
    t = "<tool_call>something in a dialect we have never seen</tool_call>"
    assert parse_text_tool_calls(t) == []


def test_one_good_block_and_one_unknown_yields_nothing():
    t = ("<tool_call><function=view><parameter=p>1</parameter></function></tool_call>"
         "<tool_call>???</tool_call>")
    assert parse_text_tool_calls(t) == []


def test_ordinary_text_and_empty_input_are_free():
    assert parse_text_tool_calls("Книга о трёх поколениях одной семьи.") == []
    assert parse_text_tool_calls("") == []
    assert parse_text_tool_calls(None) == []


def test_a_parameter_value_keeps_its_exact_bytes():
    t = "<tool_call><function=bash><parameter=cmd>echo '  spaced  '</parameter></function></tool_call>"
    assert parse_text_tool_calls(t)[0]["arguments"]["cmd"] == "echo '  spaced  '"


def test_the_adapter_actually_calls_this():
    """The wiring, not the logic.

    Today's recurring lesson: a parser whose own tests pass while nothing calls it changes nothing. This
    asserts the conversion reaches the response the engine reads — and that content is cleared when it
    does, since leaving both would show the reader the markup anyway.
    """
    import os
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "lmstudio-adapter.py")).read()
    assert "parse_text_tool_calls(" in src, "the adapter never asks"
    i = src.index("parse_text_tool_calls(msg")
    window = src[i:i + 600]
    assert "as_openai_tool_calls" in window, "parsed calls never reach the response"
    assert 'msg["tool_calls"]' in window, "the engine reads tool_calls; nothing else counts"
    assert 'msg["content"] = None' in window, "the markup must stop being shown as an answer"
    assert '"tool_calls"' in window and "finish_reason" in window, "the turn must be finished as a call"


def test_it_only_runs_when_the_runtime_produced_no_calls_of_its_own():
    """A runtime that parsed the dialect itself must never be second-guessed."""
    import os
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "lmstudio-adapter.py")).read()
    i = src.index("parse_text_tool_calls(msg")
    before = src[max(0, i - 200):i]
    assert 'if not msg.get("tool_calls")' in before, "the recovery must stand down when real calls exist"
