# Figloom integration (`figloom-verify@0.0.3`)

Read this at step 5d. Use the pinned public package; don't copy the
verification engine into the skill. Node >=22.13. The Figma baseline needs
`FIGMA_ACCESS_TOKEN`; the target app must already be running.

## Setup (only when the showcase route needs a logged-in session)

Confirm the CLI is reachable first:

```bash
npm exec --yes --package=figloom-verify@0.0.3 -- figloom status --project-root "$PWD"
```

`figloom.config.ts` is optional. `status`, `verify`, and `done-gate` all work
with no config file present — the CLI only reads it for `storageStatePath`
(a saved Playwright login session). Skip this whole section unless the
component's showcase route sits behind auth.

```bash
npm exec --yes --package=figloom-verify@0.0.3 -- \
  figloom init --project-root "$PWD"
npm exec --yes --package=figloom-verify@0.0.3 -- \
  figloom auth --url <login-url> --project-root "$PWD"
```

`init` writes `figloom.config.ts` at the project root (refuses to overwrite
an existing one — pass `--force` only when intentionally replacing it) plus
a git-ignored `.figloom/auth/` directory. `auth` opens Playwright for
interactive login and saves the session to `.figloom/auth/user.json`; after
it succeeds, uncomment `storageStatePath` in `figloom.config.ts`.

Report this setup state to the user once per component run, not once per
batch — it names a file the CLI just wrote to their project root:

```text
Figloom config: <written figloom.config.ts | already present | not needed (no auth route)>
Requires: Node >=22.13, FIGMA_ACCESS_TOKEN, target app already running.
After verify, review with: figloom report --artifact <verification.json> --output <dir>
```

## Write contracts and verify

There is no CLI flag to batch-generate contracts from a cases file —
`figloom contract create` is an interactive terminal wizard for a human, one
contract at a time, and isn't scriptable by an agent. Write the schema-v4
contract JSON directly instead. Confirm the exact live shape whenever the
pinned version changes:

```bash
npm exec --yes --package=figloom-verify@0.0.3 -- figloom schema --target contract
```

Create exactly 1 schema-v4 region contract per `coverage.expectedTestids[]`,
grouped under one `visual-contract.json` per batch (shared `target.url`,
`contracts[]` array):

- selector `[data-testid='...']`, unique;
- Figma baseline using the exact visual-state `fileKey/nodeId`;
- `scope.expectSize` taken from the exact Figma state;
- profile `component/strict`;
- `outDir` unique under `.figloom/artifacts/visual-verifications/`;
- at most 8 contracts per `visual-contract.json` (`contracts[]` is capped at
  8 by the schema — `MAX_CONTRACTS_PER_REQUEST`); split into multiple files
  as needed.

Don't reuse a shared binding/group node for multiple states. Don't create a
result schema parallel to the official contract — see
`skills/verify-visual/references/contract.md` for a full worked example of
the same schema.

Run once per batch file (`batch-1.contract.json`, `batch-2.contract.json`, ...
when more than 8 states):

```bash
npm exec --yes --package=figloom-verify@0.0.3 -- \
  figloom verify --project-root "$PWD" \
  --contract .figloom/artifacts/visual-verifications/button/batch-1.contract.json \
  --output .figloom/artifacts/visual-verifications/button/batch-1.verification.json

npm exec --yes --package=figloom-verify@0.0.3 -- \
  figloom done-gate \
  --artifact .figloom/artifacts/visual-verifications/button/batch-1.verification.json
```

Exit `1` from `verify` is a visual failure. Inspect `actual.png`,
`diff.png`, `visual-score.json`, `punch-list.json`; fix the code and rerun,
up to 3 rounds. Don't loosen the threshold or update the baseline to force
a pass.

For human review, export a static dashboard instead of pointing reviewers at
raw PNGs — the same dashboard `figloom open` shows live, without holding a
browser server open:

```bash
npm exec --yes --package=figloom-verify@0.0.3 -- \
  figloom report \
  --artifact .figloom/artifacts/visual-verifications/button/batch-1.verification.json \
  --output .figloom/artifacts/visual-verifications/button/batch-1.report
```

Report the resulting report directory path alongside the gate artifact so a
human reviewer can open it directly instead of diffing PNGs by hand. Don't
run `figloom open` from this skill — it opens a live browser server and
blocks on shutdown, unsuited to an automated pipeline; it's fine for the user
to run manually afterward.

## Bind evidence into the gate

Write the input manifest:

```json
{
  "schemaVersion": 1,
  "artifacts": [
    {
      "verificationArtifactPath": ".figloom/artifacts/visual-verifications/button/batch-1.verification.json"
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
