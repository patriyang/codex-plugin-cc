# Plan: two-tier inactivity watchdog + errored-tool completion leak (#25)

## Background

`captureTurn` in `plugins/codex/scripts/lib/codex.mjs` has a single per-turn
inactivity watchdog (added in #24). `bumpActivity` rearms one timer on **every**
turn notification and, after `CODEX_TURN_STALL_TIMEOUT_MS` (default 300s) of total
silence, `handleStall` interrupts the turn (`turn/interrupt`) and force-completes it
with `{ status: "stalled" }`.

The flat 300s constant cannot distinguish a **hung tool** from a **legitimately long
review** — both are just "no notifications." Raising it re-opens the #22 wedge; lowering
it aborts long reviews (observed: a 7-task deep-review killed twice at exactly 300s).

**Constraint (verified):** the only abort lever exposed to the client is
`client.request("turn/interrupt", ...)`. There is **no per-tool cancel**. So the fix is
not "cancel the tool and continue" — it is (1) make the *decision to fire* principled,
and (2) stop an errored tool from wedging a nearly-done turn.

State already tracks the discriminator: `state.lastActiveItemLabel` is set on
`item/started` for an active tool item (`isActiveToolItem`) and cleared on
`item/completed` (see `applyTurnNotification`, ~`codex.mjs:663-685`).

## Success criteria

- A tool that goes silent while in flight is aborted within the short tool budget.
- A turn with **no** tool in flight (model reasoning / between steps) is NOT aborted
  until the long backstop elapses.
- An **errored** tool no longer wedges the turn: the in-flight marker is cleared and
  inferred completion is allowed to proceed.
- Both timeouts are env-configurable; existing `CODEX_TURN_STALL_TIMEOUT_MS` semantics
  are preserved as the backstop.
- New unit tests cover: hung-tool trips short budget; idle turn survives past short budget
  and trips only at backstop; errored in-flight tool clears the marker and does not wedge.
- Existing tests still pass.

## Task 1 — Two-tier watchdog keyed on in-flight tool

Rework the watchdog so the active budget depends on whether a tool is in flight.

- Add `resolveToolStallTimeoutMs(options)` mirroring `resolveStallTimeoutMs`, reading
  `options.toolStallTimeoutMs` then `CODEX_TOOL_STALL_TIMEOUT_MS`, default `90 * 1000`.
- Raise `DEFAULT_TURN_STALL_TIMEOUT_MS` to a generous backstop (`15 * 60 * 1000`). Keep
  the `CODEX_TURN_STALL_TIMEOUT_MS` override working exactly as before.
- Change `bumpActivity` to pick the budget at arm time: if `state.lastActiveItemLabel`
  is non-null use the tool budget, else use the turn (backstop) budget. `bumpActivity`
  already runs on every notification, so transitions (tool starts / completes) naturally
  re-arm with the correct budget because `lastActiveItemLabel` is updated in
  `applyTurnNotification` before/after the `bumpActivity` call — verify ordering and
  re-arm after the label mutation if needed (an explicit `bumpActivity` in the
  `item/started` / `item/completed` cases is acceptable).
- `handleStall`'s message should reflect which mode fired (tool-in-flight vs idle) and
  keep naming the in-flight item. Keep the interrupt + force-complete behavior unchanged.
- Guard values as `resolveStallTimeoutMs` does (`<= 0`, non-finite → disabled).

Verify: unit test where a tool `item/started` is emitted then no further notifications →
stall fires after the tool budget, not the backstop; and a turn that emits reasoning
notifications with no active tool survives past the tool budget and only trips at the
backstop.

## Task 2 — Errored-tool completion leak

When a tool errors, don't leave the turn wedged.

- Investigate the `error` notification path (`applyTurnNotification`, `case "error"`,
  ~`codex.mjs:671`) and errored `item/completed` items. Determine why an errored in-flight
  tool leaves `lastActiveItemLabel` set and blocks completion (check
  `scheduleInferredCompletion`, `pendingCollaborations`, `finalAnswerSeen`).
- On a tool error / errored tool `item/completed`: clear `state.lastActiveItemLabel`, and
  ensure inferred completion can proceed if the model has otherwise reached a final answer
  (so an errored *optional* tool like codegraph doesn't wedge a nearly-done turn).
- Do NOT swallow genuine errors — `state.error` should still be recorded; the change is
  about not wedging the turn, not hiding failures.

Verify: unit test where a tool `item/started` is followed by an `error` (or errored
`item/completed`) and a final-answer `agentMessage` → the turn completes via inferred
completion instead of hanging until the watchdog.

## Notes

- Keep changes surgical to `codex.mjs` and its tests. Match existing style.
- Do not implement adaptive-baseline or liveness-probe in this cut (listed as optional in
  the issue) — keep it minimal.
- Version bump and commit are handled by the controller, not Codex.
