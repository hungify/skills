#!/usr/bin/env node

import { loadJson } from "./_shared.mjs";

// A "bundle" binding maps several code props at once from one Figma group:
// valueProps is keyed by Figma value, each holding a {prop: codeValue} slice.
// Projected onto a single prop, it behaves like that prop's own valueMap.
function projectBundleValueMap(binding, prop) {
  const out = {};
  for (const [figmaVal, propValues] of Object.entries(binding.valueProps || {})) {
    if (propValues && Object.hasOwn(propValues, prop)) {
      out[figmaVal] = propValues[prop];
    }
  }
  return out;
}

function valueMapFor(entry) {
  if (entry.binding.mappingKind === "bundle") return projectBundleValueMap(entry.binding, entry.prop);
  return entry.binding.valueMap;
}

function keyCount(entry) {
  const vm = valueMapFor(entry);
  return vm ? Object.keys(vm).length : 0;
}

function contextScore(entry, allBindings) {
  const binding = entry.binding;
  const key = sourceKey(binding);
  return allBindings.filter((b) => b !== binding && sourceKey(b) === key).length;
}

function mergeValueMaps(entries) {
  const merged = {};
  let any = false;
  for (const entry of entries) {
    const vm = valueMapFor(entry);
    if (vm && Object.keys(vm).length > 0) {
      any = true;
      Object.assign(merged, vm);
    }
  }
  return any ? merged : undefined;
}

function bindingIdentity(binding) {
  return {
    componentPath: binding.componentPath,
    groupName: binding.groupName,
    propName: binding.propName,
    figmaNodeId: binding.figmaNodeId ?? null,
  };
}

function sourceKey(binding) {
  if (typeof binding.figmaNodeId === "string" && binding.figmaNodeId.length > 0) {
    return `node:${binding.figmaNodeId}`;
  }
  return `group:${binding.componentPath}\u0000${binding.groupName}`;
}

// sourceKey treats an empty-string figmaNodeId the same as missing (falls
// back to the group key), so candidate.nodeId must match that — `?? null`
// alone leaves "" untouched, which would silently defeat both the
// needsHumanReview guard below and the redundant-candidate filter.
function normalizeNodeId(binding) {
  const raw = binding.figmaNodeId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function dedup(entry) {
  const bindings = entry.figmaBindings || [];

  // "unsupported" (no code representation) and "static" (node has no property
  // definitions) both need a human-reviewed behavior-evidence case downstream —
  // neither has a `prop` to dedup against, so both are tracked here instead of
  // silently disappearing. "composition" is excluded: it's demonstrated inline
  // in the harness matrix (5b), not tracked as a separate evidence case.
  const NOTE_KINDS_REQUIRING_EVIDENCE = new Set(["unsupported", "static"]);
  const skippedUnsupported = bindings
    .filter((b) => NOTE_KINDS_REQUIRING_EVIDENCE.has(b.mappingKind))
    .map((b) => ({
      prop: b.prop ?? null,
      figmaNodeId: b.figmaNodeId,
      path: b.path,
      identity: bindingIdentity(b),
      note: b.note,
      mappingKind: b.mappingKind,
    }));

  // Each entry pairs a binding with the single prop it's being grouped under.
  // A "direct" binding produces exactly one entry; a "bundle" binding (one
  // Figma group assigning several code props at once) produces one entry per
  // prop in its `props[]`, all sharing the same underlying binding/node.
  const byProp = new Map();
  const pushEntry = (prop, binding) => {
    if (!byProp.has(prop)) byProp.set(prop, []);
    byProp.get(prop).push({ binding, prop });
  };
  for (const b of bindings) {
    if (NOTE_KINDS_REQUIRING_EVIDENCE.has(b.mappingKind)) continue;
    if (b.mappingKind === "bundle") {
      for (const prop of b.props || []) {
        if (typeof prop === "string" && prop.length > 0) pushEntry(prop, b);
      }
      continue;
    }
    if (typeof b.prop !== "string" || b.prop.length === 0) continue;
    pushEntry(b.prop, b);
  }

  const props = {};
  const needsHumanReview = [];

  for (const [prop, group] of byProp.entries()) {
    const distinctSourceKeys = [...new Set(group.map((entry) => sourceKey(entry.binding)))];

    if (distinctSourceKeys.length < 2) {
      props[prop] = {
        canonicalFigmaNodeId: group[0].binding.figmaNodeId ?? null,
        canonicalPath: group[0].binding.path,
        canonicalIdentity: bindingIdentity(group[0].binding),
        canonicalValueMap: mergeValueMaps(group),
        mappingKind: group[0].binding.mappingKind,
        redundant: [],
      };
      continue;
    }

    const byNode = new Map();
    for (const entry of group) {
      const key = sourceKey(entry.binding);
      if (!byNode.has(key)) byNode.set(key, []);
      byNode.get(key).push(entry);
    }

    let candidates = distinctSourceKeys.map((source) => {
      const entries = byNode.get(source);
      const merged = mergeValueMaps(entries);
      return {
        source,
        nodeId: normalizeNodeId(entries[0].binding),
        identity: bindingIdentity(entries[0].binding),
        entries,
        keyCount: merged ? Object.keys(merged).length : Math.max(...entries.map(keyCount)),
        mergedValueMap: merged,
      };
    });

    if (candidates.some((candidate) => candidate.nodeId === null)) {
      needsHumanReview.push({
        prop,
        reason:
          "2+ structured Figma groups share this prop but one group is missing figmaNodeId — " +
          "cannot safely choose a canonical visual source.",
        candidates: candidates.map((c) => ({
          figmaNodeId: c.nodeId,
          path: c.entries[0].binding.path,
          identity: c.identity,
          keyCount: c.keyCount,
        })),
      });
      continue;
    }

    const maxKeyCount = Math.max(...candidates.map((c) => c.keyCount));
    let top = candidates.filter((c) => c.keyCount === maxKeyCount);

    if (top.length > 1) {
      const scored = top.map((c) => ({
        ...c,
        score: Math.max(...c.entries.map((entry) => contextScore(entry, bindings))),
      }));
      const maxScore = Math.max(...scored.map((c) => c.score));
      top = scored.filter((c) => c.score === maxScore);
    }

    if (top.length > 1) {
      needsHumanReview.push({
        prop,
        reason:
          "2+ nodes share this prop, the same valueMap key count, and the same context score — " +
          "cannot auto-resolve a canonical (see step 5a, failed tiebreak case).",
        candidates: candidates.map((c) => ({
          figmaNodeId: c.nodeId,
          path: c.entries[0].binding.path,
          identity: c.identity,
          keyCount: c.keyCount,
        })),
      });
      // No canonical is emitted. Downstream coverage must not silently skip an
      // unresolved candidate by treating input order as a reviewed decision.
      continue;
    }

    const canonical = top[0];
    props[prop] = {
      canonicalFigmaNodeId: canonical.nodeId,
      canonicalPath: canonical.entries[0].binding.path,
      canonicalIdentity: canonical.identity,
      canonicalValueMap: canonical.mergedValueMap,
      mappingKind: canonical.entries[0].binding.mappingKind,
      redundant: candidates
        .filter((c) => c.source !== canonical.source)
        .map((c) => ({
          figmaNodeId: c.nodeId,
          path: c.entries[0].binding.path,
          identity: c.identity,
          coverageRole: "redundant-view",
        })),
    };
  }

  return { props, needsHumanReview, skippedUnsupported };
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node dedup_bindings.mjs <path-to-registry-entry.json>");
    process.exit(2);
  }
  const entry = loadJson(filePath);
  console.log(JSON.stringify(dedup(entry), null, 2));
}

main();
