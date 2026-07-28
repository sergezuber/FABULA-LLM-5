"""A tool call written as prose is still a tool call.

MEASURED 2026-07-28. A turn ended with this as its entire answer, shown to the reader:

    <tool_call>
    <function=view>
    <parameter=file_path>
    /Users/…/notes_book.md
    </parameter>
    </function>
    </tool_call>

The model did not call the tool. It described the call in the markup its own template uses, the serving
runtime handed that through as ordinary content because its parser did not recognise this dialect, and the
engine — which only ever looks at `tool_calls` — saw a turn that had finished with a bit of text. Nothing
was wrong anywhere; every layer did what it was told, and the reader got syntax instead of an answer.

This is the transport choke point, so it is the one place where the question "did the model mean to call
something?" can be asked once for every model that will ever sit in the socket. A dialect that some
runtime parses today and another does not is exactly the sort of difference the harness exists to absorb.

DELIBERATELY CONSERVATIVE. A false positive here would turn prose that merely mentions this syntax — a
message about tool calls, a fragment of documentation, this very docstring quoted back — into a call
nobody asked for. So the whole content must be nothing BUT complete blocks: any prose outside them and the
text is left exactly as it is, to be read by a human as the model wrote it.
"""

import json
import re

# The dialect measured live. Written as structure rather than as one long expression so the shape stays
# readable: a call names a function and carries named parameters, each with a value.
_CALL = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.S)
_FUNC = re.compile(r"<function=([A-Za-z0-9_.-]+)>\s*(.*?)\s*</function>", re.S)
_PARAM = re.compile(r"<parameter=([A-Za-z0-9_.-]+)>\s*(.*?)\s*</parameter>", re.S)


def parse_text_tool_calls(content):
    """Return the calls a model wrote out as text, or [] when the text is not exclusively that.

    Pure: no I/O, no clock, no randomness. The caller decides what to do with the result.
    """
    if not content or "<tool_call>" not in content:
        return []
    blocks = _CALL.findall(content)
    if not blocks:
        return []

    # Everything outside the blocks must be whitespace. A single word of prose means the model was
    # TALKING about a call, and rewriting that into one would invent an action the reader never saw.
    if _CALL.sub("", content).strip():
        return []

    calls = []
    for body in blocks:
        fn = _FUNC.search(body)
        if not fn:
            return []  # a block we do not fully understand disqualifies the whole content
        args = {name: value for name, value in _PARAM.findall(fn.group(2))}
        calls.append({"name": fn.group(1), "arguments": args})
    return calls


def as_openai_tool_calls(calls, id_prefix="fabula_txt"):
    """Shape parsed calls the way every consumer downstream already expects to receive them."""
    out = []
    for i, c in enumerate(calls):
        out.append(
            {
                "index": i,
                "id": "%s_%d" % (id_prefix, i),
                "type": "function",
                "function": {"name": c["name"], "arguments": json.dumps(c["arguments"], ensure_ascii=False)},
            }
        )
    return out
