# Visual verification contract

Store each independent run under:

```text
.figma/artifacts/visual-verifications/<target>/<run>/
  visual-contract.json
  visual-verification.json
  <contract-id>/
    figma-gold.png
    figma-gold.meta.json
    actual.png
    diff.png
    visual-score.json
    run-meta.json
    punch-list.json
```

`visual-contract.json` schema:

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
      "outDir": ".figma/artifacts/visual-verifications/login/run-1/login.desktop",
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

Region contract replaces `scope` with:

```json
{
  "kind": "region",
  "selector": "[data-testid='login-form']",
  "expectSize": { "width": 480, "height": 560 }
}
```

Region contract may set `profile` to `component/strict` or `component/dev`; final evidence must use `component/strict`. Optional capture fields: `scale`, `canvasFill`, `stabilitySamples` from 2–5, `timeoutMs` from 1000–120000, and `hideDevtoolsChrome`.

`visual-verification.json` is CLI-owned. Never hand-edit it. Consumers may store its repo-relative path and SHA-256 content hash, then rerun `figloom done-gate --artifact` before handoff.
