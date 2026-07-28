---
name: figma-component-registry
description: >-
  Use when syncing or validating Figma design-system component props against
  React or Vue 3 APIs, generating registry entries, investigating stale bindings,
  or running figma-component-registry commands.
when_to_use: |
  Trigger on: "does <Component> still match its Figma variant", "the <Component> mapping
  looks broken/stale again", "sync figma props for X", "why is the component-registry
  check failing", "regenerate the registry entry for X", "fetch the latest figma nodes
  for <fileKey>". Do NOT trigger for general Figma design/visual questions unrelated to
  code props, or requests to hand-edit a registry/*.json file directly (point to the CLI
  instead).
allowed-tools: >-
  Bash(node ${CLAUDE_SKILL_DIR}/scripts/figma-component-registry.mjs *)
paths:
  - "registry/**"
  - "src/components/**"
---

> **Version note:** `${CLAUDE_SKILL_DIR}` substitution and `when_to_use` require Claude Code
> v2.1.129+; `${CLAUDE_PROJECT_DIR}` substitution requires v2.1.196+. On older releases these
> fields are silently ignored — not an error — so commands just fall back to asking permission
> each time. `allowed-tools` only pre-approves the matching Bash command **for the turn that
> invokes this skill**; the grant clears on your next message, so it does not replace a
> standing permission rule if you want the CLI fully unprompted for a whole session. The
> PostToolUse drift-warning hook lives in `hooks/hooks.json` (this skill is also a plugin —
> see below); plugin hooks load at session start and need `/reload-plugins` after any edit,
> unlike `SKILL.md` text which updates live.

# Figma Component Registry

Generate validated Figma-property → code-API bindings and upsert them into the host project's `registry/`. Record differences; never invent feature logic or rename code APIs merely to mirror Figma.

All skill scripts are **ESM `.mjs` only** — no `.cjs` or `.ts` in this skill.

## Human-in-loop contract

This skill does not autonomously approve registry entries. The agent generates mappings and validation evidence. The developer reviews exceptional mappings and API changes before accepting output. `finalize` / `check` success proves schema and source consistency only — never merge approval.

**Explicit skill invocation with a Figma component URL is write intent.** When matching
code components exist, run the full fetch → extract-code → match → finalize → scoped
check → verify-source workflow and create every validated
`registry/<area>/<ExportName>.json`. The matched artifact's `codeComponent` values are
the export names; do not ask the user to confirm them again.

Exceptional `composition`, `unsupported`, `static`, `bundle`, and API-change mappings do
not create a pre-write confirmation gate. Finalize valid output, then report those
mappings for developer review.

Stop before `finalize` only when no matching code component exists. Report the searched
source scope and missing component; never invent an export or code API. Fetch, matching,
schema validation, source verification, and filesystem errors fail normally.

`fetch`, `extract-code`, and `check` are read-only — run them freely while investigating.
Requests that only ask to check, validate, explain, or investigate remain read-only and
must not run `finalize`. Use `finalize --dry-run` only when the user explicitly requests
a preview or dry run.

## Storage

| Path | Role |
| --- | --- |
| `.figma/cache/<task-id>/_figma-props-raw.json`, `_figma-props-matched.json` | Temporary isolated Figma-cycle artifacts — removed after successful `finalize`, retained after failure or `--dry-run` |
| `.figma/cache/code-props-cache.json` | Only code-props artifact — one shared file for the whole repo |
| `registry/<area>/<ExportName>.json` | Durable schema-v2 registry entry (one file per `exportName`) |

The shared code cache retains compact normalized public APIs keyed by framework, source
path, source hash, and extractor version. Filtering is conservative: adapters remove
only confirmed event callbacks, framework globals, and framework-internal `key` / `ref`.
Inherited, ARIA, composition, and unknown props remain candidates because naming and
value heuristics cannot prove they are unrelated to Figma. `extract-code` and `check`
update only changed entries; a 100%-cache-hit run does not rewrite the file. Neither
command accepts or creates a per-task code cache.

`finalize` builds its mapping candidates in memory from the shared cache and current
Figma raw data. Exact names, compatible types, and overlapping values may rank a
candidate but never justify deleting an otherwise valid public prop before matching.

Durable `codePropsMap` is smaller again: it contains only code props referenced by
`figmaBindings` (`direct.prop` and `bundle.props[]`). Omitted/unbound props never enter
the registry or participate in drift checks.

Derive one filesystem-safe `<task-id>` from `fileKey + sorted nodeIds + run-id` for each active Figma sync cycle, for example `k0CrXX6p-415-100512-run-01`. `nodeId` alone is not globally unique, and `run-id` prevents concurrent work on the same source from colliding. Never reuse `.figma/cache` root or another active task's directory. Pass the same `--cache-dir` to `fetch` and `finalize`; successful finalize removes that cycle directory.

`code-props-cache.json` is independent of `fileKey`, `nodeIds`, and `run-id`. Never pass `--code-cache` yourself; it exists only for the pressure-test suite.

**Identity vs hints:** `figma.componentPath` is the stable identity for a design-system component. `figma.lastKnownFileKey` and `figma.lastKnownNodeId` are cache hints only — they speed up re-fetch but do not define validity. Duplicating a Figma file into another account silently reassigns ids; the name breadcrumb survives.

**Durable binding paths:** the `path` field on each `figmaBindings[]` entry strips `#digit:digit` suffixes from Figma property keys (e.g. `Show prepend#529:0` → `Button > btn > Show prepend`). Matched-cycle artifacts use raw `figmaProp` keys including the suffix.

**Optional `figmaNodeId` on bindings:** when one code component maps to multiple Figma component sets, include `figmaNodeId` on each binding so `verify-source` and carried-forward merge can recover the correct group without ambiguity.

## Reading results — do NOT dump raw JSON into context

`_figma-props-raw.json`, `code-props-cache.json`, and
`_figma-props-matched.json` are large machine-readable intermediates. Never `cat` them
into the conversation. Use `jq` for a summary instead, e.g.:

    jq '.components | keys | length' <cache-dir>/_figma-props-raw.json
    jq '.figmaBindings | length' registry/<area>/<ExportName>.json

Only the final `registry/<area>/<ExportName>.json` and CLI stdout summaries are meant to
be read directly. This is a standing rule for the whole session, not a one-time step.

## Commands

Direct CLI — use this exact form so `allowed-tools` pre-approval applies:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/figma-component-registry.mjs fetch --cache-dir .figma/cache/<task-id> --file-key <key> --node-ids <ids>
node ${CLAUDE_SKILL_DIR}/scripts/figma-component-registry.mjs extract-code --ui-dir src/components
# agent writes .figma/cache/<task-id>/_figma-props-matched.json
node ${CLAUDE_SKILL_DIR}/scripts/figma-component-registry.mjs finalize --cache-dir .figma/cache/<task-id>
node ${CLAUDE_SKILL_DIR}/scripts/figma-component-registry.mjs check
node ${CLAUDE_SKILL_DIR}/scripts/figma-component-registry.mjs check --components Button,Input
node ${CLAUDE_SKILL_DIR}/scripts/figma-component-registry.mjs verify-source --components Button,Input
```

If the host project has wired `pnpm figma-component-registry:*` scripts in its own
`package.json` to the CLI above, those work identically — but they are the host
project's convenience aliases, not something this skill ships, so don't assume they
exist. `${CLAUDE_SKILL_DIR}/scripts/package.json` only declares this CLI's own
dependencies (`ajv`, `react-docgen-typescript`, `vue-component-meta`, …); run its test suite directly with
`node ${CLAUDE_SKILL_DIR}/scripts/figma-component-registry-pressure.mjs`.

There is **no** prune, unlink, delete, or registry-remove CLI. Passing `--prune` exits with an error.

**Extra flags:**
- `finalize --dry-run` — validate + build the entry, print a diff preview, write nothing.
- `extract-code` / `check` `--quiet` — suppress progress logs; on staleness, print only the
  short headline (drop the per-item list). Exit code is unchanged.
- `fetch` / `extract-code` / `check` `--verbose` — print extra detail to stderr (node/component
  counts, cache hit/miss).
- `check --components Button,Input` — still extracts the full `--ui-dir` (needed to keep the
  shared code-cache correct) but scopes the *drift check itself* to the named `exportName`s, so
  only those components can fail the command. Without `--components`, `check` fails on drift in
  any extracted component. `verify-source --components Button,Input` is unrelated and mandatory
  there — it does a live Figma re-check for those registry files specifically.

## Workflow

1. **Fetch** — pull component / component-set definitions from Figma REST.
2. **Extract-code** — update the one shared code cache from component APIs under `--ui-dir`; unchanged sources do not rewrite it.
3. **Match** — agent writes `_figma-props-matched.json`; match every Figma property exactly once inside its owning group.
4. **Finalize** — for explicit skill invocation with a Figma component URL or another sync/generation request, build code candidates in memory from shared cache, validate group/property/value coverage and definitions, upsert every `registry/<area>/<ExportName>.json`, then remove successful cycle artifacts. Do not pause for export-name confirmation when matching code components exist. Failure and user-requested `--dry-run` retain cycle artifacts for review.
5. **Check and verify-source** — run scoped code drift check and live Figma verification for every finalized export.

## Framework adapters

Framework is detected on every `extract-code` / `check` run from `package.json` at the
current app/package root. `react` selects `.tsx`; `vue` selects `.vue`. No
`registry/config.json` exists. In a monorepo, run from the individual app/package root,
not the workspace root. If both frameworks are declared at one root, detection fails;
use the correct app root or explicit `--framework`.

| `framework` | Files | API extractor | Boundary |
| --- | --- | --- | --- |
| `react` | `.tsx` | `react-docgen-typescript` plus TypeScript AST/CVA ownership analysis | Current React TypeScript components |
| `vue` | `.vue` | `vue-component-meta` | Vue 3 SFCs only; no Vue 2 or class-component compatibility |

Vue extraction reads compiler metadata for `defineProps`, `withDefaults`, and
`defineModel`. `defineEmits` listeners and Vue global props are excluded using compiler
metadata; explicitly declared props remain even when their names resemble events or
ARIA attributes. `defineSlots` stays available to composition review rather than direct
prop mapping. Keep Figma mapping rules framework-neutral: adapters normalize public
component APIs to the same `type` / `values` shape before matching.

`finalize` **merges** this cycle's groups into the component's existing carried-forward groups (matched by `figmaNodeId`) instead of overwriting blindly — a cycle that only re-syncs one Figma node never silently drops other validated groups. Carried-forward groups not covered by this cycle's fetch are re-verified live against Figma; a deleted node hard-fails finalize.

## mappingKind reference

| `mappingKind` | Required fields | Meaning |
| --- | --- | --- |
| `direct` | `prop`; full `valueMap` when values differ semantically | One Figma property maps to one code prop |
| `bundle` | `props`, `valueProps` | One Figma value assigns several code props at once |
| `composition` | `note`; no `prop` | Expressed through children, slots, icons, or parent composition |
| `unsupported` | `note`; no `prop` | No code representation in the current API |
| `static` | `note`; no `prop` | Figma node has zero `componentPropertyDefinitions` — records node↔code correspondence only |

Use `figmaProp` `"__no_properties__"`, `figmaType` `"COMPONENT"`, and a `note` for `static` groups.

A prop with no clean Figma counterpart (derived or behavioral, e.g. `onDelete`) can simply not appear in `figmaBindings` — do not force a mapping that is not real.

## Review policy

- Exclude only props proven to be framework globals/internals or confirmed event
  callbacks. Name-only, type-only, or value-only heuristics may rank candidates but
  must not delete them.
- Direct / bundle mappings remain strict and machine-validated.
- Exact normalized code-prop candidates cannot be hidden as composition / unsupported.
- `composition` / `unsupported` / `static` requires a concise `note`.
- Unknown enumerable code domains require explicit `valueMap` (direct) or complete `valueProps` (bundle).
- Omit identity and case-only `valueMap` entries; validator rejects redundant maps.
- Figma `BOOLEAN` may map directly to extracted component `boolean`.
- Duplicate property names remain group-local.

Developer normally reviews composition, unsupported, static, bundle, and API changes. High-confidence direct mappings remain available for inspection but need no separate ceremony.

Screen / component gates scope freshness to components used by the current task. Run unscoped `figma-component-registry:check` only for full-library maintenance or CI.

## Common issue: variant members with 0 properties

**Cause:** Figma auto-names variant members `Prop1=Value1, Prop2=Value2, …`. `componentPropertyDefinitions` lives on the **COMPONENT_SET parent only**, not on individual variant members.

**Solution:** `fetch` keeps the `COMPONENT_SET` and prunes its descendant variant members automatically. If the requested root itself is a 0-property variant member, `fetch` prints a warning; walk up and re-fetch the **parent's** node id. Treat that warning as blocking. Only mark a 0-property `COMPONENT` as `static` when its name does **not** match the variant pattern.

## Output

Report created/updated registry files, exceptional mappings needing developer review, and commands run. Do not claim feature logic implemented.

See `references/schema.md` for durable and matched JSON examples.
