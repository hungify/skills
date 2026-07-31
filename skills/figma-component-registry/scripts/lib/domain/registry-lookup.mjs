import fs from 'fs';
import path from 'path';

function readExistingRegistry(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function walkRegistryFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.name.endsWith('.json') || entry.name === 'config.json') continue;
      files.push(fullPath);
    }
  }
  return files;
}

function buildExportNameIndex(projectRoot, registryRoot) {
  const root = path.join(projectRoot, registryRoot);
  const index = new Map();
  if (!fs.existsSync(root)) return index;

  for (const fullPath of walkRegistryFiles(root)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const exportName = parsed?.component?.exportName;
      if (!exportName) continue;
      const matches = index.get(exportName) ?? [];
      matches.push({ filePath: fullPath, entry: parsed });
      index.set(exportName, matches);
    } catch {
      // skip unreadable registry files
    }
  }
  return index;
}

function resolveFromIndex(index, root, exportName) {
  const requested = String(exportName);
  const pathLike = path.isAbsolute(requested) || /[\\/]/.test(requested) || requested.endsWith('.json');
  if (pathLike) {
    const normalizedRequest = requested.replace(/\\/g, '/');
    const rootName = path.basename(root);
    const registryRelative = normalizedRequest.startsWith(`${rootName}/`)
      ? normalizedRequest.slice(rootName.length + 1)
      : normalizedRequest;
    const requestedPath = path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(root, registryRelative);
    const relative = path.relative(path.resolve(root), requestedPath);
    if (
      relative === '' ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`registry path "${exportName}" is outside ${root}`);
    }
    for (const matches of index.values()) {
      const found = matches.find((match) => path.resolve(match.filePath) === requestedPath);
      if (found) return found;
    }
    return null;
  }

  const matches = index.get(exportName) ?? [];
  if (matches.length > 1) {
    const relPaths = matches.map((match) => path.relative(root, match.filePath)).sort();
    throw new Error(
      `ambiguous exportName "${exportName}" matches ${matches.length} registry files: ${relPaths.join(', ')} — disambiguate with a registry-relative path such as ${relPaths[0]}`,
    );
  }
  return matches[0] ?? null;
}

function findRegistryEntryByExportName(projectRoot, registryRoot, exportName) {
  const root = path.join(projectRoot, registryRoot);
  const index = buildExportNameIndex(projectRoot, registryRoot);
  return resolveFromIndex(index, root, exportName);
}
export {
  readExistingRegistry,
  findRegistryEntryByExportName,
  buildExportNameIndex,
  resolveFromIndex,
};
