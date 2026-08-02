#!/usr/bin/env node

import { loadJson } from "./_shared.mjs";

const FIGMA_TYPES = new Set(["VARIANT", "BOOLEAN", "INSTANCE_SWAP", "TEXT", "COMPONENT"]);
const NOTE_MAPPING_KINDS = new Set(["composition", "unsupported", "static"]);
const EXPORT_TYPES = new Set(["named", "default"]);
const ROOT_FIELDS = new Set(["schemaVersion", "component", "figma", "codePropsMap", "figmaBindings"]);
const COMPONENT_FIELDS = new Set(["exportName", "exportType", "filePath"]);
const FIGMA_FIELDS = new Set(["componentPath", "lastKnownFileKey", "lastKnownNodeId"]);
const CODE_PROP_FIELDS = new Set(["type", "values"]);
const BINDING_BASE_FIELDS = ["path", "componentPath", "groupName", "propName", "figmaType", "mappingKind", "figmaNodeId"];

const isString = (v) => typeof v === "string";
const isNonEmptyString = (v) => isString(v) && v.length > 0;
const isStringOrNull = (v) => v === null || isString(v);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function validate(entry) {
  const errors = [];
  const addError = (path, msg) => errors.push(`${path}: ${msg}`);

  if (!isPlainObject(entry)) {
    return [`<root>: expected an object, got ${entry === null ? "null" : typeof entry}`];
  }

  const rejectExtra = (value, allowed, fieldPath) => {
    if (!isPlainObject(value)) return;
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) addError(`${fieldPath}.${key}`, "unexpected property");
    }
  };

  rejectExtra(entry, ROOT_FIELDS, "<root>");

  if (entry.schemaVersion !== 3) {
    addError("schemaVersion", `expected literal 3, got ${JSON.stringify(entry.schemaVersion)}`);
  }

  if (!isPlainObject(entry.component)) {
    addError("component", "expected an object");
  } else {
    const c = entry.component;
    rejectExtra(c, COMPONENT_FIELDS, "component");
    if (!isNonEmptyString(c.exportName)) addError("component.exportName", "expected non-empty string");
    if (!EXPORT_TYPES.has(c.exportType)) {
      addError("component.exportType", `expected one of ${[...EXPORT_TYPES].join("|")}, got ${JSON.stringify(c.exportType)}`);
    }
    if (!isNonEmptyString(c.filePath)) addError("component.filePath", "expected non-empty string");
  }

  if (entry.figma !== null) {
    if (!isPlainObject(entry.figma)) {
      addError("figma", "expected an object or null");
    } else {
      const f = entry.figma;
      rejectExtra(f, FIGMA_FIELDS, "figma");
      if (!isNonEmptyString(f.componentPath)) addError("figma.componentPath", "expected non-empty string");
      if (f.lastKnownFileKey !== undefined && !isStringOrNull(f.lastKnownFileKey)) {
        addError("figma.lastKnownFileKey", "expected string or null when present");
      }
      if (f.lastKnownNodeId !== undefined && !isStringOrNull(f.lastKnownNodeId)) {
        addError("figma.lastKnownNodeId", "expected string or null when present");
      }
    }
  }

  if (!isPlainObject(entry.codePropsMap)) {
    addError("codePropsMap", "expected an object (record<string, {type, values?}>)");
  } else {
    for (const [key, val] of Object.entries(entry.codePropsMap)) {
      if (!isPlainObject(val)) {
        addError(`codePropsMap.${key}`, "expected an object");
        continue;
      }
      rejectExtra(val, CODE_PROP_FIELDS, `codePropsMap.${key}`);
      if (!isNonEmptyString(val.type)) addError(`codePropsMap.${key}.type`, "expected non-empty string");
      if (val.values !== undefined) {
        if (!Array.isArray(val.values) || !val.values.every(isString)) {
          addError(`codePropsMap.${key}.values`, "expected string[] when present");
        }
      }
    }
  }

  if (!Array.isArray(entry.figmaBindings)) {
    addError("figmaBindings", "expected an array");
  } else {
    entry.figmaBindings.forEach((b, i) => {
      const p = `figmaBindings[${i}]`;
      if (!isPlainObject(b)) {
        addError(p, "expected an object");
        return;
      }
      if (!isNonEmptyString(b.path)) addError(`${p}.path`, "expected non-empty string");
      if (!isNonEmptyString(b.componentPath)) addError(`${p}.componentPath`, "expected non-empty string");
      if (!isNonEmptyString(b.groupName)) addError(`${p}.groupName`, "expected non-empty string");
      if (!isNonEmptyString(b.propName)) addError(`${p}.propName`, "expected non-empty string");
      if (!FIGMA_TYPES.has(b.figmaType)) {
        addError(`${p}.figmaType`, `expected one of ${[...FIGMA_TYPES].join("|")}, got ${JSON.stringify(b.figmaType)}`);
      }
      // figmaNodeId is optional/nullable on every mappingKind (registry skill omits it
      // entirely, or writes null, when a group has no resolved Figma node).
      if (b.figmaNodeId !== undefined && !isStringOrNull(b.figmaNodeId)) {
        addError(`${p}.figmaNodeId`, "expected string or null when present");
      }

      if (b.mappingKind === "direct") {
        rejectExtra(b, new Set([...BINDING_BASE_FIELDS, "prop", "valueMap"]), p);
        if (!isNonEmptyString(b.prop)) addError(`${p}.prop`, 'expected non-empty string for mappingKind "direct"');
        // valueMap values are not constrained to strings upstream (BOOLEAN figmaType can
        // map to non-string code values) — only shape-check the container.
        if (b.valueMap !== undefined && !isPlainObject(b.valueMap)) {
          addError(`${p}.valueMap`, "expected an object when present");
        }
      } else if (b.mappingKind === "bundle") {
        rejectExtra(b, new Set([...BINDING_BASE_FIELDS, "props", "valueProps"]), p);
        if (!Array.isArray(b.props) || b.props.length === 0 || !b.props.every(isNonEmptyString)) {
          addError(`${p}.props`, 'expected non-empty string[] for mappingKind "bundle"');
        }
        if (!isPlainObject(b.valueProps) || Object.keys(b.valueProps).length === 0) {
          addError(`${p}.valueProps`, 'expected non-empty object for mappingKind "bundle"');
        } else {
          for (const [figmaValue, propValues] of Object.entries(b.valueProps)) {
            if (!isPlainObject(propValues)) {
              addError(`${p}.valueProps.${figmaValue}`, "expected an object");
            }
          }
        }
      } else if (NOTE_MAPPING_KINDS.has(b.mappingKind)) {
        rejectExtra(b, new Set([...BINDING_BASE_FIELDS, "note"]), p);
        if (!isNonEmptyString(b.note)) {
          addError(`${p}.note`, `expected non-empty string for mappingKind "${b.mappingKind}"`);
        }
      } else {
        addError(
          `${p}.mappingKind`,
          `expected one of direct|bundle|${[...NOTE_MAPPING_KINDS].join("|")}, got ${JSON.stringify(b.mappingKind)}`
        );
      }
    });
  }

  return errors;
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node validate_registry_entry.mjs <path-to-registry-entry.json>");
    process.exit(2);
  }

  const entry = loadJson(filePath);
  const errors = validate(entry);
  if (errors.length > 0) {
    console.error(`REGISTRY ENTRY FAILED VALIDATION (${errors.length} error(s)):`);
    for (const err of errors) console.error(`  - ${err}`);
    console.error(
      "\nPer SKILL.md's error path: STOP the workflow here, do NOT continue " +
        "to step 5 with empty or assumed data."
    );
    process.exit(1);
  }

  console.log("OK — registry entry passed validation (schemaVersion 3).");
  process.exit(0);
}

main();
