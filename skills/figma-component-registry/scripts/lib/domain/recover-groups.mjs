import { stripFigmaPropId } from './path-normalize.mjs';

function parseBindingPath(pathStr) {
  const parts = String(pathStr)
    .split('>')
    .map((segment) => segment.trim());
  if (parts.length >= 3) {
    return {
      componentPath: parts[0],
      groupName: parts[parts.length - 2],
      propName: parts[parts.length - 1],
    };
  }
  return {
    componentPath: parts[0] ?? '',
    groupName: parts[1] ?? parts[0] ?? '',
    propName: parts[parts.length - 1] ?? '',
  };
}

function resolveFigmaProp(propName, propertyDefinitions) {
  if (propertyDefinitions?.[propName]) return propName;
  const match = Object.keys(propertyDefinitions ?? {}).find(
    (key) => stripFigmaPropId(key) === propName,
  );
  return match ?? propName;
}

function bindingToMapping(binding, propertyDefinitions) {
  const { propName } = parseBindingPath(binding.path);
  const figmaProp = resolveFigmaProp(propName, propertyDefinitions);
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
  if (Array.isArray(entry.groups) && entry.groups.length > 0) {
    return entry.groups;
  }

  const groupsById = new Map();
  const defaultNodeId = entry.figma?.lastKnownNodeId ?? null;

  for (const binding of entry.figmaBindings ?? []) {
    const { groupName } = parseBindingPath(binding.path);
    const rawByName = raw?.components?.find((candidate) => candidate.name === groupName);
    const figmaNodeId =
      binding.figmaNodeId ?? rawByName?.figmaNodeId ?? defaultNodeId ?? groupName;
    const key = String(figmaNodeId);

    if (!groupsById.has(key)) {
      groupsById.set(key, {
        figmaNodeId,
        name: groupName,
        mappings: [],
      });
    }

    groupsById.get(key).mappings.push(
      bindingToMapping(binding, rawByName?.propertyDefinitions ?? {}),
    );
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
export { parseBindingPath, bindingToMapping, recoverGroupsFromRegistry, applyRenamedGroupNames, resolveFigmaProp };
