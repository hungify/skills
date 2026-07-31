import path from 'path';
import { stripFigmaPropId } from '../domain/path-normalize.mjs';
import { recoverGroupsFromRegistry } from '../domain/recover-groups.mjs';
import { fetchDefinitionGroups } from '../domain/definitions-for-merged-groups.mjs';
import { validateRegistryEntry } from '../validate/shape.mjs';
import { buildExportNameIndex, resolveFromIndex } from '../domain/registry-lookup.mjs';
import { findProjectRoot, getFigmaToken } from '../paths.mjs';

function mappingPropsResolve(group, propertyDefinitions) {
  const missing = [];
  const keys = Object.keys(propertyDefinitions ?? {});
  for (const mapping of group.mappings ?? []) {
    const found = keys.some(
      (key) => key === mapping.figmaProp || stripFigmaPropId(key) === stripFigmaPropId(mapping.figmaProp),
    );
    if (!found) missing.push(mapping.figmaProp);
  }
  return missing;
}

async function cmdVerifySource(args) {
  const requested = String(args.components || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    console.error('ERROR: Need --components Button,Input');
    process.exit(1);
  }

  const projectRoot = findProjectRoot(process.cwd(), args['project-root']);
  const registryRoot = args['registry-root'] || 'registry';
  const token = getFigmaToken();
  if (!token && !args.fetchDefinitionGroups) {
    console.error('ERROR: Missing FIGMA_ACCESS_TOKEN in .env');
    process.exit(1);
  }

  const registryRootAbs = path.join(projectRoot, registryRoot);
  const registryIndex = buildExportNameIndex(projectRoot, registryRoot);
  const maps = requested.map((exportName) => {
    const found = resolveFromIndex(registryIndex, registryRootAbs, exportName);
    if (!found) {
      throw new Error(`registry entry missing for export ${exportName}`);
    }
    const validation = validateRegistryEntry(found.entry);
    if (!validation.ok) {
      throw new Error(
        `${exportName}: invalid registry entry (${validation.errors.join('; ')})`,
      );
    }
    return { exportName, ...found };
  });

  const groupsByFile = new Map();
  for (const { entry } of maps) {
    const fileKey = entry.figma?.lastKnownFileKey;
    if (!fileKey) {
      throw new Error(`${entry.component.exportName}: figma.lastKnownFileKey required`);
    }
    const groups = recoverGroupsFromRegistry(entry, { components: [] });
    const current = groupsByFile.get(fileKey) ?? new Map();
    for (const group of groups) {
      current.set(group.figmaNodeId, group);
    }
    groupsByFile.set(fileKey, current);
  }

  const fetchedByFile = new Map();
  for (const [fileKey, groupMap] of groupsByFile) {
    const nodeIds = [...groupMap.keys()];
    const fetchGroups =
      args.fetchDefinitionGroups ??
      ((key, ids) => fetchDefinitionGroups(key, ids, { token, fetchImpl: args.fetchImpl }));
    const groups = await fetchGroups(fileKey, nodeIds);
    fetchedByFile.set(fileKey, new Map(groups.map((group) => [group.figmaNodeId, group])));
  }

  const stale = [];
  for (const { exportName, entry } of maps) {
    const fileKey = entry.figma.lastKnownFileKey;
    const fetched = fetchedByFile.get(fileKey);
    const groups = recoverGroupsFromRegistry(entry, { components: [] });

    for (const group of groups) {
      const current = fetched?.get(group.figmaNodeId);
      if (!current) {
        stale.push(`${exportName}: Figma group missing ${group.figmaNodeId} (${group.name})`);
        continue;
      }

      if (current.name !== group.name) {
        stale.push(
          `${exportName}: Figma group renamed ${group.figmaNodeId}: ${group.name} -> ${current.name}`,
        );
      }

      const missingProps = mappingPropsResolve(group, current.propertyDefinitions);
      if (missingProps.length > 0) {
        stale.push(
          `${exportName}: mapping prop(s) "${missingProps.join('", "')}" missing from live Figma definitions for ${group.name}`,
        );
      }
    }
  }

  if (stale.length > 0) {
    console.error('ERROR: Stale Figma registry sources:');
    stale.forEach((problem) => console.error(`   - ${problem}`));
    process.exit(1);
  }

  console.log(`OK: Current Figma definitions match ${maps.length} registry file(s)`);
}
export { cmdVerifySource, mappingPropsResolve };
