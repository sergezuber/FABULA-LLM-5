// FABULA-LLM-5 — read/view limit floor (separate plugin per rule #4).
//
// Weak local models (Qwen3.6 NVFP4) habitually send `read`/`view` with limit=100 — reading files in
// tiny 100-line dribbles even though the tool DEFAULT is 2000 and the runtime-tools addendum says "read the whole
// file, omit offset/limit". With a 500K-context model that's pure round-trip waste (and looks like a loop:
// "20 reads with limit=100"). On a FIRST / whole-file read (no offset, or offset<=1) we floor a too-small limit
// up to 2000 (== the engine's DEFAULT_READ_LIMIT) so the model reads a file in one shot. PAGINATED reads
// (offset>1) are LEFT UNTOUCHED so we never disrupt the model's "advance offset by exactly limit" stride.
// We MUTATE `output.args` IN PLACE — a REPLACED output.args is silently discarded by the binary (the same
// gotcha documented in fabula-reliability), so we only set fields, never reassign.

import type { Plugin } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"

const TARGET = 2000 // the engine's DEFAULT_READ_LIMIT — a first read should get at least this many lines

export const FabulaReadFloor: Plugin = async () => gate("readfloor", ({
  "tool.execute.before": async (input: any, output: any) => {
    try {
      const tool = input?.tool
      if (tool !== "read" && tool !== "view") return
      const args = output?.args
      if (!args || typeof args !== "object") return
      // Only floor a FIRST/whole-file read (no offset or offset<=1); leave genuine pagination alone.
      const offset = Number(args.offset)
      const firstRead = args.offset == null || !Number.isFinite(offset) || offset <= 1
      const lim = Number(args.limit) // coerce: the model sometimes sends "100" as a string
      if (firstRead && Number.isFinite(lim) && lim > 0 && lim < TARGET) {
        args.limit = TARGET // IN-PLACE mutation
        if (input?.callID) floored.add(String(input.callID))
      }
    } catch {}
  },
  // Honesty layer: the timeline shows the model's RAW argument (recorded pre-hook), which reads
  // as "the harness hardcoded limit=80". Stamp the EFFECTIVE limit into the result metadata so
  // the UI can render "limit=80→2000" instead of a misleading raw value.
  "tool.execute.after": async (input: any, output: any) => {
    try {
      const id = input?.callID ? String(input.callID) : ""
      if (!id || !floored.has(id)) return
      floored.delete(id)
      if (!output || typeof output !== "object") return
      if (!output.metadata || typeof output.metadata !== "object") output.metadata = {}
      output.metadata.effectiveLimit = TARGET
    } catch {}
  },
}))

// callIDs floored this process (consumed in the after-hook; bounded — entries are deleted on use)
const floored = new Set<string>()
