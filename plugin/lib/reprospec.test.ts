import { test, expect } from "bun:test"
import { languageOf, specPrompt, reproPrompt, extractCode, looksLikeTest, dedent } from "./reprospec"

test("dedent: strips common leading indentation (fixes model's indented snippets)", () => {
  expect(dedent("   def test_x():\n       assert 1 == 1")).toBe("def test_x():\n    assert 1 == 1")
  expect(dedent("def a():\n    pass")).toBe("def a():\n    pass") // already at col 0 → unchanged
  expect(dedent("")).toBe("")
})

test("extractCode: an indented snippet in a fence comes out dedented (runnable)", () => {
  const reply = "```python\n   def test_x():\n       assert elf._find_versions(b'') \n```"
  const out = extractCode(reply)
  expect(out.startsWith("def test_x():")).toBe(true) // no leading spaces on def
})

test("languageOf: from path/ext", () => {
  expect(languageOf("tests/unit/misc/test_elf.py")).toBe("python")
  expect(languageOf("src/foo.test.ts")).toBe("typescript")
  expect(languageOf("a/b.jsx")).toBe("javascript")
  expect(languageOf("pkg/x_test.go")).toBe("go")
  expect(languageOf("Cargo/lib.rs")).toBe("rust")
  expect(languageOf("spec/x_spec.rb")).toBe("ruby")
  expect(languageOf("README.md")).toBe("unknown")
})

test("specPrompt: instructs extraction (not solving) + embeds issue & code", () => {
  const p = specPrompt("Chromium version not parsed on Qt6.4+", "def _find_versions(data): ...")
  expect(p).toContain("SPEC EXTRACTOR")
  expect(p).toContain("Do NOT write the fix")
  expect(p).toContain("EXACT error messages")
  expect(p).toContain("Chromium version not parsed on Qt6.4+")
  expect(p).toContain("_find_versions")
})

test("reproPrompt: names the file, framework, fail-then-pass rule, code-only output", () => {
  const p = reproPrompt("issue text", "- must raise ParseError('No match in .rodata')", {
    language: "python", testPath: "tests/unit/misc/test_elf.py", importHint: "from qutebrowser.misc import elf",
  })
  expect(p).toContain("tests/unit/misc/test_elf.py")
  expect(p).toContain("pytest")
  expect(p).toContain("FAIL on the current")
  expect(p).toContain("ONLY the complete test source")
  expect(p).toContain("from qutebrowser.misc import elf")
  expect(p).toContain("No match in .rodata")
})

test("extractCode: pulls the first fenced block", () => {
  const reply = "Here is the test:\n```python\ndef test_x():\n    assert 1 == 1\n```\nHope it helps."
  expect(extractCode(reply)).toBe("def test_x():\n    assert 1 == 1")
})

test("extractCode: fence with no language tag", () => {
  expect(extractCode("```\nfunc TestX(t *testing.T) {}\n```")).toBe("func TestX(t *testing.T) {}")
})

test("extractCode: unterminated opening fence (token cutoff) → body without the ```lang line", () => {
  const cut = "```python\nimport pytest\ndef test_x():\n    assert elf._find_versions(b'') "
  const out = extractCode(cut)
  expect(out.startsWith("import pytest")).toBe(true)
  expect(out).not.toContain("```")
})

test("extractCode: no fence but code-ish → returned; prose → empty", () => {
  expect(extractCode("def test_a():\n    assert True")).toContain("def test_a")
  expect(extractCode("I think the fix is to change the regex, then it works.")).toBe("")
  expect(extractCode("" as any)).toBe("")
})

test("looksLikeTest: language-specific sanity", () => {
  expect(looksLikeTest("def test_partial():\n    assert elf._find_versions(b'') ", "python")).toBe(true)
  expect(looksLikeTest("import pytest\nwith pytest.raises(ValueError): f()", "python")).toBe(true)
  expect(looksLikeTest("test('x', () => { expect(1).toBe(1) })", "typescript")).toBe(true)
  expect(looksLikeTest("func TestFoo(t *testing.T) { }", "go")).toBe(true)
  expect(looksLikeTest("#[test]\nfn works() { assert!(true) }", "rust")).toBe(true)
  // prose / too short / wrong-shape must fail
  expect(looksLikeTest("just some words here about testing", "python")).toBe(false)
  expect(looksLikeTest("", "python")).toBe(false)
  expect(looksLikeTest("x=1", "go")).toBe(false)
})
