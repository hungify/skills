# Screen UI implementation contract

`screen-implementation.json` connects generated Figma evidence, UI component resolution, files scanned by gate, and visual comparisons. It supports developer review; it does not prove business-feature completion.

Source syntax is adapter-owned. `.figma/screen.config.json` selects framework, package manager, aliases, and screen glob. Missing config defaults to React/pnpm/`#/` → `src/`/`src/features/*/screens/*/`. v2 ships only React adapter; unsupported frameworks fail explicitly.

## Contents

- [Core shape](#core-shape)
- [Machine-enforced invariants](#machine-enforced-invariants)
- [Developer judgment](#developer-judgment)
- [UI-only boundary](#ui-only-boundary)
- [Gate](#gate)

## Core shape

```json
{
  "schemaVersion": 5,
  "name": "login",
  "target": { "kind": "screen", "route": "/login" },
  "source": {
    "fileKey": "...",
    "nodes": [{ "id": "desktop", "nodeId": "3:4" }]
  },
  "inventoryEvidence": {
    "filePath": ".figma/artifacts/screens/auth/login/figma-inventory.json",
    "contentHash": "sha256:..."
  },
  "detectedComponents": [
    {
      "sourceId": "desktop",
      "nodeId": "10:20",
      "name": "Text field",
      "kind": "design-system"
    }
  ],
  "ignoredInventoryNodes": [],
  "implementationFiles": [
    "src/features/auth/screens/login/login-screen.tsx",
    "src/features/auth/screens/login/components/login-form.tsx"
  ],
  "entryComponents": [
    {
      "componentName": "LoginScreen",
      "filePath": "src/features/auth/screens/login/login-screen.tsx",
      "role": "screen"
    }
  ],
  "resolved": [
    {
      "kind": "design-system",
      "figmaNodes": ["10:20"],
      "codeComponent": "TextField",
      "importPath": "#/components/ui/input",
      "decision": "reuse"
    }
  ],
  "unresolved": [],
  "screenCompositions": [
    {
      "componentName": "LoginForm",
      "filePath": "src/features/auth/screens/login/components/login-form.tsx",
      "reason": "Screen-only UI composition."
    }
  ],
  "assets": [],
  "visualContracts": [
    {
      "id": "desktop.region.login-card",
      "sourceId": "desktop",
      "sourceNodeId": "3:4",
      "goldNodeId": "5:6",
      "role": "primary",
      "scope": "region",
      "region": "login-card",
      "viewport": { "name": "desktop", "width": 1440, "height": 1024 },
      "outDir": ".figma/artifacts/screens/auth/login/desktop/regions/login-card",
      "profile": "component/strict",
      "selector": "[data-testid=\"auth.login\"]",
      "expectSize": { "width": 544, "height": 464 }
    }
  ]
}
```

## Machine-enforced invariants

- Inventory binds exact Figma file and requested nodes declared by screen artifact.
- Generated inventory is exhaustive: every reusable item appears once in detected or ignored inventory.
- Exact `.figma/layout-map.json` identity determines `layout`; all other reusable components default to `design-system`.
- Known design-system primitives cannot be ignored.
- Ignored nodes carry exact identity, concise reason, and icon/asset replacement where relevant.
- Every detected component is resolved exactly once; unresolved entries fail.
- Design-system resolutions require current validated prop maps and explicit adapter-recognized component props. React adapter rejects unresolved JSX spreads.
- `implementationFiles[]` lists UI files scanned for imports, usage, ownership, raw primitives, and prop translation. Developer reviews actual Git diff; list is not whole-repo change proof.
- `entryComponents[]` and `screenCompositions[]` own local adapter-recognized roots in scanned files.
- Every requested source has exactly one primary visual contract. Supplemental page contracts add chrome evidence.
- Page gold equals source node. Region gold must be visible descendant.
- Every declared visual contract must have complete, fresh, hash-bound fidelity evidence, engine `pass=true`, and no blocking residual cluster. Missing, mismatched, or quality-blocked evidence fails. Developer still reviews non-blocking residuals and crop usefulness.
- Unknown keys, duplicate identities, raw primitive substitutions, stale prop maps, adapter analysis failures, and missing files fail.

## Developer judgment

Gate does not decide whether one geometry-derived crop is product-correct. Developer reviews match percentage, gold, actual, diff, and non-blocking residuals for declared page/region evidence. Engine failure or a blocking residual cluster prevents gate completion.

File-level Figma revision drift is warning because unrelated file edits may change revision. Missing requested nodes remains hard failure. Current design-system property-definition drift remains hard failure.

## UI-only boundary

Contract describes presentation implementation. Logic integration points may be props/callbacks. API/auth/database/mutation/redirect/business-validation work is not implied.

## Gate

```bash
<package-manager> figma-gate:screen -- \
  --artifact .figma/artifacts/screens/<feature>/<screen>/screen-implementation.json
```

Passing means internal UI evidence consistency. Developer still reviews code, visual diff, and manually tests UI.
