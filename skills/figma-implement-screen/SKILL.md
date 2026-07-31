---
name: figma-implement-screen
description: Implements web application screens, pages, routes, responsive layouts, and feature UI presentation from Figma through framework adapters. Use for explicit web screen/page/route/mobile-viewport/desktop-viewport work; do not use for native iOS or Android UI. React/JSX is the default and currently supported adapter. Human-in-loop workflow; developer always reviews code, Figma diff, and running UI. Does not own missing business logic.
---

# Implement Figma Screen UI

Build reviewable screen presentation through source evidence, component reuse, responsive code, and visual evidence.

## Human-in-loop contract

This skill does not autonomously approve UI. Developer always reviews generated code, Figma match percentage plus gold/actual/diff, and manually tests running UI. Gate success means evidence consistency only, never merge approval.

## Load on demand

| Need                        | Read                                      |
| --------------------------- | ----------------------------------------- |
| Artifact and registry rules | [screen contract](references/contract.md) |
| File placement              | [structure](references/structure.md)      |
| Test selectors              | [automation](references/automation.md)    |
| UI accessibility            | [validation](references/validation.md)    |
| Visual comparison           | [visual](references/visual.md)            |

## Boundary

In scope:

- web UI only; mobile means responsive browser viewport, not native UI;
- layout, responsive behavior, typography, spacing, tokens, assets;
- component reuse and Figma-prop translation;
- visual states supplied by Figma;
- accessible primitive semantics and UI-local interactions;
- props/callbacks needed for later logic integration.

Out of scope unless user explicitly supplies existing logic to preserve or wire:

- API/auth/database calls;
- mutations, redirects, analytics;
- business validation and product-flow decisions;
- claiming feature logic complete;
- replacing developer manual UI testing.

## Framework adapter and project config

Read `.figma/screen.config.json` when present:

```json
{
	"framework": "react",
	"packageManager": "pnpm",
	"pathAliases": { "#/": "src/" },
	"screensGlob": "src/features/*/screens/*/",
	"componentRegistryCli": ".agents/skills/figma-component-registry/scripts/figma-component-registry.mjs"
}
```

No config preserves current defaults exactly: React, pnpm, `#/` → `src/`, and `src/features/*/screens/*/`.

Run every skill executable as native ESM (`.mjs`) with `node`; do not require `tsx` or TypeScript runtime scripts. Source analysis runs through runtime-validated adapters in `scripts/adapters/`. Only `react` is implemented in v2; it scans target `.tsx` and `.jsx` source through compiler AST. Never treat an unknown framework as unscanned success. Stop on `framework adapter unavailable` until a real adapter exists.

Install pinned MJS runtime dependencies once after placing the skill:

```bash
npm ci --prefix .agents/skills/figma-implement-screen/scripts
```

Point host package scripts at Node entrypoints:

```json
{
	"figma-gate:screen": "node .agents/skills/figma-implement-screen/scripts/figma-gate-screen.mjs",
	"figma-inventory": "node .agents/skills/figma-implement-screen/scripts/figma-inventory.mjs"
}
```

Use configured package manager for project scripts. Use configured aliases and screen glob when resolving imports, siblings, and local component ownership. Config changes conventions only; Figma evidence, contract schema, visual gates, and developer-review requirements stay framework-independent.

## Workflow

### 1. Confirm boundary and fetch

Require explicit web screen, page, or route scope plus node-specific Figma URL. This skill owns no generic target router. If requested target is a design-system component, stop screen workflow and use `figma-implement-component`.

Fetch `get_design_context` and `get_screenshot` for every requested node. For large/truncated nodes, use metadata then fetch relevant children.

### 2. Inventory and resolve

1. Generate raw inventory with project `figma-inventory` script.
2. Classify each reusable item as detected or ignored.
3. Resolve through `src/components/ui`, validated `registry/**/*.json`, and `.figma/layout-map.json`.
4. Known design-system primitives cannot be ignored.
5. Icons/decorative assets require explicit replacement evidence in screen artifact.
6. Missing/stale registry entry → use `figma-component-registry`; never guess props or edit generated registry JSON by hand.

For every design-system resolution, record exact `registryEntry.filePath` and canonical SHA-256 `contentHash`. Gate cross-checks export name, source import path, and hash, then runs scoped registry `check` plus `verify-source` through configured CLI.

Ignored non-primitive items need exact identity, classification, replacement where relevant, and concise reason in task artifact. Separate pre-committed waiver files are not required for developer-reviewed UI work.

### 3. Implement UI

Read `.agents/architecture.md` and sibling screens. Keep routes thin. Implement presentation and existing UI-local interactions only.

Before editing, inventory behavior already available on the target route: submit paths, validation semantics, pending/error states, auth providers, links, redirects, callbacks, keyboard behavior, and accessibility names. Preserve it through existing interfaces. Figma absence is not permission to delete working behavior. If the design omits an existing product capability or requires changing it, stop and request a product decision; do not silently remove it for visual parity.

Treat pathless layout routes and shared chrome as multi-screen surfaces. Before changing one, identify every child route/consumer. Keep target-only spacing/background in the target screen when possible. If a shared edit is necessary, verify affected siblings and report them.

When logic is absent, expose integration points instead of inventing behavior:

```ts
type ScreenProps = {
	isLoading?: boolean;
	error?: string;
	onSubmit?: () => void;
};
```

`implementationFiles[]` lists UI files the gate must scan. It is not an exhaustive whole-repo diff contract; developer reviews actual Git diff.

Before gate, inventory every locally declared adapter-recognized root in scanned files:

- route/screen/layout/showcase roots → `entryComponents[]`;
- feature-owned composed blocks → `screenCompositions[]` with reason;
- declare each local root in exactly one list.

### 4. Visual comparison

For every requested mobile/desktop/state node:

1. Call `fidelity_verify` once with 1–8 exact contracts. It fetches fresh gold, captures stable final UI, compares, and writes evidence.
2. Inspect every returned `diff.png` and `topIssues`; `allPassed=true` is necessary but does not replace inspection.
3. Fix mismatches and rerun affected contracts only, maximum three rounds.
4. Call `fidelity_done_gate` with exact screen contracts before local unified gate.

Use a primary-content crop when it gives useful review evidence; add page comparison when chrome matters. A region can be a form/content group even when no card or surface exists. Geometry may suggest crops but does not replace developer judgment.

Every declared visual contract must have complete, fresh, hash-bound evidence and engine `pass=true` with no blocking residual cluster. A failing page average or localized cluster blocks handoff: inspect `diff.png`, add/use a focused region comparison when it helps diagnosis, fix, and rerun up to the three-round limit. If still failing, report visual work as blocked with exact diff paths; never call the screen implemented or gate-complete.

### 5. Gate and handoff

```bash
<package-manager> figma-gate:screen -- \
  --artifact .figma/artifacts/screens/<feature>/<screen>/screen-implementation.json
```

Then run skill validation, configured behavior/accessibility tests, lint/typecheck, and existing tests. Story/render tests or component tests prove supplied UI states; visual evidence alone does not prove interaction or accessibility.

Final report:

```text
Code: changed UI files
Visual: match % + gold/actual/diff per viewport/state
Existing behavior: preserved capabilities and approved changes
Shared impact: changed shared files + sibling routes verified
UI states: implemented presentation states
Logic integration points: callbacks/data/status props
Not implemented: business logic outside UI task
Manual QA: required
```

## Boundaries

- Design-system component → `figma-implement-component`.
- Registry-only → `figma-component-registry`.
- Figma canvas writes → Figma authoring tools.
- Developer owns final approval and manual UI test.
