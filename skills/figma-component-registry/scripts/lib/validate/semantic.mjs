const VALID_MAPPING_KIND = new Set([
  'direct',
  'bundle',
  'composition',
  'unsupported',
  'static',
]);

const NOTE_ONLY_MAPPING_KINDS = new Set(['composition', 'unsupported', 'static']);

const ALLOWED_MATCHED_FIELDS = new Set(['schemaVersion', 'fileKey', 'components']);
const ALLOWED_COMPONENT_FIELDS = new Set(['codeComponent', 'codeFile', 'groups']);
const ALLOWED_GROUP_FIELDS = new Set(['figmaNodeId', 'name', 'mappings']);
const ALLOWED_MAPPING_FIELDS = new Set([
  'figmaProp',
  'figmaType',
  'mappingKind',
  'prop',
  'valueMap',
  'props',
  'valueProps',
  'note',
]);

function findRawComponent(raw, figmaNodeId, figmaName) {
  if (figmaNodeId) {
    return raw.components?.find((candidate) => candidate.figmaNodeId === figmaNodeId);
  }
  return raw.components?.find((candidate) => candidate.name === figmaName);
}

function findCodeComponent(codeRaw, componentName, codeFile) {
  const direct = codeRaw.components?.[componentName];
  if (direct && (!codeFile || direct.file === codeFile)) return direct;
  const keys = codeRaw.componentIndex?.[componentName] ?? [];
  return keys
    .map((key) => codeRaw.components?.[key])
    .find((candidate) => candidate && (!codeFile || candidate.file === codeFile));
}

function figmaValuesForRawProp(rawProp) {
  if (rawProp?.type === 'BOOLEAN') return ['False', 'True'];
  return rawProp?.variantOptions ?? rawProp?.preferredValues?.map((value) => value.key) ?? [];
}

function sameValue(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function normalizedPropName(value) {
  return String(value ?? '')
    .replace(/#\d+:\d+$/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

function exactCodePropCandidates(figmaProp, codeComponent) {
  const normalized = normalizedPropName(figmaProp);
  if (!normalized) return [];
  return Object.entries(codeComponent?.props ?? {})
    .filter(
      ([prop, codeProp]) =>
        normalizedPropName(prop) === normalized &&
        codeProp?.source !== 'external-type' &&
        codeProp?.type !== 'unknown',
    )
    .map(([prop]) => prop);
}

function validateValueCoverage(problems, context, mapping, rawProp) {
  const figmaValues = figmaValuesForRawProp(rawProp);
  if (figmaValues.length === 0) return;
  const map = mapping.mappingKind === 'bundle' ? mapping.valueProps : mapping.valueMap;
  if (!map) return;
  const keys = Object.keys(map);
  const missing = figmaValues.filter((value) => !keys.some((key) => sameValue(key, value)));
  const extra = keys.filter((key) => !figmaValues.some((value) => sameValue(key, value)));
  if (missing.length > 0) problems.push(`${context}: missing Figma values [${missing.join(', ')}]`);
  if (extra.length > 0) problems.push(`${context}: unknown Figma values [${extra.join(', ')}]`);
}

function valueMapIsRedundant(valueMap) {
  const entries = Object.entries(valueMap ?? {});
  return (
    entries.length > 0 &&
    entries.every(([figmaValue, codeValue]) => sameValue(figmaValue, codeValue))
  );
}

function mappingCodeProps(mapping) {
  if (mapping.mappingKind === 'direct') return mapping.prop ? [mapping.prop] : [];
  if (mapping.mappingKind !== 'bundle') return [];
  return [
    ...new Set(
      Object.values(mapping.valueProps ?? {}).flatMap((valueProp) => Object.keys(valueProp ?? {})),
    ),
  ];
}

function validateAssignedValue(problems, context, codeProp, value) {
  if (value === null || value === undefined || !codeProp) return;
  const codeValues = codeProp.values?.map(String) ?? [];
  if (codeValues.length > 0 && !codeValues.some((candidate) => sameValue(candidate, value))) {
    problems.push(`${context}: value "${value}" not in code values [${codeValues.join(', ')}]`);
  }
  if (codeProp.type === 'boolean' && typeof value !== 'boolean') {
    problems.push(`${context}: value "${value}" must be boolean`);
  }
}

function validateMapping(problems, context, mapping, rawProp, codeComponent) {
  for (const key of Object.keys(mapping)) {
    if (!ALLOWED_MAPPING_FIELDS.has(key)) problems.push(`${context}: unknown field "${key}"`);
  }
  for (const field of ['figmaProp', 'figmaType', 'mappingKind']) {
    if (!(field in mapping)) problems.push(`${context}: missing "${field}"`);
  }
  if (!VALID_MAPPING_KIND.has(mapping.mappingKind)) {
    problems.push(`${context}: bad mappingKind "${mapping.mappingKind}"`);
    return;
  }
  if (mapping.mappingKind !== 'static') {
    if (!rawProp) {
      problems.push(`${context}: missing Figma property in fetched raw data`);
    } else if (mapping.figmaType !== rawProp.type) {
      problems.push(
        `${context}: figmaType "${mapping.figmaType}" does not match Figma "${rawProp.type}"`,
      );
    }
  }
  if (mapping.mappingKind === 'direct' && !mapping.prop) {
    problems.push(`${context}: direct needs prop`);
  }
  if (mapping.mappingKind === 'direct' && mapping.valueProps) {
    problems.push(`${context}: direct must not set valueProps`);
  }
  if (mapping.mappingKind === 'bundle' && !mapping.valueProps) {
    problems.push(`${context}: bundle needs valueProps`);
  }
  if (mapping.mappingKind === 'bundle' && (mapping.prop || mapping.valueMap)) {
    problems.push(`${context}: bundle must not set prop/valueMap`);
  }
  if (NOTE_ONLY_MAPPING_KINDS.has(mapping.mappingKind) && !mapping.note) {
    problems.push(`${context}: ${mapping.mappingKind} needs note`);
  }
  if (NOTE_ONLY_MAPPING_KINDS.has(mapping.mappingKind) && mapping.prop) {
    problems.push(`${context}: ${mapping.mappingKind} must not set prop`);
  }
  if (
    NOTE_ONLY_MAPPING_KINDS.has(mapping.mappingKind) &&
    (mapping.valueMap || mapping.valueProps)
  ) {
    problems.push(`${context}: ${mapping.mappingKind} must not set values`);
  }
  if (mapping.mappingKind === 'composition' || mapping.mappingKind === 'unsupported') {
    const exactCandidates = exactCodePropCandidates(mapping.figmaProp, codeComponent);
    if (exactCandidates.length > 0) {
      problems.push(
        `${context}: ${mapping.mappingKind} rejected because exact code prop candidate exists [${exactCandidates.join(', ')}]; use direct/bundle or rename the Figma property`,
      );
    }
  }
  validateValueCoverage(problems, context, mapping, rawProp);
  if (mapping.mappingKind === 'direct' && valueMapIsRedundant(mapping.valueMap)) {
    problems.push(`${context}: redundant valueMap; Figma and code values already match`);
  }

  if (mapping.mappingKind === 'direct' && !mapping.valueMap && rawProp) {
    const figmaValues = figmaValuesForRawProp(rawProp);
    const codeProp = codeComponent?.props?.[mapping.prop];
    const codeValues = codeProp?.values?.map(String) ?? [];
    if (figmaValues.length > 0) {
      const implicitBooleanMapping = rawProp.type === 'BOOLEAN' && codeProp?.type === 'boolean';
      if (!implicitBooleanMapping && codeValues.length === 0) {
        problems.push(
          `${context}: direct enumerable mapping cannot prove code values; full valueMap required (Figma [${figmaValues.join(', ')}])`,
        );
      } else if (
        !implicitBooleanMapping &&
        (figmaValues.length !== codeValues.length ||
          figmaValues.some((value) => !codeValues.some((candidate) => sameValue(candidate, value))))
      ) {
        problems.push(
          `${context}: direct Figma/code values differ; full valueMap required (Figma [${figmaValues.join(', ')}], code [${codeValues.join(', ')}])`,
        );
      }
    }
  }

  for (const prop of mappingCodeProps(mapping)) {
    const codeProp = codeComponent?.props?.[prop];
    if (!codeProp) problems.push(`${context}: prop "${prop}" missing from code API`);
  }
  if (mapping.mappingKind === 'direct' && mapping.valueMap) {
    const codeProp = codeComponent?.props?.[mapping.prop];
    for (const [figmaValue, value] of Object.entries(mapping.valueMap)) {
      validateAssignedValue(problems, `${context}.${figmaValue}`, codeProp, value);
    }
  }
  if (mapping.mappingKind === 'bundle') {
    for (const [figmaValue, valueProps] of Object.entries(mapping.valueProps ?? {})) {
      for (const [prop, value] of Object.entries(valueProps ?? {})) {
        validateAssignedValue(
          problems,
          `${context}.${figmaValue}.${prop}`,
          codeComponent?.props?.[prop],
          value,
        );
      }
    }
  }
}

function validateMatchedSemantic(matched, raw, codeRaw) {
  const problems = [];
  for (const key of Object.keys(matched)) {
    if (!ALLOWED_MATCHED_FIELDS.has(key)) problems.push(`matched: unknown field "${key}"`);
  }
  if (matched.schemaVersion !== 2) problems.push('matched.schemaVersion must be 2');
  if (matched.fileKey !== raw.fileKey)
    problems.push('matched.fileKey must match fetched raw fileKey');
  if (!Array.isArray(matched.components)) {
    problems.push('matched.components must be an array');
    return problems;
  }
  const seenComponents = new Set();
  const seenComponentNames = new Set();
  for (const component of matched.components) {
    const context = component.codeComponent ?? 'unknown-component';
    for (const key of Object.keys(component)) {
      if (!ALLOWED_COMPONENT_FIELDS.has(key)) problems.push(`${context}: unknown field "${key}"`);
    }
    if (!component.codeComponent || !component.codeFile) {
      problems.push(`${context}: codeComponent + codeFile required`);
      continue;
    }
    const componentKey = `${component.codeComponent}::${component.codeFile}`;
    if (seenComponents.has(componentKey))
      problems.push(`${context}: duplicate component/file entry`);
    seenComponents.add(componentKey);
    if (seenComponentNames.has(component.codeComponent)) {
      problems.push(
        `${context}: duplicate codeComponent would overwrite ${component.codeComponent}.json`,
      );
    }
    seenComponentNames.add(component.codeComponent);
    const codeComponent = findCodeComponent(codeRaw, component.codeComponent, component.codeFile);
    if (!codeComponent) {
      problems.push(`${context}: component/file missing from extracted code API`);
      continue;
    }
    if (!Array.isArray(component.groups) || component.groups.length === 0) {
      problems.push(`${context}: groups[] required`);
      continue;
    }
    const seenGroups = new Set();
    const seenNodeIds = new Set();
    for (const group of component.groups) {
      const groupContext = `${context}.${group.name ?? group.figmaNodeId ?? 'unknown-group'}`;
      for (const key of Object.keys(group)) {
        if (!ALLOWED_GROUP_FIELDS.has(key))
          problems.push(`${groupContext}: unknown field "${key}"`);
      }
      if (!group.figmaNodeId || !group.name) {
        problems.push(`${groupContext}: figmaNodeId + name required`);
        continue;
      }
      const groupKey = `${group.figmaNodeId}::${group.name}`;
      if (seenGroups.has(groupKey)) problems.push(`${groupContext}: duplicate group entry`);
      seenGroups.add(groupKey);
      if (seenNodeIds.has(group.figmaNodeId)) {
        problems.push(
          `${groupContext}: duplicate figmaNodeId "${group.figmaNodeId}" across groups (would collide during merge)`,
        );
      }
      seenNodeIds.add(group.figmaNodeId);
      const rawComponent = findRawComponent(raw, group.figmaNodeId, group.name);
      if (!rawComponent) {
        problems.push(`${groupContext}: missing Figma group in fetched raw data`);
        continue;
      }
      if (!Array.isArray(group.mappings) || group.mappings.length === 0) {
        problems.push(`${groupContext}: non-empty mappings[] required`);
        continue;
      }
      const seenProps = new Set();
      for (const mapping of group.mappings) {
        if (seenProps.has(mapping.figmaProp)) {
          problems.push(`${groupContext}: duplicate figmaProp "${mapping.figmaProp}"`);
        }
        seenProps.add(mapping.figmaProp);
        validateMapping(
          problems,
          `${groupContext}.${mapping.figmaProp ?? 'unknown-prop'}`,
          mapping,
          rawComponent.propertyDefinitions?.[mapping.figmaProp],
          codeComponent,
        );
      }
      const missingProps = Object.keys(rawComponent.propertyDefinitions ?? {}).filter(
        (figmaProp) => !seenProps.has(figmaProp),
      );
      if (missingProps.length > 0) {
        problems.push(`${groupContext}: missing Figma properties [${missingProps.join(', ')}]`);
      }
    }
  }
  return problems;
}
export { validateMatchedSemantic, exactCodePropCandidates, findCodeComponent, findRawComponent };
