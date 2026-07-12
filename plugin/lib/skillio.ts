// Build/validate SKILL.md (pure, unit-testable). The save_skill tool vets content
// with skills_guard before writing. Format: YAML frontmatter (name, description) + markdown body.

/** Normalize a skill name to a safe kebab-case slug; rejects path traversal. */
export function sanitizeSkillName(name: string): string | null {
  if (typeof name !== "string") return null
  if (/[/\\]|\.\./.test(name)) return null   // reject path-traversal/slashes outright (clear bad intent)
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)
  return slug || null
}

/** Build SKILL.md content with valid frontmatter. description is flattened to one line. */
export function buildSkillMd(name: string, description: string, body: string): string {
  const desc = String(description || "").replace(/\s+/g, " ").trim().slice(0, 500)
  const b = typeof body === "string" ? body.trim() : ""
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${b}\n`
}

/** Quick structural validation of a SKILL.md string. */
export function validateSkillMd(md: string): { ok: boolean; reason: string } {
  if (!/^---\s*\n/.test(md)) return { ok: false, reason: "missing frontmatter opening ---" }
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!m) return { ok: false, reason: "unterminated frontmatter" }
  // value must be NON-EMPTY ON THE SAME LINE — use [ \t]* (not \s*, which would span the newline to
  // the next field and mis-validate an empty value as present).
  if (!/^name:[ \t]*\S/m.test(m[1])) return { ok: false, reason: "frontmatter missing name" }
  if (!/^description:[ \t]*\S/m.test(m[1])) return { ok: false, reason: "frontmatter missing description" }
  return { ok: true, reason: "" }
}
