import { test, expect } from "bun:test"
import { sanitizeSkillName, buildSkillMd, validateSkillMd } from "./skillio"
import { assessSkill } from "./skillsguard"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import * as path from "node:path"

test("sanitizeSkillName kebab-cases + rejects traversal", () => {
  expect(sanitizeSkillName("My Cool Skill")).toBe("my-cool-skill")
  expect(sanitizeSkillName("../../etc/passwd")).toBe(null)
  expect(sanitizeSkillName("a/b")).toBe(null)
  expect(sanitizeSkillName("   ")).toBe(null)
})
test("buildSkillMd + validateSkillMd round-trip", () => {
  const md = buildSkillMd("x", "when to use\nthis", "# body\nsteps")
  expect(md).toContain("name: x")
  expect(md).toContain("description: when to use this") // flattened
  expect(validateSkillMd(md).ok).toBe(true)
})
test("validateSkillMd catches malformed frontmatter", () => {
  expect(validateSkillMd("no frontmatter").ok).toBe(false)
  expect(validateSkillMd("---\nname: x\n---\n").ok).toBe(false) // missing description
})

// 4.5 — the shipped research skills must be structurally valid and pass skills_guard.
// The SHIPPED skills live in the repo's .fabula/skills — read that fixed path, NOT FABULA_SKILLS_DIR
// (other tests set that env to temp dirs; honoring it here would make this test order-dependent).
const skillsDir = path.join(import.meta.dir, "..", "..", ".fabula", "skills")
const hasSkills = existsSync(skillsDir)
test.if(hasSkills)("shipped research skills are valid + clean", () => {
  const names = readdirSync(skillsDir)
  expect(names.length).toBeGreaterThanOrEqual(3)
  for (const n of names) {
    const f = path.join(skillsDir, n, "SKILL.md")
    if (!existsSync(f)) continue
    const md = readFileSync(f, "utf8")
    expect(validateSkillMd(md).ok).toBe(true)
    // even treated as UNTRUSTED, our research skills must not trip dangerous-pattern blocks
    expect(assessSkill(n, md, { trusted: false }).blocked).toBe(false)
  }
})
