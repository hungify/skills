# Visual verification contract

Store each independent run under:

```text
.figloom/artifacts/visual-verifications/<target>/<run>/
  visual-contract.json
  visual-verification.json
  <contract-id>/
    figma-gold.png            # figma baseline only
    figma-gold.meta.json      # figma baseline only
    web-baseline.png          # web baseline only
    web-baseline.meta.json    # web baseline only
    actual.png
    diff.png
    visual-score.json
    run-meta.json
    punch-list.json
```

Baseline evidence file names depend on `baseline.kind` — the CLI picks the pair, do not hand-name them.

`visual-contract.json` schema (Figma baseline, page scope) — this is also the full worked Figma-vs-web example, copy it directly:

```json
{
  "schemaVersion": 4,
  "target": { "kind": "web", "url": "http://127.0.0.1:3000/login" },
  "contracts": [
    {
      "id": "login.desktop",
      "baseline": {
        "kind": "figma",
        "fileKey": "abc123",
        "nodeId": "153:5181"
      },
      "viewport": { "name": "desktop", "width": 1440, "height": 1024 },
      "outDir": ".figloom/artifacts/visual-verifications/login/run-1/login.desktop",
      "scope": {
        "kind": "page",
        "pageReason": "Supplied node represents complete login screen."
      },
      "stabilitySamples": 3,
      "timeoutMs": 30000
    }
  ]
}
```

Web baseline replaces `baseline` with:

```json
{
  "kind": "web",
  "url": "https://staging.example.com/login",
  "revision": "2026-07-30-approved-by-design"
}
```

`revision` must identify the exact known-good state (deploy tag, commit SHA, or explicit approval label) — never a placeholder. Use a web baseline to compare against a previously approved deploy, a staging environment, or any non-Figma reference state.

Region contract replaces `scope` with:

```json
{
  "kind": "region",
  "selector": "[data-testid='login-form']",
  "expectSize": { "width": 480, "height": 560 }
}
```

Region contract may set `profile` to `component/strict` or `component/dev`; final evidence must use `component/strict`. `page` scope contracts must omit `profile` entirely — the schema rejects the request if `profile` is set alongside `"kind": "page"`.

Optional capture fields: `stabilitySamples`, `timeoutMs`, `hideDevtoolsChrome`, `devtoolsMarker` (requires `hideDevtoolsChrome: true`), and `maskSelectors` — an array of CSS selectors (max 10) to blank out before comparison, for dynamic content like timestamps or ads. `maskSelectors` is valid only when `baseline.kind` is `"web"`; the schema rejects it on a `figma` baseline.

Full worked web-vs-web example (current vs previously approved deploy): [web-regression.contract.json](examples/web-regression.contract.json). The Figma-vs-web schema block above is itself the full worked example for that case — no separate copy is kept, to avoid two files silently drifting apart.

This reference is audited against `figloom-verify@0.0.3`. Do not invent fields outside this contract. Update the reference together with the pinned release when adopting a newer CLI contract.

`visual-verification.json` is CLI-owned. Never hand-edit it. Consumers may store its repo-relative path and SHA-256 content hash, then rerun `npx --yes figloom-verify@0.0.3 done-gate --artifact <path>` before handoff.
