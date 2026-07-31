import { stripFigmaPropId } from './path-normalize.mjs';

function resolveFigmaProp(propName, propertyDefinitions) {
  if (propertyDefinitions?.[propName]) return propName;
  const match = Object.keys(propertyDefinitions ?? {}).find(
    (key) => stripFigmaPropId(key) === propName,
  );
  return match ?? propName;
}

function bindingToMapping(binding, propertyDefinitions) {
  const figmaProp = resolveFigmaProp(binding.propName, propertyDefinitions);
  const mapping = {
    figmaProp,
    figmaType: binding.figmaType,
    mappingKind: binding.mappingKind,
  };

  if (binding.mappingKind === 'direct') {
    mapping.prop = binding.prop;
    if (binding.valueMap) mapping.valueMap = binding.valueMap;
  } else if (binding.mappingKind === 'bundle') {
    mapping.props = binding.props;
    mapping.valueProps = binding.valueProps;
  } else {
    mapping.note = binding.note;
  }

  return mapping;
}

function recoverGroupsFromRegistry(entry, raw) {
  if (entry.schemaVersion !== 3) {
    throw new Error(
      `registry entry for "${entry.component?.exportName ?? 'unknown'}" is schemaVersion ${entry.schemaVersion}, expected 3 — re-run fetch → finalize to regenerate it (no v2 → v3 auto-migration)`,
    );
  }

  const groupsById = new Map();
  const defaultNodeId = entry.figma?.lastKnownNodeId ?? null;

  for (const binding of entry.figmaBindings ?? []) {
    const rawByName = raw?.components?.find((candidate) => candidate.name === binding.groupName);
    const figmaNodeId =
      binding.figmaNodeId ?? rawByName?.figmaNodeId ?? defaultNodeId ?? binding.groupName;
    const key = String(figmaNodeId);

    if (!groupsById.has(key)) {
      groupsById.set(key, {
        figmaNodeId,
        name: binding.groupName,
        mappings: [],
      });
    }

    groupsById.get(key).mappings.push(bindingToMapping(binding, rawByName?.propertyDefinitions ?? {}));
  }

  return [...groupsById.values()];
}

function applyRenamedGroupNames(groups, definitions) {
  const byId = new Map(definitions.map((def) => [def.figmaNodeId, def]));
  return groups.map((group) => {
    const current = byId.get(group.figmaNodeId);
    if (current && current.name !== group.name) {
      return { ...group, name: current.name };
    }
    return group;
  });
}
export { bindingToMapping, recoverGroupsFromRegistry, applyRenamedGroupNames, resolveFigmaProp };
