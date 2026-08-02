# Figloom integration (`figloom-verify@0.0.3`)

Read this at step 5d. Use the pinned public package; don't copy the
verification engine into the skill. Node >=22.13. The Figma baseline needs
`FIGMA_ACCESS_TOKEN`; the target app must already be running.

## Scaffold and verify

```bash
npm exec --yes --package=figloom-verify@0.0.3 -- figloom status --project-root "$PWD"
npm exec --yes --package=figloom-verify@0.0.3 -- \
  figloom init --from-cases .figloom/button-cases.json \
  --output .figloom/artifacts/visual-verifications/button/contracts
```

The cases input uses schema v1 with a shared `targetUrl`, `viewport`, and
`cases[]` containing `id`, the exact Figma `fileKey/nodeId`, `selector`,
`expectSize`. The CLI generates `contract-1.json`, `contract-2.json`, ...,
at most 8 contracts per file.

Create exactly 1 schema-v4 region contract per `coverage.expectedTestids[]`:

- selector `[data-testid='...']`, unique;
- Figma baseline using the exact visual-state `fileKey/nodeId`;
- `scope.expectSize` taken from the exact Figma state;
- profile `component/strict`;
- `outDir` unique under `.figloom/artifacts/visual-verifications/`;
- at most 8 contracts/request; split into batches as needed.

Don't reuse a shared binding/group node for multiple states. Don't create a
result schema parallel to the official contract.

```bash
npm exec --yes --package=figloom-verify@0.0.3 -- \
  figloom verify --project-root "$PWD" \
  --contract .figloom/artifacts/visual-verifications/button/contract-1.json \
  --output .figloom/artifacts/visual-verifications/button/verification-1.json

npm exec --yes --package=figloom-verify@0.0.3 -- \
  figloom done-gate \
  --artifact .figloom/artifacts/visual-verifications/button/verification-1.json
```

Exit `1` from `verify` is a visual failure. Inspect `actual.png`,
`diff.png`, `visual-score.json`, `punch-list.json`; fix the code and rerun,
up to 3 rounds. Don't loosen the threshold or update the baseline to force
a pass.

## Bind evidence into the gate

Write the input manifest:

```json
{
  "schemaVersion": 1,
  "artifacts": [
    {
      "verificationArtifactPath": ".figloom/artifacts/visual-verifications/button/verification-1.json"
    }
  ]
}
```

```bash
node <skill>/scripts/validate_figloom_evidence.mjs \
  --coverage <coverage-output.json> \
  --manifest <manifest.json> \
  --repo-root . \
  --out <component>.figloom-evidence.json
```

The validator maps coverage testids 1:1 onto the official contracts,
enforces Figma `component/strict` region identity, calls the released
`done-gate`, then hashes the verification artifacts. It does not re-parse
score/PNG/stability/threshold logic.
