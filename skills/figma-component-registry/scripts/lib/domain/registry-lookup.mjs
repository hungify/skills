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

function findRegistryEntryByExportName(projectRoot, registryRoot, exportName) {
  const root = path.join(projectRoot, registryRoot);
  if (!fs.existsSync(root)) return null;

  const matches = [];
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
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (parsed?.component?.exportName === exportName) {
          matches.push({ filePath: fullPath, entry: parsed });
        }
      } catch {
        // skip unreadable registry files
      }
    }
  }

  if (matches.length > 1) {
    const relPaths = matches.map((match) => path.relative(root, match.filePath)).sort();
    throw new Error(
      `ambiguous exportName "${exportName}" matches ${matches.length} registry files: ${relPaths.join(', ')} — disambiguate with a full registry path`,
    );
  }

  return matches[0] ?? null;
}
export { readExistingRegistry, findRegistryEntryByExportName };
