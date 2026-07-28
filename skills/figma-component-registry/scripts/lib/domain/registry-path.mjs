import path from 'path';

function registryFilePath({ projectRoot, registryRoot, sourceRoot, filePath, exportName }) {
  const absSourceRoot = path.join(projectRoot, sourceRoot);
  const absFile = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  const rel = path.relative(absSourceRoot, absFile);
  if (rel.startsWith('..')) {
    throw new Error(`${filePath} is not under sourceRoot ${sourceRoot}`);
  }
  const area = path.dirname(rel);
  return path.join(projectRoot, registryRoot, area === '.' ? '' : area, `${exportName}.json`);
}
export { registryFilePath };
