import fs from 'node:fs';
import path from 'node:path';
import { walkComponentFiles } from '../paths.mjs';

const SUPPORTED_FRAMEWORKS = new Set(['react', 'vue']);

function validateFramework(framework) {
  if (!SUPPORTED_FRAMEWORKS.has(framework)) {
    throw new Error(
      `Unsupported framework "${framework ?? ''}"; expected react or vue`,
    );
  }
  return framework;
}

function packageFrameworks(projectRoot) {
  const packagePath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(packagePath)) return [];
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
    ...(packageJson.peerDependencies ?? {}),
  };
  return [
    ...(dependencies.react ? ['react'] : []),
    ...(dependencies.vue ? ['vue'] : []),
  ];
}

function sourceFrameworks(uiDir) {
  const files = walkComponentFiles(uiDir, ['.tsx', '.vue']);
  return [
    ...(files.some((filePath) => filePath.endsWith('.tsx')) ? ['react'] : []),
    ...(files.some((filePath) => filePath.endsWith('.vue')) ? ['vue'] : []),
  ];
}

function detectFramework({ projectRoot, uiDir, requestedFramework }) {
  if (requestedFramework) return validateFramework(requestedFramework);

  const packageCandidates = packageFrameworks(projectRoot);
  if (packageCandidates.length === 1) return packageCandidates[0];
  if (packageCandidates.length > 1) {
    throw new Error(
      `Project root ${projectRoot} declares both React and Vue; run from one app/package root or pass --framework`,
    );
  }

  const sourceCandidates = sourceFrameworks(uiDir);
  if (sourceCandidates.length === 1) return sourceCandidates[0];
  if (sourceCandidates.length > 1) {
    throw new Error(
      `Source root ${uiDir} contains both React and Vue components; run from one app/package root or pass --framework`,
    );
  }

  throw new Error(
    `Could not detect framework for ${projectRoot}; install react/vue or pass --framework`,
  );
}

function frameworkFromCodeCache(cache, sourceRoot) {
  const sourcePrefix = sourceRoot.endsWith(path.sep)
    ? sourceRoot
    : `${sourceRoot}${path.sep}`;
  const frameworks = new Set(
    Object.entries(cache)
      .filter(([filePath]) => filePath.startsWith(sourcePrefix))
      .map(([, entry]) => entry.framework)
      .filter(Boolean),
  );
  if (frameworks.size !== 1) {
    throw new Error(
      `Shared code cache must contain exactly one framework under ${sourceRoot}; run extract-code first`,
    );
  }
  return validateFramework([...frameworks][0]);
}

export { detectFramework, frameworkFromCodeCache, validateFramework };
