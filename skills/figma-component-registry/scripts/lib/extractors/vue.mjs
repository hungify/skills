import fs from 'node:fs';
import path from 'node:path';
import { createChecker, createCheckerByJson } from 'vue-component-meta';
import { projectMappingCandidateProps } from '../domain/prop-policy.mjs';

const fileExtensions = ['.vue'];
const checkerCache = new Map();

function findNearest(startDir, name) {
  let current = startDir;
  while (true) {
    const candidate = path.join(current, name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function checkerFor(absPath) {
  const tsconfigPath = findNearest(path.dirname(absPath), 'tsconfig.json');
  if (tsconfigPath) {
    const key = `tsconfig:${tsconfigPath}`;
    if (!checkerCache.has(key)) {
      checkerCache.set(key, createChecker(tsconfigPath, { schema: true }));
    }
    return checkerCache.get(key);
  }

  const packagePath = findNearest(path.dirname(absPath), 'package.json');
  const projectRoot = packagePath ? path.dirname(packagePath) : path.dirname(absPath);
  const key = `json:${projectRoot}`;
  if (!checkerCache.has(key)) {
    checkerCache.set(
      key,
      createCheckerByJson(
        projectRoot,
        {
          include: ['**/*.vue'],
          compilerOptions: {
            allowJs: true,
            module: 'ESNext',
            moduleResolution: 'Bundler',
            skipLibCheck: true,
            strict: true,
            target: 'ESNext',
          },
          vueCompilerOptions: { target: 3.5 },
        },
        { schema: true },
      ),
    );
  }
  return checkerCache.get(key);
}

function literalEnumValues(schema) {
  if (schema?.kind !== 'enum' || !Array.isArray(schema.schema)) return [];
  return schema.schema.flatMap((value) => {
    if (typeof value !== 'string' || value === 'undefined') return [];
    const quoted = value.match(/^(["'])(.*)\1$/);
    return quoted ? [quoted[2]] : [];
  });
}

function toRegistryProp(prop) {
  const enumValues = literalEnumValues(prop.schema);
  if (enumValues.length > 0) return { type: 'enum', values: enumValues };

  const type = String(prop.type ?? '').toLowerCase();
  const schemaValues =
    prop.schema?.kind === 'enum' && Array.isArray(prop.schema.schema)
      ? new Set(prop.schema.schema.filter((value) => typeof value === 'string'))
      : new Set();
  if (
    type.includes('boolean') ||
    (schemaValues.has('false') && schemaValues.has('true'))
  ) {
    return { type: 'boolean' };
  }
  if (type.includes('string') || schemaValues.has('string')) return { type: 'string' };
  if (type.includes('number') || schemaValues.has('number')) return { type: 'number' };
  if (type.includes('vnode') || type.includes('component')) return { type: 'node' };
  if (type.includes('[]') || type.startsWith('array')) return { type: 'array' };
  return { type: 'unknown' };
}

function extractComponents(absPath) {
  if (!fs.existsSync(absPath)) throw new Error(`File not found: ${absPath}`);
  if (path.extname(absPath) !== '.vue') {
    throw new Error(`Vue 3 extractor only supports .vue SFC files: ${absPath}`);
  }

  const meta = checkerFor(absPath).getComponentMeta(absPath);
  const eventNames = new Set((meta.events ?? []).map((event) => event.name));
  const props = {};
  const rawProps = {};
  for (const prop of meta.props ?? []) {
    props[prop.name] = toRegistryProp(prop);
    rawProps[prop.name] = prop;
  }

  const projectedProps = projectMappingCandidateProps(props, {
    eventNames,
    rawProps,
    excludeAccessibilityPassthrough: true,
  });
  const componentName = meta.name || path.basename(absPath, '.vue');
  return {
    [componentName]: {
      exportType: 'default',
      props: projectedProps,
      ownedPropNames: Object.keys(projectedProps),
    },
  };
}
export { extractComponents, fileExtensions, toRegistryProp };
