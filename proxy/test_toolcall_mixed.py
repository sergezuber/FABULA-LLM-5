"""Prose around a complete block is normal; prose INSTEAD of one is not.

Measured live 2026-07-28: the model wrote "Давай посмотрим, что в этой папке." and then a well-formed
block, and the recovery returned [] — it required everything outside the blocks to be whitespace, so it
never fired in exactly the case it exists for. What separates a real call from a description of one is
the block's COMPLETENESS, not the absence of surrounding words.
"""
from toolcall_text import parse_text_tool_calls as parse

BLOCK = "<tool_call><function=read><parameter=file_path>/x.md</parameter></function></tool_call>"

def test_prose_before_a_complete_block_is_still_a_call():
    calls = parse("Давай посмотрим, что в этой папке.\n" + BLOCK)
    assert len(calls) == 1 and calls[0]["name"] == "read"

def test_prose_after_and_around():
    assert len(parse(BLOCK + "\nСейчас прочитаю.")) == 1
    assert len(parse("Сначала:\n" + BLOCK + "\nПотом продолжу.")) == 1

def test_a_pure_block_still_works():
    assert len(parse(BLOCK)) == 1

def test_two_blocks_with_narration_between_them():
    assert len(parse("Сперва одно.\n" + BLOCK + "\nа теперь другое.\n" + BLOCK)) == 2

def test_talking_about_calls_is_not_calling():
    assert parse("Модель может писать <tool_call> — это разметка вызова, а не вызов.") == []
    assert parse("см. <tool_call> в документации") == []

def test_an_unclosed_parameter_is_refused():
    assert parse("<tool_call><function=read><parameter=p>/x</function></tool_call>") == []

def test_a_block_without_a_function_is_refused():
    assert parse("<tool_call><parameter=p>/x</parameter></tool_call>") == []

def test_nothing_at_all():
    assert parse("") == [] and parse(None) == [] and parse("обычный текст") == []
