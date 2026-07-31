import fs from 'fs';
import path from 'path';
import { createTwoFilesPatch } from 'diff';
import { buildCodeRawFromCache } from './extract-code.mjs';
import { writeJsonAtomic, ensureDir } from '../infra/fs-atomic.mjs';
import { mergeGroups } from '../domain/merge-groups.mjs';
import { flattenGroupsToBindings } from '../domain/flatten-bindings.mjs';
import { registryFilePath } from '../domain/registry-path.mjs';
import { toCodePropsMap } from '../domain/code-props-map.mjs';
import {
  recoverGroupsFromRegistry,
  applyRenamedGroupNames,
} from '../domain/recover-groups.mjs';
import { readExistingRegistry } from '../domain/registry-lookup.mjs';
import { definitionsForMergedGroups } from '../domain/definitions-for-merged-groups.mjs';
import { frameworkFromCodeCache } from '../domain/framework.mjs';
import { validateRegistryEntry, validateMatched } from '../validate/shape.mjs';
import { validateMatchedSemantic, findCodeComponent } from '../validate/semantic.mjs';
import {
  cachePaths,
  isolatedCacheDir,
  findProjectRoot,
  getFigmaToken,
  hashJson,
  SHARED_CACHE_DIR,
  CODE_CACHE_NAME,
  DEFAULT_UI_DIR,
} from '../paths.mjs';

function cleanupCycleArtifacts(paths) {
  for (const filePath of [paths.raw, paths.matched]) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  if (fs.existsSync(paths.cacheDir) && fs.readdirSync(paths.cacheDir).length === 0) {
    fs.rmdirSync(paths.cacheDir);
  }
}

async function cmdFinalize(args) {
  const paths = cachePaths(isolatedCacheDir(args, 'finalize'));
  for (const [label, filePath] of [
    ['matched', paths.matched],
    ['raw', paths.raw],
  ]) {
    if (!fs.existsSync(filePath)) {
      console.error(`❌ Missing ${filePath} (${label})`);
      process.exit(1);
    }
  }

  const projectRoot = findProjectRoot(process.cwd(), args['project-root']);
  const registryRoot = args['registry-root'] || 'registry';
  const sourceRoot = args['source-root'] || DEFAULT_UI_DIR;
  const codeCachePath =
    args['code-cache'] ||
    path.join(projectRoot, SHARED_CACHE_DIR, CODE_CACHE_NAME);
  if (!fs.existsSync(codeCachePath)) {
    console.error(`❌ Missing ${codeCachePath} (shared code cache); run extract-code first`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(paths.raw, 'utf8'));
  const matched = JSON.parse(fs.readFileSync(paths.matched, 'utf8'));
  const codeCache = JSON.parse(fs.readFileSync(codeCachePath, 'utf8'));
  const framework = frameworkFromCodeCache(codeCache, sourceRoot);
  const { codeComponents, componentIndex } = buildCodeRawFromCache(
    codeCache,
    sourceRoot,
  );
  const codeRaw = {
    schemaVersion: 2,
    extractor: `${framework}-typescript-ast`,
    uiDir: sourceRoot,
    components: codeComponents,
    componentIndex,
  };

  const shapeResult = validateMatched(matched);
  if (!shapeResult.ok) {
    console.error(`❌ Invalid ${paths.matched} shape:`);
    shapeResult.errors.forEach((problem) => console.error(`   - ${problem}`));
    process.exit(1);
  }

  const semanticProblems = validateMatchedSemantic(matched, raw, codeRaw);
  if (semanticProblems.length > 0) {
    console.error(`❌ Invalid ${paths.matched}:`);
    semanticProblems.forEach((problem) => console.error(`   - ${problem}`));
    process.exit(1);
  }

  if (args.prune === true || args.prune === 'true') {
    console.error('❌ prune not supported');
    process.exit(1);
  }

  const token = getFigmaToken();
  const fetchOptions = {
    token,
    fetchImpl: args.fetchImpl,
    fetchDefinitionGroups: args.fetchDefinitionGroups,
  };

  const dryRun = args['dry-run'] === true || args['dry-run'] === 'true';
  const writtenFiles = [];
  const previewedFiles = [];
  const summaries = [];

  for (const component of matched.components) {
    const codeComponent = findCodeComponent(codeRaw, component.codeComponent, component.codeFile);
    if (!codeComponent) {
      console.error(`❌ Missing code component ${component.codeComponent} (${component.codeFile})`);
      process.exit(1);
    }

    const outPath = registryFilePath({
      projectRoot,
      registryRoot,
      sourceRoot,
      filePath: component.codeFile,
      exportName: component.codeComponent,
    });
    const existing = readExistingRegistry(outPath);
    const existingGroups = existing ? recoverGroupsFromRegistry(existing, raw) : [];
    const mergedGroups = mergeGroups(existingGroups, component.groups);
    const mergedCount = mergedGroups.length - component.groups.length;
    if (mergedCount > 0) {
      console.log(
        `   ${component.codeComponent}: carrying forward ${mergedCount} group(s) from previous sync`,
      );
    }

    let definitions;
    try {
      definitions = await definitionsForMergedGroups(
        mergedGroups,
        raw,
        existing?.figma?.lastKnownFileKey ?? raw.fileKey,
        fetchOptions,
      );
    } catch (error) {
      console.error(
        `❌ ${component.codeComponent}: ${error instanceof Error ? error.message : error}`,
      );
      process.exit(1);
    }

    const groupsWithNames = applyRenamedGroupNames(mergedGroups, definitions);
    const componentPath = component.codeComponent;
    const figmaBindings = flattenGroupsToBindings({
      componentPath,
      groups: groupsWithNames,
    });

    const primaryNodeId =
      groupsWithNames[0]?.figmaNodeId ?? existing?.figma?.lastKnownNodeId ?? null;

    const entry = {
      schemaVersion: 3,
      component: {
        exportName: component.codeComponent,
        exportType: codeComponent.exportType ?? 'named',
        filePath: component.codeFile,
      },
      figma: {
        componentPath,
        lastKnownFileKey: raw.fileKey ?? existing?.figma?.lastKnownFileKey ?? null,
        lastKnownNodeId: primaryNodeId,
      },
      codePropsMap: toCodePropsMap(codeComponent.props, figmaBindings),
      figmaBindings,
    };

    const entryValidation = validateRegistryEntry(entry);
    if (!entryValidation.ok) {
      console.error(`❌ Registry entry invalid for ${component.codeComponent}:`);
      entryValidation.errors.forEach((problem) => console.error(`   - ${problem}`));
      process.exit(1);
    }

    if (dryRun) {
      const before = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
      const after = `${JSON.stringify(entry, null, 2)}\n`;
      const status = before === '' ? 'new file' : before === after ? 'unchanged' : 'would update';
      previewedFiles.push({ outPath, status });
      console.log(`🔍 [dry-run] ${status}: ${outPath}`);
      if (status === 'would update' || status === 'new file') {
        console.log(
          createTwoFilesPatch(
            'registry (before)',
            'registry (after)',
            before,
            after,
            '',
            '',
            { context: 2 },
          ),
        );
      }
    } else {
      ensureDir(path.dirname(outPath));
      writeJsonAtomic(outPath, entry);
      writtenFiles.push(outPath);
    }
    summaries.push({
      component: component.codeComponent,
      groups: groupsWithNames,
      mappings: groupsWithNames.flatMap((group) => group.mappings ?? []),
    });
  }

  if (dryRun) {
    console.log(`🔍 Dry run: ${previewedFiles.length} registry file(s) would be affected, 0 written`);
  } else {
    console.log(`✅ Wrote ${writtenFiles.length} registry file(s)`);
  }
  for (const summary of summaries) {
    const groupNames = summary.groups.map((group) => group.name).join(', ');
    console.log(`   ${summary.component} — ${summary.mappings.length} binding(s) [${groupNames}]`);
  }
  if (!dryRun) {
    cleanupCycleArtifacts(paths);
    console.log(`   Cycle cache cleaned: ${paths.cacheDir}/`);
  }
}
export { cleanupCycleArtifacts, cmdFinalize };
