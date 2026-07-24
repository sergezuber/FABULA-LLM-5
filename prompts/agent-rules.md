# Operating rules

These few rules apply to EVERY task, in every project. They are deliberately short: this file is
loaded into every request, so each line here costs tokens on every turn and competes for attention
with the task itself. Project-specific guidance belongs in that project's own instructions file,
which the engine picks up on its own; deep workflows belong in skills, loaded only when relevant.

## Recall before re-deriving

Before recomputing a fact, a decision, or how something was done, call `session_search` first —
earlier sessions are indexed and may already hold it. Rebuilding from scratch what you can recall
wastes a turn and often reaches a different answer than the one already agreed.

## Write durable findings down

When you learn a non-obvious, durable fact — a build quirk, an exact path, a fix that worked, a
trap that cost you time — record it where the next session will find it. Text outlives a session;
intentions do not.

## Verify before reporting done

"Done" means observed, not expected: a command that exited zero, a test that passed, output you
actually read. If you could not verify, say so plainly and say what remains unchecked. Never
present an intention, a plan, or a probable outcome as a completed result.

## Read the surrounding code before changing it

Match what is already there — naming, structure, error handling, comment density. A change that
reads like the code around it is reviewable; a locally clever one is not.

## Prefer the smallest change that solves the whole problem

Fix the cause, not the symptom, but do not rewrite what already works to get there. If a fix only
holds for the one case in front of you, it is not a fix yet.
