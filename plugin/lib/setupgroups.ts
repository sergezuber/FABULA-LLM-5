/**
 * What setup ASKS a person, and what each answer installs.
 *
 * The manifest already says, per plugin, which dependency that plugin cannot work without. That is a
 * statement about a PLUGIN, and the installer read it as a statement about FABULA: it installed the
 * required dependency of every plugin, including plugins the person would never use. The measured
 * cost of that reading was a 539 MB Chromium download for someone who wanted an agent for code, and
 * "LM Studio" presented as mandatory to someone whose model lives behind a corporate gateway. Users
 * reported the same thing in their own words: it is not clear what to install or why.
 *
 * So this file adds the missing layer — not another list of dependencies, but the QUESTION a person
 * can actually answer. Each group names what it is for, what it costs, and the honest reason to say
 * no. `core` is the only group with no question: without it FABULA does not run.
 *
 * ONE definition, deliberately. `setup.sh` asks from here, `install-deps.ts --groups` installs from
 * here, and the documentation is generated from here — so the three cannot drift into disagreeing
 * about what is mandatory, which is the defect this whole file exists to remove.
 */

export type SetupGroup = {
  id: string
  /** Plugin ids whose REQUIRED deps this group installs. Empty for groups that install nothing. */
  plugins: string[]
  /** Named dependencies to add on top, for optional deps that belong to a capability a person chooses. */
  extraDeps?: string[]
  /** The question, in the second person, answerable without reading the source. */
  question: string
  /** What it costs — download size or "nothing to download". A person deciding needs the price. */
  cost: string
  /** The honest reason to decline. Never "you probably don't need it" — say WHO does not need it. */
  skipIf: string
  /** Default when the person just presses Enter. */
  recommended: boolean
}

/** Installed always: FABULA cannot start without these. No question is asked about them. */
export const CORE_PLUGINS = ["tools", "checkpoint"] as const

export const SETUP_GROUPS: SetupGroup[] = [
  {
    id: "browser",
    plugins: ["browser"],
    question: "Should the agent be able to drive a real browser (open pages, click, fill forms)?",
    cost: "≈539 MB — a full Chromium",
    skipIf:
      "Skip it for coding work. Reading a web page does not need this: web_fetch pulls pages and strips them to text on its own, and it is installed either way. This is only for pages that must be CLICKED — a login, a dashboard behind a form.",
    recommended: false,
  },
  {
    id: "search",
    plugins: [],
    extraDeps: ["SearXNG"],
    question: "Should the agent be able to search the web?",
    cost: "a local SearXNG instance — a container or a service you run",
    skipIf:
      "Skip it if the machine has no internet, or if you already run a SearXNG elsewhere — in that case point FABULA at it in the config instead of installing a second one.",
    recommended: false,
  },
  {
    id: "sandbox",
    plugins: [],
    extraDeps: ["Docker"],
    question: "Should code the agent writes run inside a container?",
    cost: "Docker Desktop — a large install, and it must be running",
    skipIf:
      "Skip it and code still runs, confined by the OS kernel profile where the platform has one (Seatbelt on macOS, bubblewrap on Linux). On Windows there is no per-command kernel confinement, so a container is the only isolation there — that is the one case where saying no means running code unconfined.",
    recommended: false,
  },
  {
    id: "voice",
    plugins: [],
    extraDeps: ["piper", "faster-whisper"],
    question: "Do you want speech — the agent reading answers aloud, and dictation into the composer?",
    cost: "a few hundred MB of models",
    skipIf: "Skip it unless you actually intend to talk to it. Nothing else depends on speech.",
    recommended: false,
  },
  {
    id: "go",
    plugins: [],
    extraDeps: ["go", "govulncheck", "gosec", "staticcheck", "nilaway", "golangci-lint"],
    question: "Do you write Go, and should the security floor run on it?",
    cost: "the Go toolchain plus five analysers",
    skipIf:
      "Skip it unless you have Go projects. The floor is silent in any repository without a go.mod — it costs nothing when it is not used, so a missing Go toolchain is not a broken install.",
    recommended: false,
  },
]

/** How a person supplies a model. Exactly one applies; none of them is "install everything". */
export type ModelSource = "local" | "endpoint" | "later"

export const MODEL_SOURCES: { id: ModelSource; label: string; detail: string }[] = [
  {
    id: "local",
    label: "A model running on this machine",
    detail:
      "LM Studio is the usual way; anything that serves an OpenAI-compatible API works. Setup installs the localhost adapter FABULA talks to; you download the model in LM Studio yourself.",
  },
  {
    id: "endpoint",
    label: "An endpoint I already have",
    detail:
      "A corporate gateway or a cloud provider — anything OpenAI-compatible. Nothing to install: you fill in the address, the key and the model ids, and setup shows you where.",
  },
  {
    id: "later",
    label: "Decide later",
    detail: "Setup finishes and FABULA starts; the model picker will be empty until you add one.",
  },
]

/** Group ids selected → the plugin ids whose required deps must be installed. Core is always included. */
export function pluginsForGroups(selected: string[]): string[] {
  const chosen = SETUP_GROUPS.filter((g) => selected.includes(g.id)).flatMap((g) => g.plugins)
  return [...new Set([...CORE_PLUGINS, ...chosen])]
}

/** Group ids selected → extra dependency NAMES to install beyond the plugins' required set. */
export function extraDepsForGroups(selected: string[]): string[] {
  return [...new Set(SETUP_GROUPS.filter((g) => selected.includes(g.id)).flatMap((g) => g.extraDeps ?? []))]
}
