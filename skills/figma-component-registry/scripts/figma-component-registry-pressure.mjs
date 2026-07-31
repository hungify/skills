import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildCodeRawFromCache,
  cmdExtractCode,
  EXTRACTOR_VERSION,
} from './lib/commands/extract-code.mjs';
import { cmdFinalize } from './lib/commands/finalize.mjs';
import { cmdVerifySource, mappingPropsResolve } from './lib/commands/verify-source.mjs';
import { checkCodePropsDrift } from './lib/domain/check-code-drift.mjs';
import { toCodePropsMap } from './lib/domain/code-props-map.mjs';
import { collectComponents } from './lib/domain/figma-collect.mjs';
import { flattenGroupsToBindings, mapKind } from './lib/domain/flatten-bindings.mjs';
import { mergeGroups } from './lib/domain/merge-groups.mjs';
import { recoverGroupsFromRegistry } from './lib/domain/recover-groups.mjs';
import { findRegistryEntryByExportName } from './lib/domain/registry-lookup.mjs';
import { stripFigmaPropId, bindingPath } from './lib/domain/path-normalize.mjs';
import { registryFilePath } from './lib/domain/registry-path.mjs';
import { loadExtractor } from './lib/extractors/index.mjs';
import { withCodeCacheLock } from './lib/infra/cache-io.mjs';
import { fetchFileNodes } from './lib/infra/figma-client.mjs';
import { validateRegistryEntry } from './lib/validate/shape.mjs';
import { validateMatchedSemantic } from './lib/validate/semantic.mjs';
import { isPathUnderDir } from './lib/paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function testShapeGood() {
  const entry = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures/shape/good-entry.json'), 'utf8'),
  );
  const result = validateRegistryEntry(entry);
  assert.strictEqual(result.ok, true, result.errors.join('\n'));
  console.log('shape good entry → PASS');
}

function testShapeBad() {
  const entry = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures/shape/bad-entry-missing-prop.json'), 'utf8'),
  );
  const result = validateRegistryEntry(entry);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.length > 0);
  console.log('shape bad entry → PASS');
}

function testCodePropsMapIncludesOnlyBoundProps() {
  const props = {
    size: { type: 'enum', values: ['sm', 'lg'] },
    disabled: { type: 'boolean' },
    onClick: { type: 'unknown' },
    'aria-label': { type: 'string' },
  };
  const bindings = [
    {
      path: 'Button > Button > Size',
      figmaType: 'VARIANT',
      mappingKind: 'direct',
      prop: 'size',
    },
    {
      path: 'Button > Button > State',
      figmaType: 'VARIANT',
      mappingKind: 'bundle',
      props: ['disabled'],
      valueProps: { Disabled: { disabled: true } },
    },
    {
      path: 'Button > Button > Icon',
      figmaType: 'INSTANCE_SWAP',
      mappingKind: 'composition',
      note: 'Icon child composition.',
    },
  ];

  assert.deepStrictEqual(toCodePropsMap(props, bindings), {
    size: { type: 'enum', values: ['sm', 'lg'] },
    disabled: { type: 'boolean' },
  });
  assert.throws(
    () =>
      toCodePropsMap(props, [
        {
          path: 'Button > Button > Missing',
          figmaType: 'TEXT',
          mappingKind: 'direct',
          prop: 'missingProp',
        },
      ]),
    /missing code prop "missingProp"/,
  );
  console.log('codePropsMap bound props only → PASS');
}

function testCodePropsDriftIgnoresUnboundProps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-scoped-drift-'));
  const componentFile = path.join(dir, 'ui', 'input.tsx');
  fs.mkdirSync(path.dirname(componentFile), { recursive: true });
  fs.writeFileSync(componentFile, 'export {};');
  const registryPath = registryFilePath({
    projectRoot: dir,
    registryRoot: 'registry',
    sourceRoot: 'ui',
    filePath: componentFile,
    exportName: 'Input',
  });
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      schemaVersion: 2,
      component: { exportName: 'Input', exportType: 'named', filePath: 'ui/input.tsx' },
      figma: { componentPath: 'Input' },
      codePropsMap: { forceState: { type: 'enum', values: ['hover', 'focus'] } },
      figmaBindings: [
        {
          path: 'Input > Input > Force state',
          figmaType: 'VARIANT',
          mappingKind: 'direct',
          prop: 'forceState',
        },
      ],
    }),
  );
  const components = {
    Input: {
      componentName: 'Input',
      file: componentFile,
      props: {
        forceState: { type: 'enum', values: ['hover', 'focus'] },
        onClick: { type: 'changed-but-unbound' },
      },
    },
  };
  const options = {
    projectRoot: dir,
    registryRoot: 'registry',
    sourceRoot: 'ui',
  };

  assert.deepStrictEqual(checkCodePropsDrift(components, options), []);
  components.Input.props.forceState.values = ['hover', 'pressed'];
  assert.ok(checkCodePropsDrift(components, options)[0]?.includes('codePropsMap drift'));
  console.log('codePropsMap scoped drift → PASS');
}

function testCodeRawPreservesUncertainCandidates() {
  const cache = {
    'src/components/ui/button.tsx': {
      components: {
        Button: {
          exportType: 'named',
          ownedPropNames: ['size', 'color', 'className', 'onDelete', 'aria-description'],
          props: {
            size: { type: 'enum', values: ['sm', 'lg'] },
            color: { type: 'enum', values: ['green', 'red'] },
            disabled: { type: 'boolean' },
            focusableWhenDisabled: { type: 'boolean' },
            className: { type: 'string' },
            value: { type: 'string' },
            title: { type: 'string' },
            onClick: { type: 'unknown' },
            onDelete: { type: 'unknown' },
            'aria-label': { type: 'string' },
            'aria-description': { type: 'string' },
          },
        },
      },
    },
  };

  const { codeComponents } = buildCodeRawFromCache(cache, 'src/components', {
    figmaPropNames: new Set(['Focusable when disabled']),
  });

  assert.deepStrictEqual(codeComponents.Button.props, {
    size: { type: 'enum', values: ['sm', 'lg'] },
    color: { type: 'enum', values: ['green', 'red'] },
    disabled: { type: 'boolean' },
    focusableWhenDisabled: { type: 'boolean' },
    className: { type: 'string' },
    value: { type: 'string' },
    title: { type: 'string' },
    onClick: { type: 'unknown' },
    onDelete: { type: 'unknown' },
    'aria-label': { type: 'string' },
    'aria-description': { type: 'string' },
  });
  assert.strictEqual(codeComponents.Button.omittedPropCount, 0);
  console.log('code raw preserves uncertain candidates → PASS');
}

function testFigmaCollectPrunesVariantMembers() {
  const components = [];
  collectComponents(
    {
      id: 'root',
      name: 'Button section',
      type: 'FRAME',
      children: [
        {
          id: '1:1',
          name: 'Button',
          type: 'COMPONENT_SET',
          componentPropertyDefinitions: {
            Size: { type: 'VARIANT', variantOptions: ['Small', 'Large'] },
          },
          children: [
            { id: '1:2', name: 'Size=Small', type: 'COMPONENT', children: [] },
            { id: '1:3', name: 'Size=Large', type: 'COMPONENT', children: [] },
          ],
        },
        {
          id: '2:1',
          name: 'Standalone icon',
          type: 'COMPONENT',
          componentPropertyDefinitions: {},
          children: [],
        },
      ],
    },
    components,
  );

  assert.deepStrictEqual(
    components.map(({ name, figmaNodeId }) => ({ name, figmaNodeId })),
    [
      { name: 'Button', figmaNodeId: '1:1' },
      { name: 'Standalone icon', figmaNodeId: '2:1' },
    ],
  );
  console.log('Figma collector prunes variant members → PASS');
}

async function testParallelCacheMerge() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-cache-'));
  const cachePath = path.join(dir, 'code-props-cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({}));

  async function worker(key) {
    await withCodeCacheLock(cachePath, async (cache) => {
      await new Promise((r) => setTimeout(r, 30));
      return { ...cache, [key]: { hash: key } };
    });
  }

  await Promise.all([worker('a.tsx'), worker('b.tsx')]);
  const finalCache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.ok(finalCache['a.tsx'], 'missing a.tsx');
  assert.ok(finalCache['b.tsx'], 'missing b.tsx');
  console.log('parallel cache merge → PASS');
}

async function testCacheSkipsUnchangedWrite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-cache-stable-'));
  const cachePath = path.join(dir, 'code-props-cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({ stable: true }));
  const inodeBefore = fs.statSync(cachePath).ino;

  await withCodeCacheLock(cachePath, async (cache) => cache);

  assert.strictEqual(fs.statSync(cachePath).ino, inodeBefore);
  console.log('unchanged code cache not rewritten → PASS');
}

async function testFigmaClientBatches() {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ nodes: {} }) };
  };
  const ids = Array.from({ length: 51 }, (_, i) => `1:${i}`);
  await fetchFileNodes({
    token: 't',
    fileKey: 'FILE',
    nodeIds: ids,
    chunkSize: 50,
    fetchImpl,
  });
  assert.strictEqual(calls.length, 2);
  console.log('figma client batches → PASS');
}

async function testFigmaClientRetries() {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n < 3) return { ok: false, status: 429, statusText: 'Too Many Requests' };
    return { ok: true, status: 200, json: async () => ({ nodes: { x: 1 } }) };
  };
  await fetchFileNodes({
    token: 't',
    fileKey: 'FILE',
    nodeIds: ['1:1'],
    fetchImpl,
    retryDelayMs: 1,
  });
  assert.strictEqual(n, 3);
  console.log('figma client retries → PASS');
}

function testStripId() {
  assert.strictEqual(stripFigmaPropId('Show prepend#529:0'), 'Show prepend');
  assert.strictEqual(
    bindingPath({
      componentPath: 'Button',
      groupName: 'btn-size',
      figmaProp: 'Show prepend#529:0',
    }),
    'Button > btn-size > Show prepend',
  );
  console.log('path normalize → PASS');
}

function testFlattenBundle() {
  assert.strictEqual(mapKind('override'), 'bundle');
  assert.strictEqual(mapKind('unmapped'), 'unsupported');
  assert.strictEqual(mapKind('structural'), 'static');
  const bindings = flattenGroupsToBindings({
    componentPath: 'Checkbox',
    groups: [
      {
        name: 'Checkbox',
        mappings: [
          {
            figmaProp: 'Checked?',
            figmaType: 'VARIANT',
            mappingKind: 'bundle',
            props: ['checked', 'indeterminate'],
            valueProps: { True: { checked: true, indeterminate: false } },
          },
        ],
      },
    ],
  });
  assert.strictEqual(bindings[0].mappingKind, 'bundle');
  assert.deepStrictEqual(bindings[0].props, ['checked', 'indeterminate']);
  console.log('flatten bundle → PASS');
}

function testIsPathUnderDirNormalizesSeparators() {
  assert.strictEqual(isPathUnderDir('src/components/ui/button.tsx', 'src/components'), true);
  assert.strictEqual(isPathUnderDir('src/components/ui/button.tsx', './src/components'), true);
  assert.strictEqual(isPathUnderDir('src/components/ui/button.tsx', 'src/components/'), true);
  // must NOT false-positive on a directory whose name is a prefix of another
  assert.strictEqual(isPathUnderDir('src/components-legacy/button.tsx', 'src/components'), false);
  assert.strictEqual(isPathUnderDir('src/other/button.tsx', 'src/components'), false);
  console.log('isPathUnderDir normalizes separators → PASS');
}

function testRegistryPath() {
  const p = registryFilePath({
    projectRoot: '/repo',
    registryRoot: 'registry',
    sourceRoot: 'src/components',
    filePath: 'src/components/ui/button.tsx',
    exportName: 'Button',
  });
  assert.strictEqual(p, path.join('/repo', 'registry', 'ui', 'Button.json'));
  console.log('registry path → PASS');
}

function testRegistryPathRejectsTraversalExportName() {
  assert.throws(
    () =>
      registryFilePath({
        projectRoot: '/repo',
        registryRoot: 'registry',
        sourceRoot: 'src/components',
        filePath: 'src/components/ui/button.tsx',
        exportName: '../../evil',
      }),
    /invalid exportName/,
  );
  assert.throws(
    () =>
      registryFilePath({
        projectRoot: '/repo',
        registryRoot: 'registry',
        sourceRoot: 'src/components',
        filePath: 'src/components/ui/button.tsx',
        exportName: 'ui/Button',
      }),
    /invalid exportName/,
  );
  console.log('registry path rejects traversal exportName → PASS');
}

function testRegistryLookupFindsUniqueMatch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-lookup-'));
  const uiPath = path.join(dir, 'registry', 'ui', 'Button.json');
  fs.mkdirSync(path.dirname(uiPath), { recursive: true });
  fs.writeFileSync(uiPath, JSON.stringify({ component: { exportName: 'Button' } }));

  const found = findRegistryEntryByExportName(dir, 'registry', 'Button');
  assert.ok(found, 'expected a match');
  assert.strictEqual(found.filePath, uiPath);
  console.log('registry lookup finds unique match → PASS');
}

function testRegistryLookupFailsLoudOnCollision() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-lookup-collision-'));
  const uiPath = path.join(dir, 'registry', 'ui', 'Button.json');
  const marketingPath = path.join(dir, 'registry', 'marketing', 'Button.json');
  fs.mkdirSync(path.dirname(uiPath), { recursive: true });
  fs.mkdirSync(path.dirname(marketingPath), { recursive: true });
  fs.writeFileSync(uiPath, JSON.stringify({ component: { exportName: 'Button' } }));
  fs.writeFileSync(marketingPath, JSON.stringify({ component: { exportName: 'Button' } }));

  assert.throws(
    () => findRegistryEntryByExportName(dir, 'registry', 'Button'),
    (error) =>
      /ambiguous exportName "Button"/.test(error.message) &&
      error.message.includes('ui/Button.json') &&
      error.message.includes('marketing/Button.json'),
  );
  console.log('registry lookup fails loud on exportName collision → PASS');
}

function testMergeGroups() {
  const existing = [
    { figmaNodeId: '1:1', name: 'A', mappings: [] },
    { figmaNodeId: '1:2', name: 'B', mappings: [] },
  ];
  const incoming = [
    { figmaNodeId: '1:2', name: 'B-new', mappings: [{ figmaProp: 'Size' }] },
    { figmaNodeId: '1:3', name: 'C', mappings: [] },
  ];
  const merged = mergeGroups(existing, incoming);
  assert.strictEqual(merged.length, 3);
  assert.strictEqual(merged[0].figmaNodeId, '1:1');
  assert.strictEqual(merged[0].name, 'A');
  assert.strictEqual(merged[1].name, 'B-new');
  assert.strictEqual(merged[1].mappings[0].figmaProp, 'Size');
  assert.strictEqual(merged[2].figmaNodeId, '1:3');
  console.log('merge groups → PASS');
}

async function testFailOnStaleCodePropsMap() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-stale-'));
  const cacheDir = path.join(dir, 'cache');
  const uiDir = path.join(dir, 'ui');
  fs.mkdirSync(uiDir, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, 'fixtures/multi-component/input.tsx'),
    path.join(uiDir, 'input.tsx'),
  );
  const registryDir = path.join(dir, 'registry');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ dependencies: { react: '^19.0.0' } }),
  );
  fs.writeFileSync(
    path.join(registryDir, 'Input.json'),
    JSON.stringify({
      schemaVersion: 2,
      component: { exportName: 'Input', exportType: 'named', filePath: 'ui/input.tsx' },
      figma: { componentPath: 'Input' },
      codePropsMap: { forceState: { type: 'enum', values: ['stale-only'] } },
      figmaBindings: [],
    }),
  );

  const script = path.join(__dirname, 'figma-component-registry.mjs');
  const result = spawnSync(
    'node',
    [
      script,
      'check',
      '--ui-dir',
      uiDir,
      '--project-root',
      dir,
      '--code-cache',
      path.join(cacheDir, 'code-props-cache.json'),
      '--fail-on-stale',
    ],
    { encoding: 'utf8', cwd: dir },
  );

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.notStrictEqual(result.status, 0, `expected non-zero exit; output:\n${output}`);
  assert.ok(output.includes('codePropsMap drift'), `expected drift message; output:\n${output}`);
  console.log('fail-on-stale codePropsMap drift → PASS');
}

async function testExtractCodeCommand() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-extract-'));
  const uiDir = path.join(__dirname, 'fixtures/multi-component');
  const codeCache = path.join(dir, 'code-props-cache.json');

  await cmdExtractCode({
    'ui-dir': uiDir,
    'code-cache': codeCache,
    framework: 'react',
  });

  assert.ok(fs.existsSync(codeCache), 'missing code cache');
  assert.ok(
    !fs.existsSync(path.join(dir, '_code-props-raw.json')),
    'extract-code must not write _code-props-raw.json',
  );
  const cache = JSON.parse(fs.readFileSync(codeCache, 'utf8'));
  assert.ok(
    Object.values(cache).some((entry) => entry.components?.Input),
    'shared cache missing Input',
  );
  console.log('extract code command → PASS');
}

async function testExtractCodeDetectsFrameworkWithoutConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-framework-detect-'));
  const uiDir = path.join(dir, 'src', 'components');
  const codeCache = path.join(dir, '.figma', 'cache', 'code-props-cache.json');
  fs.mkdirSync(uiDir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ dependencies: { react: '^19.0.0' } }),
  );
  fs.writeFileSync(
    path.join(uiDir, 'Button.tsx'),
    `type ButtonProps = { variant?: 'filled' | 'outline' };
export function Button(_props: ButtonProps) { return null; }
`,
  );

  await cmdExtractCode({
    'project-root': dir,
    'ui-dir': uiDir,
    'code-cache': codeCache,
    quiet: true,
  });

  assert.ok(
    !fs.existsSync(path.join(dir, 'registry', 'config.json')),
    'framework detection must not create config',
  );
  const cache = JSON.parse(fs.readFileSync(codeCache, 'utf8'));
  assert.deepStrictEqual(
    [...new Set(Object.values(cache).map((entry) => entry.framework))],
    ['react'],
  );
  console.log('extract-code detects framework without config → PASS');
}

async function testExtractCodeRejectsMixedFrameworkRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-framework-mixed-'));
  const uiDir = path.join(dir, 'src', 'components');
  const codeCache = path.join(dir, '.figma', 'cache', 'code-props-cache.json');
  fs.mkdirSync(uiDir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ dependencies: { react: '^19.0.0', vue: '^3.5.0' } }),
  );
  fs.writeFileSync(
    path.join(uiDir, 'Button.tsx'),
    `export function Button() { return null; }\n`,
  );
  fs.copyFileSync(
    path.join(__dirname, 'fixtures/vue3/Button.vue'),
    path.join(uiDir, 'Button.vue'),
  );

  await assert.rejects(
    () =>
      cmdExtractCode({
        'project-root': dir,
        'ui-dir': uiDir,
        'code-cache': codeCache,
        quiet: true,
      }),
    /both React and Vue/,
  );
  console.log('extract-code rejects mixed framework root → PASS');
}

async function testExtractMulti() {
  const ex = await loadExtractor('react');
  const abs = path.join(__dirname, 'fixtures/multi-component/input.tsx');
  const components = ex.extractComponents(abs);

  assert.ok(components.Input, 'missing Input');
  assert.strictEqual(components.Input.exportType, 'named');
  assert.ok(components.Input.props.forceState != null, 'Input missing forceState');

  assert.ok(components.TextField, 'missing TextField');
  assert.strictEqual(components.TextField.exportType, 'named');
  assert.ok(components.TextField.props.forceState != null, 'TextField missing forceState');
  assert.ok(components.TextField.props.label != null, 'TextField missing label');
  assert.ok(components.TextField.props.required != null, 'TextField missing required');

  console.log('extract multi → PASS');
}

async function testReactExtractorExcludesOnlyConfirmedNoise() {
  const extractor = await loadExtractor('react');
  const abs = path.join(__dirname, 'fixtures/inherited-props/Button.tsx');
  const button = extractor.extractComponents(abs).Button;

  assert.ok(button, 'missing inherited-props Button');
  assert.deepStrictEqual(button.props.variant, {
    type: 'enum',
    values: ['filled', 'outline'],
  });
  assert.deepStrictEqual(button.props.disabled, { type: 'boolean' });
  assert.ok(button.props.className, 'composition candidate must remain available');
  assert.ok(!button.props.onClick, 'inherited event must not enter shared cache');
  assert.ok(!button.props.onDelete, 'owned event must not enter shared cache');
  assert.ok(button.props['aria-label'], 'inherited ARIA candidate must remain available');
  assert.ok(button.props['aria-description'], 'owned ARIA candidate must remain available');
  assert.ok(Object.keys(button.props).length > 10, 'public API was destructively projected');
  console.log('React extractor excludes only confirmed noise → PASS');
}

async function testExtractVue3Sfc() {
  const extractor = await loadExtractor('vue');
  const abs = path.join(__dirname, 'fixtures/vue3/Button.vue');
  const components = extractor.extractComponents(abs);
  const button = components.Button;

  assert.ok(button, 'missing Vue Button');
  assert.strictEqual(button.exportType, 'default');
  assert.deepStrictEqual(button.props.variant, {
    type: 'enum',
    values: ['filled', 'outline'],
  });
  assert.deepStrictEqual(button.props.disabled, { type: 'boolean' });
  assert.deepStrictEqual(button.props.label, { type: 'string' });
  assert.deepStrictEqual(button.props.modelValue, { type: 'string' });
  assert.ok(!button.props.click, 'emits must not become props');
  assert.ok(!button.props.submit, 'emits must not become props');
  assert.ok(!button.props.default, 'slots must not become props');
  assert.ok(!button.props.prepend, 'slots must not become props');
  assert.ok(!button.props['aria-label'], 'accessibility passthrough must be omitted');
  assert.deepStrictEqual(
    [...button.ownedPropNames].sort(),
    ['disabled', 'label', 'modelValue', 'variant'],
  );
  console.log('extract Vue 3 SFC → PASS');
}

async function testExtractVue3Command() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-extract-vue3-'));
  const uiDir = path.join(__dirname, 'fixtures/vue3');
  const codeCache = path.join(dir, 'code-props-cache.json');

  await cmdExtractCode({
    'ui-dir': uiDir,
    'code-cache': codeCache,
    framework: 'vue',
    quiet: true,
  });

  const cache = JSON.parse(fs.readFileSync(codeCache, 'utf8'));
  const entry = Object.entries(cache).find(([filePath]) => filePath.endsWith('Button.vue'))?.[1];
  assert.ok(entry, 'shared cache missing Vue SFC');
  assert.strictEqual(entry.framework, 'vue');
  assert.ok(entry.components?.Button, 'shared cache missing Vue Button');
  console.log('extract Vue 3 command → PASS');
}

function loadSemanticFixture(name) {
  const dir = path.join(__dirname, 'fixtures', name);
  return {
    matched: JSON.parse(fs.readFileSync(path.join(dir, '_figma-props-matched.json'), 'utf8')),
    raw: JSON.parse(fs.readFileSync(path.join(dir, '_figma-props-raw.json'), 'utf8')),
    codeRaw: JSON.parse(fs.readFileSync(path.join(dir, '_code-props-raw.json'), 'utf8')),
  };
}

function stageFinalizeProject(fixtureName = 'good-matched') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-finalize-'));
  const cacheDir = path.join(dir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const fixtureDir = path.join(__dirname, 'fixtures', fixtureName);
  for (const file of [
    '_figma-props-raw.json',
    '_figma-props-matched.json',
  ]) {
    fs.copyFileSync(path.join(fixtureDir, file), path.join(cacheDir, file));
  }
  const codeRaw = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, '_code-props-raw.json'), 'utf8'),
  );
  const sharedCachePath = path.join(dir, '.figma', 'cache', 'code-props-cache.json');
  fs.mkdirSync(path.dirname(sharedCachePath), { recursive: true });
  const sharedCache = {};
  for (const [componentName, component] of Object.entries(codeRaw.components ?? {})) {
    sharedCache[component.file] ??= {
      hash: 'fixture',
      framework: 'react',
      extractorVersion: EXTRACTOR_VERSION,
      extractedAt: '2026-07-26T00:00:00Z',
      components: {},
    };
    sharedCache[component.file].components[componentName] = {
      exportType: component.exportType ?? 'named',
      props: component.props,
      ownedPropNames: Object.keys(component.props ?? {}),
    };
  }
  fs.writeFileSync(sharedCachePath, JSON.stringify(sharedCache));
  const registryDir = path.join(dir, 'registry');
  fs.mkdirSync(registryDir, { recursive: true });
  return { dir, cacheDir, registryDir, sharedCachePath };
}

async function runFinalize(args) {
  let exitCode = 0;
  const origExit = process.exit;
  const logs = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...items) => logs.push(items.join(' '));
  console.error = (...items) => logs.push(items.join(' '));
  process.exit = (code) => {
    exitCode = code ?? 0;
    throw new Error(`exit:${exitCode}`);
  };
  try {
    await cmdFinalize({
      ...args,
      'code-cache':
        args['code-cache'] ??
        (args['project-root']
          ? path.join(args['project-root'], '.figma', 'cache', 'code-props-cache.json')
          : undefined),
    });
  } catch (error) {
    if (!String(error?.message ?? error).startsWith('exit:')) throw error;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origError;
  }
  return { exitCode, output: logs.join('\n') };
}

async function testFinalizeHappyPath() {
  const { dir, cacheDir, registryDir } = stageFinalizeProject();
  const { exitCode, output } = await runFinalize({
    'cache-dir': cacheDir,
    'project-root': dir,
  });

  assert.strictEqual(exitCode, 0, output);
  const registryPath = path.join(registryDir, 'ui', 'Button.json');
  assert.ok(fs.existsSync(registryPath), 'missing registry/ui/Button.json');
  const entry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.strictEqual(entry.schemaVersion, 2);
  assert.strictEqual(entry.component.exportName, 'Button');
  assert.ok(Array.isArray(entry.figmaBindings) && entry.figmaBindings.length > 0);
  assert.strictEqual(entry.figmaBindings[0].mappingKind, 'direct');
  assert.ok(Object.keys(entry.codePropsMap ?? {}).length > 0, 'missing codePropsMap');

  assert.ok(!fs.existsSync(cacheDir), 'successful finalize must remove cycle artifacts');
  assert.ok(
    !fs.existsSync(path.join(cacheDir, '_code-props-raw.json')),
    'finalize must not require _code-props-raw.json',
  );
  assert.ok(output.includes('Cycle cache cleaned'), `expected cleanup log; output:\n${output}`);
  console.log('finalize happy path → PASS');
}

async function testFinalizePruneRejected() {
  const { dir, cacheDir } = stageFinalizeProject();
  const { exitCode, output } = await runFinalize({
    'cache-dir': cacheDir,
    'project-root': dir,
    prune: true,
  });

  assert.strictEqual(exitCode, 1, `expected exit 1; output:\n${output}`);
  assert.ok(output.includes('prune not supported'), `expected prune message; output:\n${output}`);
  for (const file of ['_figma-props-raw.json', '_figma-props-matched.json']) {
    assert.ok(fs.existsSync(path.join(cacheDir, file)), `cache missing ${file}`);
  }
  console.log('finalize prune rejected → PASS');
}

function testFinalizeRequiresCachedFramework() {
  const { dir, cacheDir, sharedCachePath } = stageFinalizeProject();
  const cache = JSON.parse(fs.readFileSync(sharedCachePath, 'utf8'));
  for (const entry of Object.values(cache)) delete entry.framework;
  fs.writeFileSync(sharedCachePath, JSON.stringify(cache));
  const script = path.join(__dirname, 'figma-component-registry.mjs');
  const result = spawnSync(
    'node',
    [
      script,
      'finalize',
      '--cache-dir',
      cacheDir,
      '--project-root',
      dir,
    ],
    { encoding: 'utf8', cwd: dir },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  assert.notStrictEqual(result.status, 0, `expected missing cache framework failure:\n${output}`);
  assert.ok(output.includes('framework'), `expected framework error:\n${output}`);
  assert.ok(fs.existsSync(cacheDir), 'failed finalize removed cycle cache');
  console.log('finalize requires cached framework → PASS');
}

async function testFinalizeCarriedForwardMissing() {
  const { dir, cacheDir } = stageFinalizeProject();
  const first = await runFinalize({ 'cache-dir': cacheDir, 'project-root': dir });
  assert.strictEqual(first.exitCode, 0, first.output);

  const secondRaw = {
    fileKey: 'abc123',
    fetchedAt: '2026-07-06T10:00:00Z',
    components: [
      {
        name: 'btn-size',
        figmaNodeId: '18:3773',
        type: 'COMPONENT_SET',
        propertyDefinitions: {
          Size: { type: 'VARIANT', variantOptions: ['Small', 'Large'] },
        },
      },
    ],
  };
  const secondMatched = {
    schemaVersion: 2,
    fileKey: 'abc123',
    components: [
      {
        codeComponent: 'Button',
        codeFile: 'src/components/ui/button.tsx',
        groups: [
          {
            figmaNodeId: '18:3773',
            name: 'btn-size',
            mappings: [
              {
                figmaProp: 'Size',
                figmaType: 'VARIANT',
                mappingKind: 'direct',
                prop: 'size',
                valueMap: { Small: 'sm', Large: 'lg' },
              },
            ],
          },
        ],
      },
    ],
  };
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, '_figma-props-raw.json'), JSON.stringify(secondRaw));
  fs.writeFileSync(path.join(cacheDir, '_figma-props-matched.json'), JSON.stringify(secondMatched));

  const second = await runFinalize({
    'cache-dir': cacheDir,
    'project-root': dir,
    fetchDefinitionGroups: async () => [],
  });

  assert.strictEqual(second.exitCode, 1, `expected exit 1; output:\n${second.output}`);
  assert.ok(
    second.output.includes('carried-forward group') &&
      second.output.includes('no longer exists in Figma'),
    `expected carried-forward missing message; output:\n${second.output}`,
  );
  console.log('finalize carried-forward missing → PASS');
}

function testRecoverMultiGroupNodeIds() {
  const entry = {
    schemaVersion: 2,
    component: { exportName: 'Button', exportType: 'named', filePath: 'ui/button.tsx' },
    figma: { componentPath: 'Button', lastKnownNodeId: '1:1' },
    codePropsMap: {},
    figmaBindings: [
      {
        path: 'Button > group-a > Size',
        figmaNodeId: '1:1',
        figmaType: 'VARIANT',
        mappingKind: 'direct',
        prop: 'size',
      },
      {
        path: 'Button > group-b > Label',
        figmaNodeId: '1:2',
        figmaType: 'TEXT',
        mappingKind: 'direct',
        prop: 'label',
      },
    ],
  };
  const raw = {
    components: [
      { name: 'group-a', figmaNodeId: '1:1', propertyDefinitions: { Size: {} } },
      { name: 'group-b', figmaNodeId: '1:2', propertyDefinitions: { Label: {} } },
    ],
  };
  const groups = recoverGroupsFromRegistry(entry, raw);
  assert.strictEqual(groups.length, 2);
  const byId = new Map(groups.map((group) => [group.figmaNodeId, group]));
  assert.strictEqual(byId.get('1:1')?.name, 'group-a');
  assert.strictEqual(byId.get('1:2')?.name, 'group-b');
  assert.strictEqual(byId.get('1:1')?.mappings.length, 1);
  assert.strictEqual(byId.get('1:2')?.mappings.length, 1);
  console.log('recover multi-group node ids → PASS');
}

async function testFinalizeIncompatibleRename() {
  const { dir, cacheDir } = stageFinalizeProject();
  const first = await runFinalize({ 'cache-dir': cacheDir, 'project-root': dir });
  assert.strictEqual(first.exitCode, 0, first.output);

  const secondRaw = {
    fileKey: 'abc123',
    fetchedAt: '2026-07-06T10:00:00Z',
    components: [
      {
        name: 'btn-size',
        figmaNodeId: '18:3773',
        type: 'COMPONENT_SET',
        propertyDefinitions: {
          Size: { type: 'VARIANT', variantOptions: ['Small', 'Large'] },
        },
      },
    ],
  };
  const secondMatched = {
    schemaVersion: 2,
    fileKey: 'abc123',
    components: [
      {
        codeComponent: 'Button',
        codeFile: 'src/components/ui/button.tsx',
        groups: [
          {
            figmaNodeId: '18:3773',
            name: 'btn-size',
            mappings: [
              {
                figmaProp: 'Size',
                figmaType: 'VARIANT',
                mappingKind: 'direct',
                prop: 'size',
                valueMap: { Small: 'sm', Large: 'lg' },
              },
            ],
          },
        ],
      },
    ],
  };
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, '_figma-props-raw.json'), JSON.stringify(secondRaw));
  fs.writeFileSync(path.join(cacheDir, '_figma-props-matched.json'), JSON.stringify(secondMatched));

  const renamedDefinitions = {
    name: 'btn-renamed',
    figmaNodeId: '28:518',
    type: 'COMPONENT_SET',
    propertyDefinitions: {
      'Show prepend#101:10': { type: 'BOOLEAN', defaultValue: false },
    },
  };

  const second = await runFinalize({
    'cache-dir': cacheDir,
    'project-root': dir,
    fetchDefinitionGroups: async (_fileKey, nodeIds) => {
      return nodeIds.includes('28:518') ? [renamedDefinitions] : [];
    },
  });

  assert.strictEqual(second.exitCode, 1, `expected exit 1; output:\n${second.output}`);
  assert.ok(
    second.output.includes('renamed in Figma with incompatible definitions'),
    `expected incompatible rename message; output:\n${second.output}`,
  );
  console.log('finalize incompatible rename → PASS');
}

async function testFinalizeSameIdRename() {
  const { dir, cacheDir, registryDir } = stageFinalizeProject();
  const first = await runFinalize({ 'cache-dir': cacheDir, 'project-root': dir });
  assert.strictEqual(first.exitCode, 0, first.output);

  const secondRaw = {
    fileKey: 'abc123',
    fetchedAt: '2026-07-06T10:00:00Z',
    components: [
      {
        name: 'btn-size',
        figmaNodeId: '18:3773',
        type: 'COMPONENT_SET',
        propertyDefinitions: {
          Size: { type: 'VARIANT', variantOptions: ['Small', 'Large'] },
        },
      },
    ],
  };
  const secondMatched = {
    schemaVersion: 2,
    fileKey: 'abc123',
    components: [
      {
        codeComponent: 'Button',
        codeFile: 'src/components/ui/button.tsx',
        groups: [
          {
            figmaNodeId: '18:3773',
            name: 'btn-size',
            mappings: [
              {
                figmaProp: 'Size',
                figmaType: 'VARIANT',
                mappingKind: 'direct',
                prop: 'size',
                valueMap: { Small: 'sm', Large: 'lg' },
              },
            ],
          },
        ],
      },
    ],
  };
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, '_figma-props-raw.json'), JSON.stringify(secondRaw));
  fs.writeFileSync(path.join(cacheDir, '_figma-props-matched.json'), JSON.stringify(secondMatched));

  const renamedDefinitions = {
    name: 'btn-renamed',
    figmaNodeId: '28:518',
    type: 'COMPONENT_SET',
    propertyDefinitions: {
      Size: { type: 'VARIANT', variantOptions: ['Small', 'Large'] },
      'Show prepend#101:10': { type: 'BOOLEAN', defaultValue: false },
    },
  };

  const second = await runFinalize({
    'cache-dir': cacheDir,
    'project-root': dir,
    fetchDefinitionGroups: async (_fileKey, nodeIds) => {
      return nodeIds.includes('28:518') ? [renamedDefinitions] : [];
    },
  });

  assert.strictEqual(second.exitCode, 0, second.output);
  const entry = JSON.parse(
    fs.readFileSync(path.join(registryDir, 'ui', 'Button.json'), 'utf8'),
  );
  const carriedBinding = entry.figmaBindings.find((binding) =>
    binding.path.includes('btn-renamed'),
  );
  assert.ok(carriedBinding, `expected binding with renamed group; bindings: ${JSON.stringify(entry.figmaBindings.map((b) => b.path))}`);
  assert.ok(
    entry.figmaBindings.some((binding) => binding.path.startsWith('Button > btn-size >')),
    'expected binding for new cycle group',
  );
  console.log('finalize same-id rename → PASS');
}

async function testFinalizeDryRun() {
  const { dir, cacheDir, registryDir } = stageFinalizeProject();
  const registryPath = path.join(registryDir, 'ui', 'Button.json');
  const existedBefore = fs.existsSync(registryPath);

  const { exitCode, output } = await runFinalize({
    'cache-dir': cacheDir,
    'project-root': dir,
    'dry-run': true,
  });

  assert.strictEqual(exitCode, 0, output);
  assert.strictEqual(
    fs.existsSync(registryPath),
    existedBefore,
    'dry-run must not create/modify the registry file',
  );
  assert.ok(output.includes('Dry run'), `expected dry-run summary; output:\n${output}`);
  assert.ok(output.includes('new file'), `expected new-file preview; output:\n${output}`);
  assert.ok(output.includes('--- registry (before)'), `expected unified diff old header; output:\n${output}`);
  assert.ok(output.includes('+++ registry (after)'), `expected unified diff new header; output:\n${output}`);
  assert.ok(output.includes('@@'), `expected unified diff hunk; output:\n${output}`);
  assert.ok(output.includes('"exportName": "Button"'), `expected JSON preview; output:\n${output}`);
  for (const file of ['_figma-props-raw.json', '_figma-props-matched.json']) {
    assert.ok(fs.existsSync(path.join(cacheDir, file)), `dry-run removed ${file}`);
  }
  console.log('finalize dry-run → PASS');
}

async function testExtractCodeQuietStale() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-quiet-'));
  const cacheDir = path.join(dir, 'cache');
  const uiDir = path.join(dir, 'ui');
  fs.mkdirSync(uiDir, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, 'fixtures/multi-component/input.tsx'),
    path.join(uiDir, 'input.tsx'),
  );
  const registryDir = path.join(dir, 'registry');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ dependencies: { react: '^19.0.0' } }),
  );
  fs.writeFileSync(
    path.join(registryDir, 'Input.json'),
    JSON.stringify({
      schemaVersion: 2,
      component: { exportName: 'Input', exportType: 'named', filePath: 'ui/input.tsx' },
      figma: { componentPath: 'Input' },
      codePropsMap: { forceState: { type: 'enum', values: ['stale-only'] } },
      figmaBindings: [],
    }),
  );

  const script = path.join(__dirname, 'figma-component-registry.mjs');
  const baseArgs = [
    script,
    'check',
    '--ui-dir',
    uiDir,
    '--project-root',
    dir,
    '--code-cache',
    path.join(cacheDir, 'code-props-cache.json'),
    '--fail-on-stale',
  ];

  const verboseResult = spawnSync('node', baseArgs, { encoding: 'utf8', cwd: dir });
  const quietResult = spawnSync('node', [...baseArgs, '--quiet'], { encoding: 'utf8', cwd: dir });

  const verboseOutput = `${verboseResult.stdout ?? ''}\n${verboseResult.stderr ?? ''}`;
  const quietOutput = `${quietResult.stdout ?? ''}\n${quietResult.stderr ?? ''}`;

  assert.notStrictEqual(quietResult.status, 0, `expected non-zero exit; output:\n${quietOutput}`);
  assert.ok(
    quietOutput.includes('stale registry codePropsMap'),
    `expected short stale summary; output:\n${quietOutput}`,
  );
  assert.ok(
    quietOutput.length < verboseOutput.length,
    `expected --quiet output shorter than default; quiet:\n${quietOutput}\n---\ndefault:\n${verboseOutput}`,
  );
  console.log('extract-code --quiet on stale → PASS');
}

function testSemanticGoodMatched() {
  const { matched, raw, codeRaw } = loadSemanticFixture('good-matched');
  const problems = validateMatchedSemantic(matched, raw, codeRaw);
  assert.deepStrictEqual(problems, []);
  console.log('semantic good matched → PASS');
}

function testSemanticUnknownProp() {
  const { matched, raw, codeRaw } = loadSemanticFixture('bad-unknown-prop');
  const problems = validateMatchedSemantic(matched, raw, codeRaw);
  assert.ok(
    problems.some((p) => p.includes('missingSize') && p.includes('missing from code API')),
  );
  console.log('semantic unknown prop → PASS');
}

function testSemanticValueCoverage() {
  const { matched, raw, codeRaw } = loadSemanticFixture('bad-value-coverage');
  const problems = validateMatchedSemantic(matched, raw, codeRaw);
  assert.ok(problems.some((p) => p.includes('missing Figma values')));
  console.log('semantic value coverage → PASS');
}

function testSemanticCompositionExactCandidate() {
  const { matched, raw, codeRaw } = loadSemanticFixture('good-matched');
  matched.components[0].groups[0].mappings[0] = {
    figmaProp: 'Size',
    figmaType: 'VARIANT',
    mappingKind: 'composition',
    note: 'Pretend there is no matching code prop.',
  };
  const problems = validateMatchedSemantic(matched, raw, codeRaw);
  assert.ok(problems.some((p) => p.includes('exact code prop candidate exists')));
  console.log('semantic composition exact candidate → PASS');
}

function testSemanticBundleMissingValueProps() {
  const { matched, raw, codeRaw } = loadSemanticFixture('good-matched');
  matched.components[0].groups[0].mappings = [
    {
      figmaProp: 'Checked?',
      figmaType: 'VARIANT',
      mappingKind: 'bundle',
      props: ['checked', 'indeterminate'],
    },
  ];
  raw.components[0].propertyDefinitions = {
    'Checked?': { type: 'VARIANT', variantOptions: ['True', 'False'] },
  };
  const problems = validateMatchedSemantic(matched, raw, codeRaw);
  assert.ok(problems.some((p) => p.includes('bundle needs valueProps')));
  console.log('semantic bundle missing valueProps → PASS');
}

function testSemanticRejectsRedundantValueMap() {
  const { matched, raw, codeRaw } = loadSemanticFixture('good-matched');
  raw.components[0].propertyDefinitions.Size.variantOptions = ['SM', 'LG'];
  matched.components[0].groups[0].mappings[0].valueMap = {
    SM: 'sm',
    LG: 'lg',
  };

  const problems = validateMatchedSemantic(matched, raw, codeRaw);
  assert.ok(problems.some((problem) => problem.includes('redundant valueMap')));
  console.log('semantic redundant valueMap → PASS');
}

function testMappingPropsResolveReportsAllMissing() {
  const group = {
    name: 'btn',
    mappings: [
      { figmaProp: 'Size', mappingKind: 'direct', prop: 'size' },
      { figmaProp: 'Show prepend#1:1', mappingKind: 'composition', note: 'x' },
      { figmaProp: 'Legacy axis', mappingKind: 'unsupported', note: 'y' },
    ],
  };
  const propertyDefinitions = { Size: { type: 'VARIANT' } };
  const missing = mappingPropsResolve(group, propertyDefinitions);
  assert.deepStrictEqual(missing, ['Show prepend#1:1', 'Legacy axis']);
  console.log('mappingPropsResolve reports all missing props → PASS');
}

const tests = [
  testShapeGood,
  testShapeBad,
  testCodePropsMapIncludesOnlyBoundProps,
  testCodePropsDriftIgnoresUnboundProps,
  testCodeRawPreservesUncertainCandidates,
  testFigmaCollectPrunesVariantMembers,
  testParallelCacheMerge,
  testCacheSkipsUnchangedWrite,
  testFigmaClientBatches,
  testFigmaClientRetries,
  testStripId,
  testFlattenBundle,
  testIsPathUnderDirNormalizesSeparators,
  testRegistryPath,
  testRegistryPathRejectsTraversalExportName,
  testMergeGroups,
  testRegistryLookupFindsUniqueMatch,
  testRegistryLookupFailsLoudOnCollision,
  testRecoverMultiGroupNodeIds,
  testMappingPropsResolveReportsAllMissing,
  testFailOnStaleCodePropsMap,
  testExtractCodeCommand,
  testExtractCodeDetectsFrameworkWithoutConfig,
  testExtractCodeRejectsMixedFrameworkRoot,
  testExtractMulti,
  testReactExtractorExcludesOnlyConfirmedNoise,
  testExtractVue3Sfc,
  testExtractVue3Command,
  testSemanticGoodMatched,
  testSemanticUnknownProp,
  testSemanticValueCoverage,
  testSemanticCompositionExactCandidate,
  testSemanticBundleMissingValueProps,
  testSemanticRejectsRedundantValueMap,
  testFinalizeHappyPath,
  testFinalizePruneRejected,
  testFinalizeRequiresCachedFramework,
  testFinalizeCarriedForwardMissing,
  testFinalizeIncompatibleRename,
  testFinalizeSameIdRename,
  testFinalizeDryRun,
  testExtractCodeQuietStale,
];

async function runAll() {
  const failures = [];
  for (const t of tests) {
    try {
      await t();
    } catch (err) {
      failures.push({ name: t.name || '(anonymous test)', err });
      console.error(`✗ ${t.name || '(anonymous test)'} FAILED`);
      console.error(err);
    }
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length}/${tests.length} test(s) failed:`);
    for (const { name } of failures) console.error(`  - ${name}`);
    throw new Error(`${failures.length}/${tests.length} test(s) failed`);
  }
}

export { tests, runAll };

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runAll().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
