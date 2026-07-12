// Secret redaction.
// Scrub well-known secret shapes from tool output BEFORE it enters the model context / history.
// Conservative: each pattern targets a distinctive prefix/shape to avoid mangling normal text.

interface Pat { re: RegExp; label: string }

const PATTERNS: Pat[] = [
  // Provider API keys (incl. NVIDIA and Zhipu key formats so they never leak)
  { re: /\bnvapi-[A-Za-z0-9_\-]{20,}/g, label: "NVIDIA_KEY" },
  { re: /\bsk-ant-[A-Za-z0-9_\-]{20,}/g, label: "SK_ANT_KEY" },
  { re: /\bsk-[A-Za-z0-9]{20,}/g, label: "OPENAI_KEY" },
  { re: /\bAIza[0-9A-Za-z_\-]{35}/g, label: "GOOGLE_KEY" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, label: "GITHUB_TOKEN" },
  { re: /\bxox[baprs]-[A-Za-z0-9\-]{10,}/g, label: "SLACK_TOKEN" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS_ACCESS_KEY" },
  { re: /\bASIA[0-9A-Z]{16}\b/g, label: "AWS_TEMP_KEY" },
  { re: /\bglpat-[A-Za-z0-9_\-]{20,}/g, label: "GITLAB_TOKEN" },
  { re: /\bhf_[A-Za-z0-9]{20,}/g, label: "HUGGINGFACE_TOKEN" },
  { re: /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/g, label: "ZHIPU_KEY" }, // <hex32>.<16> (Zhipu/GLM)
  // Bearer / authorization headers
  { re: /\bBearer\s+[A-Za-z0-9_\-\.=]{20,}/g, label: "BEARER_TOKEN" },
  { re: /\bbasic\s+[A-Za-z0-9+/=]{16,}/gi, label: "BASIC_AUTH" },
  // JWT (three base64url segments)
  { re: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, label: "JWT" },
  // Private key PEM blocks
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, label: "PRIVATE_KEY" },
  // Connection strings with inline credentials
  { re: /\b[a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/gi, label: "URL_CREDENTIALS" },
  // Generic "secret/token/password/api[_-]key = <value>"
  { re: /\b(api[_-]?key|secret|token|password|passwd|access[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9_\-\.\/+]{12,}["']?/gi, label: "GENERIC_SECRET" },
]

// High-confidence, distinctive-prefix secrets (NO generic key=value / conn-string — those false-positive
// on normal URLs). Used for exfil detection: a fetch URL embedding one of these is data exfiltration.
const HARD_SECRET = new RegExp(
  [
    /nvapi-[A-Za-z0-9_\-]{20,}/, /sk-ant-[A-Za-z0-9_\-]{20,}/, /sk-[A-Za-z0-9]{20,}/,
    /AIza[0-9A-Za-z_\-]{35}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /xox[baprs]-[A-Za-z0-9\-]{10,}/,
    /AKIA[0-9A-Z]{16}/, /ASIA[0-9A-Z]{16}/, /glpat-[A-Za-z0-9_\-]{20,}/, /hf_[A-Za-z0-9]{20,}/,
    /eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/,
  ].map((r) => r.source).join("|"),
)

/** True if the text contains a high-confidence secret (for exfil-URL blocking). */
export function containsHardSecret(s: string): boolean {
  if (typeof s !== "string" || !s) return false
  return HARD_SECRET.test(s)
}

export interface RedactResult { text: string; count: number; labels: string[] }

/** Replace detected secrets with [REDACTED:LABEL]. Returns the scrubbed text + what was hit. */
export function redactSecrets(input: string): RedactResult {
  if (typeof input !== "string" || !input) return { text: input ?? "", count: 0, labels: [] }
  let text = input
  let count = 0
  const labels = new Set<string>()
  for (const { re, label } of PATTERNS) {
    text = text.replace(re, (m) => {
      // For "key = value" generic matches, keep the key name, redact only the value.
      if (label === "GENERIC_SECRET") {
        const eq = m.search(/[:=]/)
        if (eq > 0) { count++; labels.add(label); return m.slice(0, eq + 1) + " [REDACTED:SECRET]" }
      }
      count++; labels.add(label)
      return `[REDACTED:${label}]`
    })
  }
  return { text, count, labels: [...labels] }
}
