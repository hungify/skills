---
name: verify-visual
description: Verify visual parity between rendered code and a known-good baseline — a Figma node or another web state — without implementing or modifying UI. Use when asked to compare, audit, recheck, validate, or prove that a screen, route, component, responsive viewport, or supplied UI state matches Figma or a prior approved snapshot; when fresh baseline/actual/diff evidence is required; or when an existing visual verification artifact must be revalidated independently of implementation skills.
---

# Visual verification

Produce fresh, reproducible baseline-to-code evidence. Remain read-only unless user separately requests implementation fixes.

## Inputs

Always require:

- rendered HTTP target URL reachable from Playwright (the code under test);
- viewport width and height;
- `page` scope with reason, or `region` scope with unique selector and expected size;
- deterministic route/showcase state matching the supplied baseline.

Baseline is one of two kinds — pick based on what the user supplied:

- **`figma` baseline** — exact Figma file key and node ID, in `fileKey:nodeId` colon form. If the source is a Figma URL, convert its `node-id=153-5181` (hyphen) query param to `153:5181` (colon) before writing the contract. Requires `FIGMA_ACCESS_TOKEN` in the environment (personal access token with access to the target file).
- **`web` baseline** — a second URL representing the known-good state, plus a `revision` string identifying exactly which state it is (a deploy tag, commit SHA, or explicit "approved on <date>" label — never an empty or vague placeholder). No Figma token needed. Only a `web` baseline may set `maskSelectors` to blank out dynamic content (timestamps, ads, live counters) before comparison.

Do not invent missing baselines, breakpoints, selectors, revisions, or UI states. Stop with exact missing input when the contract cannot be made deterministic.

## CLI

Require Node.js 22.13+, network access to npm, and Chromium available to Playwright. `FIGMA_ACCESS_TOKEN` is required only when any contract uses a `figma` baseline. Run the published CLI directly without modifying the host repository or its lockfile. Confirm before capture:

```bash
npx --yes figloom-verify@0.0.3 status --project-root <repo-root>
```

Require returned `name` and `version` to equal `figloom-verify` and `0.0.3`. If any contract uses a `figma` baseline, require `figmaTokenAvailable` to equal `true` — stop and report missing `FIGMA_ACCESS_TOKEN` before attempting capture, do not discover this via a failed `verify` run.

If npm, network access, or package is unavailable, report exact blocker. Do not install a project dependency, change the host lockfile, fall back to MCP, or copy engine scripts into the host repository. Installing the Playwright browser binary is allowed and expected when capture fails with a missing-Chromium error:

```bash
npm exec --yes --package=figloom-verify@0.0.3 -- playwright install chromium
```

## Workflow

1. Inspect supplied baseline (Figma node or web state) and rendered target. Preserve exact identity — node ID or baseline URL+revision.
2. Choose one primary contract per supplied baseline. Add supplemental region only when it exposes meaningful localized risk.
3. Write `visual-contract.json` using [contract.md](references/contract.md) — it includes a full worked Figma-vs-web example inline, plus a linked [web-regression.contract.json](references/examples/web-regression.contract.json) worked example for the web-vs-web case. `<task-dir>` below is that per-run directory: `.figloom/artifacts/visual-verifications/<target>/<run>/` — `visual-contract.json` and `visual-verification.json` live at its top level, alongside each contract's own `outDir`.
4. Run bounded batch — do not pass `--ui`; the dashboard flag opens a live browser server and blocks on shutdown, unsuited to an automated read-only check:

```bash
npx --yes figloom-verify@0.0.3 verify \
  --project-root <repo-root> \
  --contract <task-dir>/visual-contract.json \
  --output <task-dir>/visual-verification.json
```

5. Inspect every `actual.png`, `diff.png`, `visual-score.json`, and `punch-list.json`. Engine `allPassed=true` never replaces image inspection.
6. Run independent integrity gate:

```bash
npx --yes figloom-verify@0.0.3 done-gate \
  --artifact <task-dir>/visual-verification.json
```

7. Preserve CLI-returned `artifactPath` and `contentHash` for consuming gates. Report exact verdict and artifact paths. Do not edit code, rerun implementation loops, or claim developer approval.

## Contract rules

- Batch 1-8 contracts in one CLI call, matching pinned release `0.0.3`.
- Use `page` only for whole-screen comparison; include why full viewport is intended.
- Use `region` for component/content comparison; selector must resolve exactly once.
- Use `component/strict` with expected size for final region evidence.
- Use one output directory per contract, under `.figloom/artifacts/visual-verifications/...`. Never share evidence across baselines, states, or viewports.
- Require a fresh baseline fetch/capture on every `verify` run — never reuse a prior run's baseline image.
- `maskSelectors` (max 10) is valid only on a `web` baseline; the CLI rejects it on a `figma` baseline.
- Treat exit `1` as completed visual mismatch, not tool failure. Read artifact and diff.
- Treat exit `2` as usage, schema, environment, or execution failure.

## Verdict

Pass only when:

- CLI `allPassed=true`;
- done-gate returns `done=true`;
- evidence identity, freshness, hashes, scope, viewport, and stability match contract;
- no medium/high residual diff cluster remains;
- direct image inspection finds no blocking mismatch hidden by aggregate score.

Otherwise return `FAIL` or `BLOCKED` with contract ID and reason. Include absolute `diff.png` path only when a completed contract produced one; for an early blocker, report available artifact paths instead.

## Output

Report one row per contract:

```text
id | baseline (figma node or web url@revision) | rendered URL | scope | viewport | matchRatio | pass | diff | notes
```

Then report aggregate verdict, verification artifact path, unresolved mismatches, and required manual review. Visual verification proves rendered parity only; it does not prove behavior, accessibility, component reuse, or implementation quality.
