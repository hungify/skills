import path from 'path';
import { isPathUnderDir } from '../paths.mjs';

function assertSafeExportName(exportName) {
  if (
    typeof exportName !== 'string' ||
    exportName.length === 0 ||
    /[\\/]/.test(exportName) ||
    exportName === '.' ||
    exportName === '..'
  ) {
    throw new Error(`invalid exportName "${exportName}"`);
  }
}

function registryFilePath({ projectRoot, registryRoot, sourceRoot, filePath, exportName }) {
  assertSafeExportName(exportName);
  const absSourceRoot = path.join(projectRoot, sourceRoot);
  const absFile = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  if (!isPathUnderDir(absFile, absSourceRoot)) {
    throw new Error(`${filePath} is not under sourceRoot ${sourceRoot}`);
  }
  const rel = path.relative(absSourceRoot, absFile);
  const area = path.dirname(rel);
  return path.join(projectRoot, registryRoot, area === '.' ? '' : area, `${exportName}.json`);
}
export { registryFilePath };
