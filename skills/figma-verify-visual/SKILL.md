---
name: figma-verify-visual
description: Verify visual parity between exact Figma nodes and rendered code without implementing or modifying UI. Use when asked to compare, audit, recheck, validate, or prove that a screen, route, component, responsive viewport, or supplied UI state matches Figma; when fresh gold/actual/diff evidence is required; or when an existing visual verification artifact must be revalidated independently of implementation skills.
---

# Figma visual verification

Produce fresh, reproducible Figma-to-code evidence. Remain read-only unless user separately requests implementation fixes.

## Inputs

Require:

- exact Figma file key and node ID for each requested surface;
- rendered HTTP URL reachable from Playwright;
- viewport width and height;
- `page` scope with reason, or `region` scope with unique selector and expected size;
- deterministic route/showcase state matching supplied Figma node.

Do not invent missing Figma nodes, breakpoints, selectors, or UI states. Stop with exact missing input when contract cannot be made deterministic.

## CLI

Use installed `figloom-verify` package through repository package manager. Confirm before capture:

```bash
<package-manager> exec figloom status --project-root <repo-root>
```

If command is unavailable, report missing `figloom-verify` dependency. Do not fall back to MCP or copy engine scripts into host repository.

## Workflow

1. Inspect supplied Figma node and rendered target. Preserve exact node identity.
2. Choose one primary contract per supplied node. Add supplemental region only when it exposes meaningful localized risk.
3. Write `visual-contract.json` using [contract.md](references/contract.md).
4. Run bounded batch:

```bash
<package-manager> exec figloom verify \
  --project-root <repo-root> \
  --contract <task-dir>/visual-contract.json \
  --output <task-dir>/visual-verification.json
```

5. Inspect every `actual.png`, `diff.png`, `visual-score.json`, and `punch-list.json`. Engine `allPassed=true` never replaces image inspection.
6. Run independent integrity gate:

```bash
<package-manager> exec figloom done-gate \
  --artifact <task-dir>/visual-verification.json
```

7. Preserve CLI-returned `artifactPath` and `contentHash` for consuming gates. Report exact verdict and artifact paths. Do not edit code, rerun implementation loops, or claim developer approval.

## Contract rules

- Use 1–8 contracts per CLI call.
- Use `page` only for whole-screen comparison; include why full viewport is intended.
- Use `region` for component/content comparison; selector must resolve exactly once.
- Use `component/strict` with expected size for final region evidence.
- Use one output directory per contract. Never share evidence across nodes, states, or viewports.
- Require fresh Figma gold on every `verify` run.
- Treat exit `1` as completed visual mismatch, not tool failure. Read artifact and diff.
- Treat exit `2` as usage, schema, environment, or execution failure.

## Verdict

Pass only when:

- CLI `allPassed=true`;
- done-gate returns `done=true`;
- evidence identity, freshness, hashes, scope, viewport, and stability match contract;
- no medium/high residual diff cluster remains;
- direct image inspection finds no blocking mismatch hidden by aggregate score.

Otherwise return `FAIL` or `BLOCKED` with contract ID, reason, and absolute diff path.

## Output

Report one row per contract:

```text
id | Figma node | rendered URL | scope | viewport | matchRatio | pass | diff | notes
```

Then report aggregate verdict, verification artifact path, unresolved mismatches, and required manual review. Visual verification proves rendered parity only; it does not prove behavior, accessibility, component reuse, or implementation quality.
