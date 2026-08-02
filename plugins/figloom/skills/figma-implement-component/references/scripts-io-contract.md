# Input/output contract between the step-5 scripts

The scripts in `scripts/` chain together via JSON on stdout/file. All of them
run with plain `node`, Node >= 18, no install step needed — except
`coverage_check.mjs`, which depends on `@babel/parser`/`@babel/types` and
ships pre-bundled with those inlined (see `scripts/sync-figloom.mjs`).

```
registry-entry.json -> dedup_bindings.mjs -> dedup-output.json
                                              |
testids + harness ----------------------------+-> coverage_check.mjs
                                                    |
                                                    v
coverage-output.json + Figloom verification artifacts
                                  -> validate_figloom_evidence.mjs
                                                    |
                                                    v
                                      figloom-evidence.json
                                                    |
dedup-output.json + coverage-output.json -----------+-> generate_gate_artifact.mjs
                                                    |
                                                    v
                              <name>.implementation.json (schemaVersion 3)
```

## `dedup_bindings.mjs` output

```jsonc
{
  "props": {
    "<propName>": {
      "canonicalFigmaNodeId": "string|null", // null when the sole source binding has no resolved Figma node (e.g. an unresolved bundle)
      "canonicalPath": "string",
      "canonicalIdentity": {
        "componentPath": "string",
        "groupName": "string",
        "propName": "string",
        "figmaNodeId": "string|null"
      },
      "canonicalValueMap": { "FigmaValue": "codeValue" }, // absent if the source binding has no valueMap (identity case)
      "mappingKind": "direct | bundle", // composition/unsupported/static bindings never reach props[] — see skippedUnsupported below
      "redundant": [
        { "figmaNodeId": "string", "path": "string", "coverageRole": "redundant-view" }
      ],
      // A prop whose tiebreak failed does NOT appear in props; it only appears in needsHumanReview[]
    }
  },
  "needsHumanReview": [
    {
      "prop": "string",
      "reason": "string",
      "candidates": [
        {
          "figmaNodeId": "string|null",
          "path": "string",
          "identity": { "componentPath": "string", "groupName": "string", "propName": "string", "figmaNodeId": "string|null" },
          "keyCount": 0
        }
      ]
    }
  ],
  "skippedUnsupported": [
    { "prop": "string|null", "figmaNodeId": "string|null", "path": "string", "identity": {}, "note": "string", "mappingKind": "unsupported | static" }
  ]
}
```

`props` contains **every** prop with a valid binding (including props that
have no duplicated node at all — `redundant: []`). `generate_gate_artifact.mjs`
filters this itself, only putting props with `redundant.length > 0` into the
gate artifact's `dedup[]` (per the schema, section 3 — the gate artifact's
`dedup[]` only lists cases that are actually duplicated, not every prop).

## `coverage_check.mjs` output

```jsonc
{
  "direction": "figma-to-code",
  "visualGaps": ["string", "..."],
  "needsHumanReview": [ /* copied verbatim from dedup-output.json */ ],
  "notes": ["string", "..."], // must be empty before the gate generator runs
  "expectedTestids": ["button-size-sm", "..."],
  "expectedCases": [
    { "testid": "button-size-sm", "identity": {} }
  ],
  "harnessVerified": true,
  "inputs": {
    "registryPath": "string",
    "dedupPath": "string",
    "testidsFilePath": "string",
    "harnessFilePath": "string"
  }
}
```

A non-empty `notes` blocks gate generation; `visualGaps` are kept in the
gate and block the `done` state. `expectedTestids` determines the exact
`--total-states`; `harnessVerified` is only true once the harness exists
and has been proven to consume the entire testids constant. Coverage with a
gap still prints JSON to stdout but exits 1.

`expectedCases.identity` is the binding identity for coverage, not the exact
visual-state node. The exact `fileKey`, state `nodeId`, and `expectSize` live
directly in the Figloom schema-v4 contracts at step 5d.

## When `--figma-options` is needed

Only needed when a prop has NO `valueMap` in the source binding (identity
mapping, e.g. `color` in the real Button case). Get the list of original
Figma options (original casing, not lowercased) from the metadata already
fetched in step 2 — if the agent no longer holds that data in context,
re-fetch Figma metadata for the correct component before running
`coverage_check.mjs`, rather than skipping the verification step. The file
must follow `figma-options.schema.json`; look up by the full structured
identity, not a flat code-prop key.

## Registry freshness evidence

`verify_registry_freshness.mjs` runs a scoped `check` then a live
`verify-source`. The wrapper derives the canonical registry path from
`registryRoot/sourceRoot/component.filePath`, passes the same roots into
the CLI, and rejects an arbitrary copy. Only when both exit 0 does the
script write schema v1 with the actual registry path/roots/hash, export
name, timestamp, command, and stdout summary. The gate generator re-hashes
the entry and rejects stale evidence or evidence pointing at the wrong file.

## Behavior evidence

Each item in `dedup.skippedUnsupported[]` needs exactly 1 case in the schema
v1 file: `bindingIdentity` (`componentPath/groupName/propName/figmaNodeId`)
as the key, `bindingPath` for display only, `kind`
(`interaction|a11y|visual-state|not-applicable`), `status`
(`passed|waived`), `evidence`. For `passed`, `evidence` is a path to a
report/harness/test that exists in the repo. For `waived`, only
`not-applicable` is valid and `evidence` holds the reason. Extra or missing
cases both fail the gate.

## Figloom evidence manifest

The input manifest only lists `verificationArtifactPath` per batch.
`validate_figloom_evidence.mjs` maps `coverage.expectedTestids[]` 1:1 onto
schema-v4 Figma region contracts, enforces `component/strict`, batch <= 8,
then calls the official `figloom done-gate`. The schema-v1 output keeps the
package pin, coverage path/hash, and `artifacts[]` with verification
path/hash.

Baseline/actual/diff/score are not flattened into the gate. The Figloom
verification artifact and done-gate continue to own runtime evidence,
stability, thresholds, hashes, and freshness. `generate_gate_artifact.mjs`
only re-hashes the evidence manifest references and rejects a
missing/stale artifact.

A component with no `expectedTestids` at all (every binding is
composition/unsupported/static — no prop needs a visual matrix):
`--manifest` must NOT be passed, the script writes output directly with
`artifacts: []`. `generate_gate_artifact.mjs` accepts an empty
`figloomEvidence: []` only in this case (`harness.totalStates == 0`, see
the `allOf` in `gate-artifact.schema.json`); otherwise `--manifest` is
required and `artifacts[]` must match all of `expectedTestids` 1:1.
