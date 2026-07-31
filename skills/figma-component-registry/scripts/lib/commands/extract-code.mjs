import fs from 'fs';
import path from 'path';
import { withCodeCacheLock } from '../infra/cache-io.mjs';
import { loadExtractor } from '../extractors/index.mjs';
import {
  SHARED_CACHE_DIR,
  CODE_CACHE_NAME,
  findProjectRoot,
  DEFAULT_UI_DIR,
  nowIso,
  hashContent,
  hashJson,
  isPathUnderDir,
  walkComponentFiles,
} from '../paths.mjs';
import { checkCodePropsDrift } from '../domain/check-code-drift.mjs';
import { detectFramework } from '../domain/framework.mjs';

const EXTRACTOR_VERSION = 9;

function buildCodeRawFromCache(cache, uiDir) {
  const extractedComponents = [];

  for (const [filePath, entry] of Object.entries(cache)) {
    if (!isPathUnderDir(filePath, uiDir)) continue;
    for (const [componentName, component] of Object.entries(entry.components ?? {})) {
      extractedComponents.push({
        componentName,
        exportType: component.exportType,
        props: component.props,
        fullProps: component.props,
        omittedPropCount: 0,
        codeApiHash: hashJson(component.props),
        file: filePath,
      });
    }
  }

  const nameCounts = extractedComponents.reduce((counts, component) => {
    counts[component.componentName] = (counts[component.componentName] ?? 0) + 1;
    return counts;
  }, {});

  const codeComponents = {};
  const fullCodeComponents = {};
  const componentIndex = {};
  for (const component of extractedComponents) {
    const key =
      nameCounts[component.componentName] === 1
        ? component.componentName
        : `${component.file}#${component.componentName}`;
    const { fullProps, ...projectedComponent } = component;
    codeComponents[key] = projectedComponent;
    fullCodeComponents[key] = { ...projectedComponent, props: fullProps };
    componentIndex[component.componentName] ??= [];
    componentIndex[component.componentName].push(key);
  }

  return { codeComponents, fullCodeComponents, componentIndex };
}

async function cmdExtractCode(args) {
  const uiDir = args['ui-dir'] || DEFAULT_UI_DIR;
  if (!fs.existsSync(uiDir)) {
    console.error(`❌ Missing dir ${uiDir}`);
    process.exit(1);
  }

  const projectRoot = findProjectRoot(process.cwd(), args['project-root']);
  const codeCachePath =
    args['code-cache'] ||
    path.join(projectRoot, SHARED_CACHE_DIR, CODE_CACHE_NAME);
  const framework = detectFramework({
    projectRoot,
    uiDir,
    requestedFramework: args.framework,
  });
  const extractor = await loadExtractor(framework);
  const componentFiles = walkComponentFiles(uiDir, extractor.fileExtensions);

  let reused = 0;
  let reparsed = 0;

  let extractionErrors = [];
  const cache = await withCodeCacheLock(codeCachePath, async (lockedCache) => {
    const next = { ...lockedCache };
    const seenFiles = new Set();
    extractionErrors = [];

    for (const filePath of componentFiles) {
      seenFiles.add(filePath);
      const source = fs.readFileSync(filePath, 'utf8');
      const hash = hashContent(source);
      const cached = next[filePath];

      if (
        cached &&
        cached.hash === hash &&
        cached.components &&
        cached.framework === framework &&
        cached.extractorVersion === EXTRACTOR_VERSION
      ) {
        reused++;
        continue;
      }

      try {
        const components = extractor.extractComponents(filePath);
        reparsed++;
        next[filePath] = {
          hash,
          framework,
          extractorVersion: EXTRACTOR_VERSION,
          extractedAt: nowIso(),
          components,
        };
      } catch (error) {
        extractionErrors.push(`${filePath}: ${error instanceof Error ? error.message : error}`);
      }
    }

    for (const knownPath of Object.keys(next)) {
      if (!isPathUnderDir(knownPath, uiDir)) continue;
      if (!seenFiles.has(knownPath)) delete next[knownPath];
    }

    return next;
  });

  if (extractionErrors.length > 0) {
    console.warn(`⚠️  ${extractionErrors.length} file(s) failed extraction and were skipped:`);
    extractionErrors.forEach((message) => console.warn(`   - ${message}`));
  }

  const { codeComponents, fullCodeComponents } = buildCodeRawFromCache(cache, uiDir);

  const quiet = args.quiet === true || args.quiet === 'true';
  const verbose = args.verbose === true || args.verbose === 'true';

  if (!quiet) {
    console.log(
      `✅ Extract ${Object.keys(codeComponents).length} comps / ${componentFiles.length} source files (cache ${reused}, parse ${reparsed}) → ${codeCachePath}`,
    );
  }

  if (verbose) {
    console.error(
      `   [verbose] source files scanned: ${componentFiles.length}, cache hit: ${reused}, cache miss (reparsed): ${reparsed}, components found: ${Object.keys(codeComponents).length}`,
    );
  }

  if (args['fail-on-stale'] || args['require-hashes']) {
    const sourceRoot =
      args['source-root'] || path.relative(projectRoot, path.resolve(uiDir));
    const registryRoot = args['registry-root'] || 'registry';
    const requestedComponents = args.components
      ? String(args.components)
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : null;
    const driftTargets = requestedComponents
      ? Object.fromEntries(
          Object.entries(fullCodeComponents).filter(([, component]) =>
            requestedComponents.includes(component.componentName),
          ),
        )
      : fullCodeComponents;
    if (requestedComponents && !quiet) {
      console.log(`   Scoped check: ${requestedComponents.join(', ')}`);
    }
    const stale = checkCodePropsDrift(driftTargets, {
      projectRoot,
      registryRoot,
      sourceRoot,
    });
    if (stale.length > 0 || extractionErrors.length > 0) {
      if (quiet) {
        console.error(
          `❌ ${stale.length} stale registry codePropsMap(s), ${extractionErrors.length} extraction error(s) — run without --quiet for details`,
        );
      } else {
        if (stale.length > 0) {
          console.error(`❌ ${stale.length} stale registry codePropsMap(s):`);
          stale.forEach((message) => console.error(`   - ${message}`));
        }
        if (extractionErrors.length > 0) {
          console.error(
            `❌ ${extractionErrors.length} file(s) failed extraction (registry cannot be verified against current source):`,
          );
          extractionErrors.forEach((message) => console.error(`   - ${message}`));
        }
      }
      process.exit(1);
    }
  }
}
export {
  cmdExtractCode,
  EXTRACTOR_VERSION,
  buildCodeRawFromCache,
};
