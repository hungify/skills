import { bindingPath, stripFigmaPropId } from './path-normalize.mjs';

function mapKind(kind) {
  if (kind === 'override') return 'bundle';
  if (kind === 'unmapped') return 'unsupported';
  if (kind === 'structural') return 'static';
  return kind;
}

function propsFromValueOverrides(valueOverrides) {
  const names = new Set();
  for (const overrides of Object.values(valueOverrides ?? {})) {
    for (const prop of Object.keys(overrides ?? {})) {
      names.add(prop);
    }
  }
  return [...names];
}

function flattenMapping({ componentPath, groupName, groupFigmaNodeId, mapping }) {
  const mappingKind = mapKind(mapping.mappingKind);
  const base = {
    path: bindingPath({ componentPath, groupName, figmaProp: mapping.figmaProp }),
    componentPath,
    groupName,
    propName: stripFigmaPropId(mapping.figmaProp),
    figmaType: mapping.figmaType,
    mappingKind,
  };
  if (groupFigmaNodeId != null) {
    base.figmaNodeId = groupFigmaNodeId;
  }

  if (mappingKind === 'direct') {
    const binding = { ...base, prop: mapping.prop ?? mapping.reactProp };
    if (mapping.valueMap) binding.valueMap = mapping.valueMap;
    return binding;
  }

  if (mappingKind === 'bundle') {
    const valueProps = mapping.valueProps ?? mapping.valueOverrides;
    const props = mapping.props ?? propsFromValueOverrides(valueProps);
    return { ...base, props, valueProps };
  }

  return { ...base, note: mapping.note };
}

function flattenGroupsToBindings({ componentPath, groups }) {
  const bindings = [];
  for (const group of groups ?? []) {
    for (const mapping of group.mappings ?? []) {
      bindings.push(
        flattenMapping({
          componentPath,
          groupName: group.name,
          groupFigmaNodeId: group.figmaNodeId,
          mapping,
        }),
      );
    }
  }
  return bindings;
}
export { flattenGroupsToBindings, mapKind };
