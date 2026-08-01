# figloom-verify

CLI-first Figma-to-code visual verification. Fetch exact Figma gold, capture stable rendered UI, compare multiple signals, and write reviewable evidence.

## Install

```bash
pnpm add -D figloom-verify
pnpm exec playwright install chromium
```

Set `FIGMA_ACCESS_TOKEN` in process environment, `.env.local`, or `.env`.

## Verify

Create a contract:

```json
{
  "schemaVersion": 3,
  "url": "http://127.0.0.1:3000/login",
  "contracts": [
    {
      "id": "login.desktop",
      "fileKey": "abc123",
      "nodeId": "153:5181",
      "viewport": { "name": "desktop", "width": 1440, "height": 1024 },
      "outDir": ".figma/artifacts/visual-verifications/login/desktop",
      "scope": {
        "kind": "page",
        "pageReason": "Supplied node represents the complete login screen."
      }
    }
  ]
}
```

Run one bounded verification batch:

```bash
pnpm exec figloom verify \
  --contract .figma/artifacts/visual-verifications/login/visual-contract.json \
  --output .figma/artifacts/visual-verifications/login/visual-verification.json
```

Exit codes:

- `0`: every contract passed;
- `1`: verification ran but one or more visual contracts failed;
- `2`: usage, schema, environment, or execution error.

Command output includes absolute `artifactPath` plus canonical SHA-256 `contentHash`. `visual-verification.json` records exact request, resolved project root, per-contract result, and output directories. Each contract directory contains:

```text
figma-gold.png
figma-gold.meta.json
actual.png
diff.png
visual-score.json
run-meta.json
punch-list.json
```

## Done gate

Revalidate freshness, identity, scope, stability, evidence hashes, and residual clusters:

```bash
pnpm exec figloom done-gate \
  --artifact .figma/artifacts/visual-verifications/login/visual-verification.json
```

Use `figloom status` to confirm resolved project root and token presence. Low-level `fetch-gold`, `run`, and `compare` commands exist for diagnosis; normal agent workflows use `verify` and `done-gate`.

## Library API

```ts
import {
  doneGateFromArtifact,
  verificationArtifactSchema,
  verificationRequestSchema,
  verify,
  writeVerificationArtifact,
} from "figloom-verify";
```

Visual pass remains mechanical evidence, not developer approval. Inspect `diff.png` and `topIssues` before handoff.
