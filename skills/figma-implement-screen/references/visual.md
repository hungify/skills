# Screen visual review

Read during screen fidelity verification.

Goal: produce honest, reproducible visual evidence for developer review. Engine success is required for handoff but remains insufficient for merge approval.

## Tools

Prefer the `figma-fidelity` MCP:

| Tool                  | Use                                                     |
| --------------------- | ------------------------------------------------------- |
| `fidelity_verify`    | Fetch fresh gold, capture stable final UI, compare, and write evidence for 1–8 contracts |
| `fidelity_done_gate` | Validate declared score, gold, hashes, scope, freshness, and stability                  |
| `fidelity_status`    | Confirm token, server version, and project-root resolution                              |

Low-level fetch/run/capture/compare tools are debug-only. CLI fallback through configured package manager's exec command for `figma-fidelity` is allowed when MCP is unavailable.

Use absolute artifact paths. Never claim a visual result from a stale capture.

## Coverage

- One supplied node needs one primary visual contract.
- Explicit mobile and desktop nodes need two primary contracts.
- Do not invent a breakpoint or Figma source.
- A primary contract may compare the whole page or a representative content region.
- Add supplemental contracts only when they expose a meaningful risk the primary comparison misses.
- A region may be a form/content group without a card/background surface.

Choosing page versus region is implementation judgment. Record the choice in `screen-implementation.json`; the gate verifies the declared evidence, while the developer judges whether the chosen crop is useful.

A region `goldNodeId` must be a visible descendant of its supplied source node.

## Artifact layout

```text
.figma/artifacts/screens/<feature>/<screen>/
  screen-implementation.json
  <sourceId>/
    page/
    regions/<region>/
```

Each declared contract folder contains:

- `figma-gold.png` and `figma-gold.meta.json`
- `actual.png`
- `diff.png`
- `visual-score.json`
- `run-meta.json`
- `punch-list.json`

Artifacts are review evidence and remain gitignored. Commit code and durable prop maps, not captures.

## Comparison loop

Run at most three focused fix rounds per supplied node:

1. Inspect Figma metadata and choose a useful page or region comparison.
2. Fetch the exact gold node.
3. Capture the real route/showcase with the declared viewport.
4. Run the matching profile:
   - `page` for whole-page comparison;
   - `component/strict` plus selector and expected size for a region.
5. Read `matchRatio`, `diff.png`, and `topIssues`.
6. Fix high-value mismatches, rerun affected contracts through `fidelity_verify`, and validate evidence integrity with `fidelity_done_gate`.

Do not stop because page average looks high. `pass=false` or a blocking residual cluster means the declared contract is not done. For page dilution/localized failure, inspect a focused descendant region in addition to the page, then fix the underlying page layout. If evidence cannot be generated or remains blocked after three rounds, report the blocker and exact diff paths. Do not manufacture a PASS or claim implementation complete.

## What the agent reports

For every primary contract report:

```text
sourceId | scope | goldNodeId | viewport | matchRatio | pass | diff notes | outDir
```

Also report:

- responsive and supplied UI states checked;
- visible deviations or unresolved mismatch clusters;
- anything not represented in Figma;
- manual checks the developer should perform.

Local gate treats missing, stale, tampered, contract-mismatched, engine `pass=false`, or blocking residual-cluster evidence as failure. A passing gate still does not override developer approval.

## Developer review

Developer decides whether the visual match is acceptable by checking:

1. generated UI code and component reuse;
2. match ratio plus the actual `diff.png`, especially primary controls and layout;
3. responsive and interactive UI manually.

Do not invent repo-specific score thresholds. Use the fidelity engine's `pass` and blocking-cluster verdict as the mechanical completion floor; developer still judges code, crop usefulness, non-blocking residuals, and running behavior.
