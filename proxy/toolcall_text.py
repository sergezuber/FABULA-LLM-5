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

    # PROSE AROUND A COMPLETE BLOCK IS NORMAL; PROSE INSTEAD OF ONE IS NOT.
    #
    # The first version required everything outside the blocks to be whitespace, reasoning that any prose
    # meant the model was TALKING about a call. That guard is right about the danger and wrong about the
    # test: measured live 2026-07-28, the model wrote "Давай посмотрим, что в этой папке." and then a
    # perfectly well-formed block, and this returned [] — so the recovery never fired in exactly the case
    # it exists for, and the turn looped until it died.
    #
    # What separates a real call from a description of one is not the absence of surrounding words — it
    # is whether the block is SYNTACTICALLY COMPLETE: opened and closed, naming a function, with each
    # parameter opened and closed. Documentation quoting a fragment does not satisfy that; a model
    # narrating its next step before emitting the call does. The completeness test lives in the parse
    # below — a block we do not fully understand still disqualifies the whole content — so the guard here
    # only needs to refuse content with NO complete block at all.
    #
    # THE DISCRIMINATOR IS WHERE THE PROSE SITS, not whether there is any.
    #
    # A model that CALLS narrates its next step, emits the call, and stops — the block is the last thing
    # in the message. A model that TALKS ABOUT a call embeds it mid-sentence and keeps writing: "I would
    # normally write <tool_call>…</tool_call> here, but I will not." Completeness cannot tell those apart,
    # because the quoted block is perfectly well-formed; position can, and it is the only thing that can.
    #
    # This was found by review after the first version shipped: relaxing "no prose at all" to "the block
    # is complete" made that sentence execute as a call — the exact false positive this file exists to
    # prevent, and pinned by test_prose_around_a_block_disqualifies_it since the day it was written.
    if _CALL.split(content)[-1].strip():
        return []

    calls = []
    for body in blocks:
        fn = _FUNC.search(body)
        if not fn:
            return []  # a block we do not fully understand disqualifies the whole content
        # Every parameter must be OPENED AND CLOSED. An unclosed one means the text was cut off or was
        # never a call at all, and inventing arguments from a fragment is worse than not recovering.
        body = fn.group(2)
        opened = len(re.findall(r"<parameter=", body))
        closed = len(re.findall(r"</parameter>", body))
        if opened != closed:
            return []
        args = {name: value for name, value in _PARAM.findall(body)}
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
