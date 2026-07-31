# Registry schema v3

Only schema v3 is accepted. The agent writes `_figma-props-matched.json`; `finalize` validates it and upserts `registry/<area>/<ExportName>.json`.

Durable entries use flattened `figmaBindings[]` (not nested `groups[]`). Matched cycle artifacts use grouped `mappings[]` with raw `figmaProp` keys.

## Durable registry entry (all five mapping kinds)

Path on disk: `registry/ui/Checkbox.json` (derived from `component.filePath` + `exportName`).

```json
{
  "schemaVersion": 3,
  "component": {
    "exportName": "Checkbox",
    "exportType": "named",
    "filePath": "src/components/ui/checkbox.tsx"
  },
  "figma": {
    "componentPath": "Checkbox",
    "lastKnownFileKey": "abc123",
    "lastKnownNodeId": "28:518"
  },
  "codePropsMap": {
    "checked": { "type": "boolean" },
    "indeterminate": { "type": "boolean" },
    "size": { "type": "enum", "values": ["sm", "md"] }
  },
  "figmaBindings": [
    {
      "path": "Checkbox > Checkbox > Size",
      "componentPath": "Checkbox",
      "groupName": "Checkbox",
      "propName": "Size",
      "figmaType": "VARIANT",
      "mappingKind": "direct",
      "figmaNodeId": "28:518",
      "prop": "size",
      "valueMap": { "Small": "sm", "Regular": "md" }
    },
    {
      "path": "Checkbox > Checkbox > Checked?",
      "componentPath": "Checkbox",
      "groupName": "Checkbox",
      "propName": "Checked?",
      "figmaType": "VARIANT",
      "mappingKind": "bundle",
      "figmaNodeId": "28:518",
      "props": ["checked", "indeterminate"],
      "valueProps": {
        "True": { "checked": true, "indeterminate": false },
        "Indeterminate": { "checked": false, "indeterminate": true },
        "False": { "checked": false, "indeterminate": false }
      }
    },
    {
      "path": "Checkbox > Checkbox > Show prepend",
      "componentPath": "Checkbox",
      "groupName": "Checkbox",
      "propName": "Show prepend",
      "figmaType": "BOOLEAN",
      "mappingKind": "composition",
      "figmaNodeId": "28:518",
      "note": "No visibility toggle prop; presence is implicit from whether an icon child is passed."
    },
    {
      "path": "Checkbox > Checkbox > Legacy axis",
      "componentPath": "Checkbox",
      "groupName": "Checkbox",
      "propName": "Legacy axis",
      "figmaType": "VARIANT",
      "mappingKind": "unsupported",
      "figmaNodeId": "28:518",
      "note": "Figma variant exists but code API has no corresponding prop."
    },
    {
      "path": "Checkbox > Checkbox SP > __no_properties__",
      "componentPath": "Checkbox",
      "groupName": "Checkbox SP",
      "propName": "__no_properties__",
      "figmaType": "COMPONENT",
      "mappingKind": "static",
      "figmaNodeId": "99:1",
      "note": "Dedicated SP-only frame with no variant axis; maps to same Checkbox export."
    }
  ]
}
```

`componentPath` (the export name a binding belongs to), `groupName` (the owning Figma group/component-set name), and `propName` (the Figma property key with any `#digit:digit` suffix stripped) are the structured source of truth for a binding's identity — `recoverGroupsFromRegistry`, merge, and drift logic key off these fields, plus `figmaNodeId` when present. `path` is only `${componentPath} > ${groupName} > ${propName}` joined for human readability; no code parses it back apart, so a component, group, or property name that itself contains `>` is safe and does not break anything.

`codePropsMap` is binding-scoped, not a dump of the complete framework component API.
Its keys are exactly the unique props referenced by `direct.prop` and
`bundle.props[]` in `figmaBindings`. Shared `code-props-cache.json` retains compact
normalized public props. Adapters omit only confirmed event callbacks, framework
globals, and framework-internal `key` / `ref`; inherited, ARIA, composition, and unknown
props remain available for initial semantic matching. No per-cycle `_code-props-raw.json`
exists. Changes to unbound props do not make a registry entry stale.

Note: durable `path` values strip `#529:0`-style suffixes from Figma prop keys. The matched artifact below keeps raw keys.

`figmaNodeId` on bindings is optional but recommended when multiple Figma groups compose one code export — it enables `recoverGroupsFromRegistry` and `verify-source` to disambiguate groups.

## Matched cycle artifact

Agent-authored; lives at `.figma/cache/<task-id>/_figma-props-matched.json`.

```json
{
  "schemaVersion": 2,
  "fileKey": "abc123",
  "components": [
    {
      "codeComponent": "Checkbox",
      "codeFile": "src/components/ui/checkbox.tsx",
      "groups": [
        {
          "figmaNodeId": "28:518",
          "name": "Checkbox",
          "mappings": [
            {
              "figmaProp": "Size",
              "figmaType": "VARIANT",
              "mappingKind": "direct",
              "prop": "size",
              "valueMap": { "Small": "sm", "Regular": "md" }
            },
            {
              "figmaProp": "Checked?",
              "figmaType": "VARIANT",
              "mappingKind": "bundle",
              "props": ["checked", "indeterminate"],
              "valueProps": {
                "True": { "checked": true, "indeterminate": false },
                "Indeterminate": { "checked": false, "indeterminate": true },
                "False": { "checked": false, "indeterminate": false }
              }
            },
            {
              "figmaProp": "Show prepend#529:0",
              "figmaType": "BOOLEAN",
              "mappingKind": "composition",
              "note": "No visibility toggle prop; presence is implicit from whether an icon child is passed."
            },
            {
              "figmaProp": "Legacy axis",
              "figmaType": "VARIANT",
              "mappingKind": "unsupported",
              "note": "Figma variant exists but code API has no corresponding prop."
            }
          ]
        },
        {
          "figmaNodeId": "99:1",
          "name": "Checkbox SP",
          "mappings": [
            {
              "figmaProp": "__no_properties__",
              "figmaType": "COMPONENT",
              "mappingKind": "static",
              "note": "Dedicated SP-only frame with no variant axis."
            }
          ]
        }
      ]
    }
  ]
}
```

Mappings belong to a Figma group. The same property name in two component sets therefore remains two independently reviewable mappings. Every fetched `propertyDefinitions` key must appear exactly once in its group's `mappings[]`; omission is invalid even when remaining mappings are valid.

## Mapping contract

| `mappingKind` | Required | Meaning |
| --- | --- | --- |
| `direct` | `prop`; full `valueMap` when labels differ | One Figma property → one code prop |
| `bundle` | `props`, `valueProps` | One Figma value → partial prop object |
| `composition` | `note`; no `prop` | Children, slots, icons, parent composition |
| `unsupported` | `note`; no `prop` | Unsupported by current code API |
| `static` | `note`; no `prop` | Zero Figma properties; node↔code correspondence only |

`null` values in `valueMap` or inside `valueProps` objects mean omit that code prop.

For `direct`, omit `valueMap` when enumerable Figma labels equal extracted code values
case-insensitively, or when a Figma `BOOLEAN` maps to an extracted boolean
(`False`/`True` coerced to `false`/`true`). Identity and case-only maps are rejected as
redundant. If sets differ semantically or code domain is unknown, provide complete
`valueMap`.

`composition`, `unsupported`, and `static` always require a concise `note`. They fail semantic validation when a normalized Figma property name exactly matches a locally extracted code prop with known type.

## Ambiguous `exportName` across areas

`verify-source --components <ExportName,...>` resolves each requested export by scanning every `registry/<area>/*.json` file and matching on `component.exportName`, not on file path (`check --components` instead derives the registry path directly from each extracted source file, so it never hits this scan). If two or more registry files across different areas share the same `exportName` — e.g. `registry/ui/Button.json` and `registry/marketing/Button.json` both have `"exportName": "Button"` — the lookup fails loud instead of silently picking one: it throws an error listing every matching relative path, for example `ambiguous exportName "Button" matches 2 registry files: marketing/Button.json, ui/Button.json — disambiguate with a full registry path`.

## Finalize rejects

- a matched-artifact `schemaVersion` other than 2 (the matched cycle artifact schema is unchanged; only the durable registry entry schema moved to v3);
- missing/unknown fields, mapping kinds, code props, or Figma properties;
- Figma property type drift;
- incomplete or extra Figma value coverage;
- values outside an extracted union/CVA API;
- duplicate `figmaProp` inside one group;
- omitted fetched Figma properties;
- duplicate `codeComponent` outputs that would overwrite the same registry filename;
- carried-forward group missing from live Figma;
- `--prune` flag (explicitly unsupported).
