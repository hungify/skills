import { fetchFileNodes } from '../infra/figma-client.mjs';
import { collectComponents } from './figma-collect.mjs';
import { stripFigmaPropId } from './path-normalize.mjs';
import { findRawComponent } from '../validate/semantic.mjs';

function mappedPropExists(figmaProp, propertyDefinitions) {
  const keys = Object.keys(propertyDefinitions ?? {});
  return keys.some(
    (key) =>
      key === figmaProp || stripFigmaPropId(key) === stripFigmaPropId(figmaProp),
  );
}

function definitionKeys(definitions) {
  return Object.keys(definitions ?? {}).sort().join('\0');
}

function definitionsCompatible(left, right) {
  return definitionKeys(left) === definitionKeys(right);
}

async function fetchDefinitionGroups(fileKey, nodeIds, { token, fetchImpl }) {
  const data = await fetchFileNodes({
    token,
    fileKey,
    nodeIds,
    fetchImpl,
  });
  const components = [];
  for (const entry of Object.values(data.nodes || {})) {
    if (entry?.document) collectComponents(entry.document, components);
  }
  return components;
}

async function definitionsForMergedGroups(groups, raw, fileKey, options = {}) {
  const token = options.token;
  const fetchImpl = options.fetchImpl;
  const fetchGroups =
    options.fetchDefinitionGroups ??
    ((key, nodeIds) => fetchDefinitionGroups(key, nodeIds, { token, fetchImpl }));

  const resolved = new Map();
  const carriedForward = [];

  for (const group of groups) {
    const rawComponent = findRawComponent(raw, group.figmaNodeId, group.name);
    if (rawComponent) {
      resolved.set(group.figmaNodeId, {
        name: group.name,
        figmaNodeId: group.figmaNodeId,
        propertyDefinitions: rawComponent.propertyDefinitions ?? {},
      });
    } else {
      carriedForward.push(group);
    }
  }

  if (carriedForward.length > 0) {
    const fetched = await fetchGroups(
      fileKey,
      carriedForward.map((group) => group.figmaNodeId),
    );
    const byId = new Map(fetched.map((group) => [group.figmaNodeId, group]));
    for (const group of carriedForward) {
      const current = byId.get(group.figmaNodeId);
      if (!current) {
        throw new Error(
          `carried-forward group ${group.figmaNodeId} (${group.name}) no longer exists in Figma — re-sync or remove it before finalize can merge`,
        );
      }
      if (current.name !== group.name) {
        const missingProps = (group.mappings ?? [])
          .map((mapping) => mapping.figmaProp)
          .filter((figmaProp) => !mappedPropExists(figmaProp, current.propertyDefinitions));
        if (missingProps.length > 0) {
          throw new Error(
            `carried-forward group ${group.figmaNodeId} renamed in Figma with incompatible definitions: ${group.name} -> ${current.name}`,
          );
        }
      }
      resolved.set(group.figmaNodeId, {
        name: current.name,
        figmaNodeId: group.figmaNodeId,
        propertyDefinitions: current.propertyDefinitions ?? {},
      });
    }
  }

  return groups.map((group) => {
    const current = resolved.get(group.figmaNodeId);
    return current ?? { name: group.name, figmaNodeId: group.figmaNodeId, propertyDefinitions: {} };
  });
}
export { definitionsForMergedGroups, definitionsCompatible, fetchDefinitionGroups };
