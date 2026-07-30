# figma-component-registry hardening (schema v3)

## Context

`skills/figma-component-registry` is a Claude Code skill (CLI + hooks) that syncs Figma
design-system component props against React/Vue component APIs into a durable JSON
registry (`registry/<area>/<ExportName>.json`, schema v2). It ships 38 pressure tests
and a 10-scenario `evals.json`, both currently green.

A code review (general-purpose agent, direct file reads of every `scripts/lib/**`
module) found 9 concrete defects. Follow-up research into comparable open-source
projects (Figma Code Connect, Backstage `catalog-info.yaml`, Bit.dev, Buoy/ds-bridge)
surfaced architectural ideas — content-addressed immutable storage, explicit
`apiVersion`-style schema fields, explicit source precedence instead of implicit
ordering — and confirmed that even Figma's own Code Connect has not solved silent
staleness-on-write or ambiguous-source-precedence bugs.

This spec resolves both the 9 concrete bugs and which architectural ideas are worth
adopting, reached through brainstorming with the user across 5 design questions.

## Goals

- Fix the 9 known defects listed below.
- Fix the underlying race condition in `finalize`'s registry read-merge-write
  correctly (not just plausibly).
- Keep the registry human-reviewable in git diffs (this is load-bearing for the
  skill's human-in-loop contract: developers review registry changes in PRs).
- Do not introduce complexity that doesn't serve a concrete, present need (YAGNI) —
  every idea borrowed from research is evaluated against whether it actually
  addresses the failure mode, not adopted because another project does it.

## Non-goals

- No migration tooling from schema v2 to v3. This skill has not shipped to a host
  project with live production registry data yet (PR #2 introducing it is still
  open). `finalize`/`check` reject old `schemaVersion` values outright with a clear
  error; the fix is to re-run `fetch → finalize`, not to auto-convert.
- No content-addressed / immutable snapshot storage. Investigated and rejected — see
  "Rejected approaches" below.
- No `apiVersion`-string-with-alpha/beta schema versioning. Investigated and
  rejected — see "Rejected approaches" below.

## Rejected approaches (and why)

**Content-addressed snapshots + pointer file** (registry/<area>/<Export>/<hash>.json +
pointer.json, modeled on Bit.dev). Rejected because:
1. It does not actually fix the race condition. The bug is a *lost update*: two
   concurrent `finalize` runs on the same component each read the existing entry,
   merge in their own carried-forward groups in memory, then write. Content-addressed
   storage guarantees a reader never observes a half-written file — it does not
   guarantee two independent in-memory merges don't clobber each other. Fixing the
   lost update requires mutual exclusion around the read-merge-write critical section
   regardless of storage format.
2. It conflicts with an existing, deliberate design principle: this skill has no
   prune/delete command (`--prune` is explicitly rejected by `finalize`). Snapshots
   with no pruning mechanism accumulate registry files without bound.
3. It regresses the git-diff review ergonomics the human-in-loop contract depends on
   — a new hash-named file per sync doesn't produce a reviewable diff against the
   prior state the way a mutated flat file does.

**`apiVersion`-string schema versioning** (Backstage-style `v3alpha1 → v3beta1 → v3`).
Rejected because this skill has exactly one consumer of the schema (its own CLI), not
Backstage's many independently-versioned catalog readers/writers. A plain integer
`schemaVersion` is sufficient to gate `finalize`/`check` on an exact version and is
simpler to validate.

## Design

### 1. Concurrency: lock the critical section, keep flat-file storage

`registry/<area>/<ExportName>.json` layout is unchanged. `cmdFinalize` (in
`finalize.mjs`) wraps the existing read → `recoverGroupsFromRegistry` →
`mergeGroups` → `flattenGroupsToBindings` → `writeJsonAtomic` sequence, per output
path, in a `proper-lockfile` lock — the same dependency and pattern already used for
the shared code cache (`cache-io.mjs`'s `withCodeCacheLock`). Two concurrent
`finalize` runs targeting the same `registry/<area>/<ExportName>.json` now serialize:
the second acquires the lock only after the first's write completes, so it reads the
first run's already-merged carried-forward groups instead of a stale pre-write state.

### 2. Schema v3: structured path fields, drop dead `groups` field

Each `figmaBindings[]` entry gains `componentPath`, `groupName`, and `propName` as
first-class fields, populated directly from the same data `flattenGroupsToBindings`
already has when it constructs the entry — not derived later by parsing the `path`
string. `path` (e.g. `"Checkbox > Checkbox > Size"`) is retained purely as a
human-readable, git-diff-friendly label; no code path is allowed to parse it back into
components. This removes the entire bug class where a Figma group/component name
containing literal `>` corrupts reconstruction.

`entry.groups` — a field the schema allowed but `finalize` never populated, leaving
`recoverGroupsFromRegistry`'s `entry.groups` fast-path permanently dead — is removed
from the schema and from `recover-groups.mjs`. `recoverGroupsFromRegistry` always
reconstructs groups from `figmaBindings` (now using the structured fields instead of
`parseBindingPath`).

`schemaVersion: 3`. `finalize` and `check` reject any other value with an explicit
error naming the expected version.

### 3. Registry lookup: fail loud on ambiguous exportName

`registry-lookup.mjs`'s directory search collects **every** file matching a given
`exportName` instead of returning the first hit. If more than one match is found
(e.g. `ui/Button.json` and `marketing/Button.json`), the calling command
(`verify-source`, `check --components`) fails with an error listing every matching
path and instructions to disambiguate via `--area` or a full path. This mirrors the
lesson from Figma Code Connect issue #298 (an implicit-precedence bug, not just a
non-determinism bug): don't let the tool silently guess which source wins.

### 4. Remaining bug fixes (no architectural change)

- **Vue extractor per-file isolation** (`vue.mjs`): wrap each file's
  `vue-component-meta` parse in try/catch; a parse failure is collected as a
  per-file error and reported, without aborting the rest of the `extract-code` run
  or discarding already-parsed files' cache updates.
- **`finalize` catches prop-removal drift**: the check `verify-source` already
  performs (detecting when a durable `codePropsMap` prop no longer exists in the
  current code extraction) is also run inside `finalize` before writing, so removal
  drift fails fast at sync time instead of only being caught later by a separate,
  optional command.
- **`verify-source` reports all missing props per group**, not just the first.
- **Cache path filtering** between `--ui-dir` and `--source-root` compares path
  segments (via `path.relative` / boundary check) instead of a raw string-prefix
  test, so e.g. `src/comp` no longer falsely prefix-matches `src/components`.
- **`registryFilePath` sanitizes `exportName`** directly (rejects `..`, `/`, `\`)
  rather than relying entirely on upstream validation to have already caught it.

### Testing impact

- `figma-component-registry-pressure.mjs` fixtures move to `schemaVersion: 3` with
  the new structured path fields; existing test assertions referencing `path` string
  parsing are updated to assert on the structured fields instead.
- New tests: concurrent `finalize` calls on the same component don't lose
  carried-forward groups (lock behavior); a group/component name containing `>`
  round-trips correctly; Vue extractor continues past one bad file; `verify-source`/
  `check` fail with all matching paths listed on `exportName` collision; `finalize`
  fails on prop-removal drift, not just rename.
- `evals.json` is unaffected — none of the 10 scenarios assert on internal schema
  shape or the specific bugs above.

## Open questions

None outstanding — all fork points were resolved during brainstorming (concurrency
model, version field format, collision handling, path-fix approach, migration
stance).
