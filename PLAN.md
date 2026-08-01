# Plan: fix #62 (flaky connect-timeout test) and #63 (version-gate blind spot)

Two independent fixes. Repo root: this worktree. Run tests with
`npm test -- --test-concurrency=1` (parallel `npm test` spawns many app-servers and can
saturate the machine).

Neither task touches `plugins/codex/**`, so **no plugin version bump is required** for this
branch. Do not bump `plugin.json` / `marketplace.json` / `package.json`.

---

## Task 1 — #62: de-flake `app-server connect timeout destroys a client whose initialize never replies`

### Where

`tests/runtime.test.mjs`, the test starting at line 202
(`"app-server connect timeout destroys a client whose initialize never replies"`).

### Root cause (confirmed, do not re-derive)

The test does:

```js
await assert.rejects(
  CodexAppServerClient.connect(workspace, { disableBroker: true, env: buildEnv(binDir), timeoutMs: 250 }),
  /codex app-server initialize timed out after 250ms\./
);

const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
await waitForProcessExit(fakeState.appServerPid);
```

`fake-codex-state.json` is written by the fixture only after a full Node cold start
(`tests/fake-codex-fixture.mjs`, `bootState.appServerPid = process.pid; saveState(bootState);`
just after the `app-server` argv check). When the 250 ms connect timeout fires and
`SpawnedCodexAppServerClient.destroy()` SIGKILLs the child *before* that boot write lands, the
file never exists and the synchronous `readFileSync` throws
`ENOENT ... fake-codex-state.json` — even though the behaviour under test (connect rejects, the
child is destroyed) worked correctly.

Evidence gathered:

- Standalone repro of the same connect at shrinking timeouts on an idle machine:
  `250ms` → passes; `120ms`, `60ms`, `30ms`, `10ms` → all fail with exactly
  `ENOENT: no such file or directory, open '.../fake-codex-state.json'`.
  So Node cold start here is ~120–250 ms and 250 ms is a ~1–2x margin, not a safe one.
- Reproduced live: a loop of `npm test -- --test-concurrency=1` failed on run 2 with
  `✖ app-server connect timeout destroys a client whose initialize never replies (252.5925ms)`
  and `Error: ENOENT ... fake-codex-state.json` — the predicted mechanism, verbatim.

### Fix

Two changes to that one test, both needed:

1. **Give the connect timeout enough headroom that the fixture's boot write reliably lands
   before the kill.** Raise `timeoutMs` from `250` to `2000` and update the rejection regex to
   match (`/codex app-server initialize timed out after 2000ms\./`). This turns a ~1–2x margin
   into a ~8–16x one. The behaviour under test is unchanged: the fixture behaviour is
   `initialize-never-replies`, so the timeout still fires and still destroys the client.
2. **Stop reading the fixture state synchronously.** Use the file-local `waitFor` helper
   (defined at the top of `tests/runtime.test.mjs`) to wait for a parseable
   `fake-codex-state.json` that carries an `appServerPid`, then `await waitForProcessExit(...)`
   on it.

Do **not** make the `waitForProcessExit` assertion conditional (e.g. `if (fakeState?.appServerPid)`).
The test must still fail if the pid never appears — a silently skipped assertion would prove
nothing. `waitFor` throwing `Timed out waiting for condition.` is the correct failure.

Sketch (adapt to the file's existing style):

```js
const fakeState = await waitFor(() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return Number.isFinite(parsed.appServerPid) ? parsed : null;
  } catch {
    return null;
  }
});
await waitForProcessExit(fakeState.appServerPid);
```

### Verify

- `node --test --test-concurrency=1 --test-name-pattern="connect timeout destroys" tests/runtime.test.mjs`
  passes.
- **Revert-and-rerun check for the regression:** temporarily set the timeout back to a value
  that loses the race (e.g. `timeoutMs: 30`, regex updated to match) and confirm the *new*
  code fails with `Timed out waiting for condition.` rather than `ENOENT` — i.e. the
  `waitFor` change alone converts a crash into an honest timeout, and the headroom change is
  what makes it pass. Restore `2000` afterwards. Report both observed outputs.
- Full suite: `npm test -- --test-concurrency=1`.

---

## Task 2 — #63: make the version gate catch two PRs shipping different source under one version

### Where

- `scripts/check-plugin-version-bump.mjs`
- `.github/workflows/pull-request-ci.yml` (the `Check plugin version bump` step)
- `tests/check-plugin-version-bump.test.mjs`

### Root cause (confirmed, do not re-derive)

The workflow runs:

```yaml
run: npm run check-plugin-version-bump -- --base "${{ github.event.pull_request.base.sha }}" --head HEAD
```

`github.event.pull_request.base.sha` is the commit the PR was **cut from**, not the base branch
as it exists at merge time. Two PRs cut from the same commit that both bump to the same next
version both pass; whichever merges second publishes different plugin source under a version
number the first already shipped.

Deterministic repro (verified against the current script):

1. Base commit at version `1.0.0` with `plugins/codex/scripts/thing.mjs`.
2. Branch `pr-a`: change `thing.mjs`, bump to `1.0.1`.
3. Branch `pr-b` from the same base: change `thing.mjs` differently, bump to `1.0.1`.
4. Merge `pr-a` into `main` (main is now `1.0.1`).
5. `node scripts/check-plugin-version-bump.mjs --root <repo> --base <base-sha> --head pr-b`
   → prints `Plugin source changes include version bumps to 1.0.1.` and **exits 0**.

### Fix

Add an *additional* check rather than replacing the existing branch-point comparison. Replacing
`--base` with the base branch tip would fail every open PR whenever main moves for any reason,
including changes that have nothing to do with the plugin; that is too noisy. The precise
condition we want to catch is narrower: *this version number is already published, with
different plugin source*.

1. **New `--base-tip <ref>` option** in `scripts/check-plugin-version-bump.mjs`, parsed the same
   way as the existing `--base` / `--head` / `--root` options (including the "requires a value"
   handling) and documented in `usage()`.

2. **When `--base-tip` is supplied and plugin source changed** (i.e. inside the existing
   `checkVersionBumps` flow, after the `pluginSourceFiles.length === 0` early return), also
   fail when **both** of these hold:
   - the head's version equals the version at the base tip, and
   - the head's plugin source differs from the base tip's plugin source
     (`git diff --name-only --diff-filter=ACMRD <baseTip>...<head>` filtered by the existing
     `isPluginSource`, i.e. reuse `changedFiles` + `isPluginSource`).

   Message should name the collision plainly and say what to do — e.g. that the base branch
   already publishes that version with different plugin source, and the branch needs a further
   bump / rebase. Include the offending version and the differing plugin source files, matching
   the existing message style (a `details` array joined with `\n`).

   If the head version and the base-tip version differ, this check passes regardless of source
   differences — that is the normal healthy case.

3. **Do not silently skip.** If `--base-tip` is supplied but the ref cannot be resolved, let the
   existing `runGit` error propagate (it already throws on non-zero git status, and `main()`
   already turns a throw into a printed message + exit 1). A silently skipped gate is the failure
   mode being fixed. When `--base-tip` is *omitted*, behaviour must be exactly as today — the
   existing tests that call the script without it must keep passing unchanged.

4. **Wire the workflow**: pass `--base-tip "origin/${{ github.base_ref }}"` alongside the
   existing `--base` / `--head`. `actions/checkout` already runs with `fetch-depth: 0`, so the
   base branch ref is present.

### Tests (`tests/check-plugin-version-bump.test.mjs`)

Follow the existing helpers in that file (`makeRepo`, `writeVersionFiles`, `writeFile`,
`commitAll`, `run`). Add coverage for:

- **The reported failure**: two branches from one base, both bumped to `1.0.1` with *different*
  plugin source, first merged into `main`; running the script for the second with
  `--base <branch-point> --base-tip main` now **fails** and names the collision. Assert this
  same invocation without `--base-tip` still exits 0, so the test pins exactly what the new
  option adds.
- **No false positive when the base tip moved but versions differ**: base tip at `1.0.1`, head
  bumped to `1.0.2` with different plugin source → passes.
- **No false positive when the version matches but the plugin source does not differ from the
  base tip**: e.g. the head is already contained in the base tip's plugin source → passes.
- **Non-plugin changes are still exempt**: a head that changes only files outside
  `plugins/codex/**` passes even with `--base-tip` pointing at a same-version tip.
- **An unresolvable `--base-tip` fails loudly** rather than passing.

### Verify

- `node --test --test-concurrency=1 tests/check-plugin-version-bump.test.mjs` passes.
- Re-run the 5-step repro above with `--base-tip main` added and confirm it now exits non-zero
  with the collision message; confirm the same command without `--base-tip` still exits 0.
- Full suite: `npm test -- --test-concurrency=1`.
