import fs from 'fs';
import path from 'path';
import { registryFilePath } from './registry-path.mjs';
import { toCodePropsMap } from './code-props-map.mjs';
import { hashJson } from '../paths.mjs';

function toProjectRelative(projectRoot, filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  return path.relative(projectRoot, abs).replace(/\\/g, '/');
}

function checkCodePropsDrift(codeComponents, { projectRoot, registryRoot, sourceRoot }) {
  const stale = [];

  for (const component of Object.values(codeComponents)) {
    const exportName = component.componentName;
    let relFile;
    try {
      relFile = toProjectRelative(projectRoot, component.file);
    } catch {
      continue;
    }

    let registryPath;
    try {
      registryPath = registryFilePath({
        projectRoot,
        registryRoot,
        sourceRoot,
        filePath: relFile,
        exportName,
      });
    } catch {
      continue;
    }

    if (!fs.existsSync(registryPath)) continue;

    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch {
      stale.push(`${path.relative(projectRoot, registryPath).replace(/\\/g, '/')}: unreadable registry JSON`);
      continue;
    }

    if (entry.schemaVersion !== 3) {
      stale.push(
        `${path.relative(projectRoot, registryPath).replace(/\\/g, '/')}: schemaVersion ${entry.schemaVersion}, expected 3 (registry stale)`,
      );
      continue;
    }

    let extractedCodePropsMap;
    try {
      extractedCodePropsMap = toCodePropsMap(component.props, entry.figmaBindings ?? []);
    } catch (error) {
      stale.push(
        `${path.relative(projectRoot, registryPath).replace(/\\/g, '/')}: ${error instanceof Error ? error.message : error} (registry stale)`,
      );
      continue;
    }

    const registryHash = hashJson(entry.codePropsMap ?? {});
    const extractedHash = hashJson(extractedCodePropsMap);
    if (registryHash !== extractedHash) {
      stale.push(
        `${path.relative(projectRoot, registryPath).replace(/\\/g, '/')}: codePropsMap drift (registry stale)`,
      );
    }
  }

  return stale;
}
export { checkCodePropsDrift, toProjectRelative };
