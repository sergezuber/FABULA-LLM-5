// The self-improvement passes are OPT-IN (owner's rule, 2026-07-28, universal): a fresh install must
// never occupy the model's single inference slot with housekeeping nobody asked for. The measured
// experience of the old default was a spinner over a delivered answer and the user's next question
// queued behind a pass they never started.
//
// The environment is made to BITE on purpose: a root session 100 days old, no pass ever run — the exact
// state in which the old always-on default fired. An empty config must still run nothing; only an
// explicit auto:true is consent. (A first version of this suite asserted against an EMPTY database and
// passed identically with the default reverted — the pass declined for the wrong reason.)
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { shouldAutoDream, shouldAutoDistill } from "../../src/session/auto-dream"
import { Database } from "../../src/storage"
import { SessionTable } from "../../src/session/session.sql"
import { Session as SessionNs } from "../../src/session"
import { provideTmpdirInstance } from "../fixture/fixture"

const DAY = 86_400_000
const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("auto self-improvement is opt-in, in an environment where the old default fired", () => {
  it.live(
    "an empty config runs nothing; only an explicit auto:true is consent",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        yield* Effect.sync(() =>
          Database.use((d) =>
            d.update(SessionTable).set({ time_created: Date.now() - 100 * DAY }).where(eq(SessionTable.id, info.id)).run(),
          ),
        )
        // default: silence
        expect(yield* shouldAutoDream({} as never)).toBe(false)
        expect(yield* shouldAutoDistill({} as never)).toBe(false)
        expect(yield* shouldAutoDream({ dream: {} } as never)).toBe(false)
        expect(yield* shouldAutoDistill({ distill: {} } as never)).toBe(false)
        // explicit consent: the pass may run (the project above is old enough, nothing ran before)
        expect(yield* shouldAutoDream({ dream: { auto: true } } as never)).toBe(true)
        expect(yield* shouldAutoDistill({ distill: { auto: true } } as never)).toBe(true)
      }),
    ),
  )
})
