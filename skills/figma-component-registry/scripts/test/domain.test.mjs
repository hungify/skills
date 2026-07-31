import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodeRawFromCache } from '../lib/commands/extract-code.mjs';
import { checkCodePropsDrift } from '../lib/domain/check-code-drift.mjs';
import { toCodePropsMap } from '../lib/domain/code-props-map.mjs';
import { collectComponents } from '../lib/domain/figma-collect.mjs';
import { frameworkFromCodeCache } from '../lib/domain/framework.mjs';
import {
  flattenGroupsToBindings,
  mapKind,
} from '../lib/domain/flatten-bindings.mjs';
import { mergeGroups } from '../lib/domain/merge-groups.mjs';
import { recoverGroupsFromRegistry } from '../lib/domain/recover-groups.mjs';
import { findRegistryEntryByExportName } from '../lib/domain/registry-lookup.mjs';
import {
  stripFigmaPropId,
  bindingPath,
} from '../lib/domain/path-normalize.mjs';
import { registryFilePath } from '../lib/domain/registry-path.mjs';
import { isPathUnderDir } from '../lib/paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.join(__dirname, '..');

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
      schemaVersion: 3,
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
// Final whole-branch review finding 2: `checkCodePropsDrift` reads the registry entry directly
// and never called `recoverGroupsFromRegistry`, so Task 7's schemaVersion guard never applied
// to it — a schemaVersion-2 entry whose bindings still carry the shared v2/v3 `prop`/`props`
// fields could hash-match the current extraction and be reported clean. `check` must reject
// non-v3 entries just like `finalize` does, even when the codePropsMap hash would otherwise match.
function testCodeDriftRejectsSchemaV2EvenWithoutHashDrift() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-schema-drift-'));
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
      // Deliberately identical to the registry's codePropsMap above — the hash would match
      // and report "no drift" if schemaVersion weren't checked independently of the hash.
      props: { forceState: { type: 'enum', values: ['hover', 'focus'] } },
    },
  };
  const options = { projectRoot: dir, registryRoot: 'registry', sourceRoot: 'ui' };

  const stale = checkCodePropsDrift(components, options);
  assert.strictEqual(
    stale.length,
    1,
    `expected schemaVersion staleness even with matching codePropsMap hash; stale:\n${JSON.stringify(stale)}`,
  );
  assert.ok(
    stale[0].includes('schemaVersion 2, expected 3'),
    `expected schemaVersion message; got: ${stale[0]}`,
  );
  console.log('checkCodePropsDrift rejects schemaVersion 2 even without hash drift → PASS');
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
  const bindings = flattenGroupsToBindings({
    componentPath: 'Button',
    groups: [
      {
        name: 'btn-size',
        mappings: [
          {
            figmaProp: 'Show prepend#529:0',
            figmaType: 'BOOLEAN',
            mappingKind: 'composition',
            note: 'x',
          },
        ],
      },
    ],
  });
  assert.strictEqual(bindings[0].propName, 'Show prepend');
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
  assert.strictEqual(bindings[0].componentPath, 'Checkbox');
  assert.strictEqual(bindings[0].groupName, 'Checkbox');
  assert.strictEqual(bindings[0].propName, 'Checked?');
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
function testRegistryPathRejectsFilePathOutsideSourceRoot() {
  assert.throws(
    () =>
      registryFilePath({
        projectRoot: '/repo',
        registryRoot: 'registry',
        sourceRoot: 'src/components',
        filePath: 'src/other/button.tsx',
        exportName: 'Button',
      }),
    /is not under sourceRoot/,
  );
  console.log('registry path rejects filePath outside sourceRoot → PASS');
}
// Reviewer finding: registryFilePath hand-rolled a path-traversal check (`rel.startsWith('..')`)
// that was stricter than necessary — it rejected any relative path merely starting with the two
// characters "..", including a legitimate directory name like "..foo" that isn't a traversal at
// all. Switching to the shared isPathUnderDir helper (already used elsewhere for the same class
// of check) fixes this false rejection while still catching real traversal (see previous test).
function testRegistryPathAcceptsDotDotPrefixedDirName() {
  const p = registryFilePath({
    projectRoot: '/repo',
    registryRoot: 'registry',
    sourceRoot: 'src/components',
    filePath: 'src/components/..foo/button.tsx',
    exportName: 'Button',
  });
  assert.strictEqual(p, path.join('/repo', 'registry', '..foo', 'Button.json'));
  console.log('registry path accepts legit ..-prefixed dir name → PASS');
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
function testRegistryLookupDisambiguatesCollisionByPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-lookup-path-'));
  const uiPath = path.join(dir, 'registry', 'ui', 'Button.json');
  const marketingPath = path.join(dir, 'registry', 'marketing', 'Button.json');
  fs.mkdirSync(path.dirname(uiPath), { recursive: true });
  fs.mkdirSync(path.dirname(marketingPath), { recursive: true });
  fs.writeFileSync(uiPath, JSON.stringify({ component: { exportName: 'Button' } }));
  fs.writeFileSync(marketingPath, JSON.stringify({ component: { exportName: 'Button' } }));

  assert.strictEqual(
    findRegistryEntryByExportName(dir, 'registry', 'ui/Button.json')?.filePath,
    uiPath,
  );
  assert.strictEqual(
    findRegistryEntryByExportName(dir, 'registry', 'registry/marketing/Button.json')?.filePath,
    marketingPath,
  );
  assert.strictEqual(
    findRegistryEntryByExportName(dir, 'registry', marketingPath)?.filePath,
    marketingPath,
  );
  assert.throws(
    () => findRegistryEntryByExportName(dir, 'registry', '../outside.json'),
    /outside/,
  );
  console.log('registry lookup disambiguates collision by path → PASS');
}
// Reviewer finding: frameworkFromCodeCache matched cache-entry paths against sourceRoot with a
// raw string prefix check instead of the path-normalizing isPathUnderDir helper used elsewhere
// (e.g. buildCodeRawFromCache). An absolute --ui-dir at extract-code time (absolute cache keys)
// combined with the default relative --source-root at finalize time never matched, so finalize
// threw "must contain exactly one framework" even though the cache had valid data.
function testFrameworkFromCodeCacheHandlesAbsoluteCacheKeys() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-framework-'));
  const origCwd = process.cwd();
  process.chdir(dir);
  try {
    // Resolve through process.cwd() (not the pre-chdir `dir` value) so this doesn't trip over
    // macOS's /tmp -> /private/tmp symlink: cwd resolves through it, a raw `dir`-based path won't.
    const absFile = path.join(process.cwd(), 'src', 'components', 'Button.tsx');
    const cache = { [absFile]: { framework: 'react' } };
    const framework = frameworkFromCodeCache(cache, 'src/components');
    assert.strictEqual(framework, 'react');
  } finally {
    process.chdir(origCwd);
  }
  console.log('frameworkFromCodeCache resolves absolute cache keys against relative sourceRoot → PASS');
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
function testRecoverMultiGroupNodeIds() {
  const entry = {
    schemaVersion: 3,
    component: { exportName: 'Button', exportType: 'named', filePath: 'ui/button.tsx' },
    figma: { componentPath: 'Button', lastKnownNodeId: '1:1' },
    codePropsMap: {},
    figmaBindings: [
      {
        path: 'Button > group-a > Size',
        componentPath: 'Button',
        groupName: 'group-a',
        propName: 'Size',
        figmaNodeId: '1:1',
        figmaType: 'VARIANT',
        mappingKind: 'direct',
        prop: 'size',
      },
      {
        path: 'Button > group-b > Label',
        componentPath: 'Button',
        groupName: 'group-b',
        propName: 'Label',
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
function testRecoverGroupsSurvivesGtInName() {
  const entry = {
    schemaVersion: 3,
    component: { exportName: 'Icon', exportType: 'named', filePath: 'ui/icon.tsx' },
    figma: { componentPath: 'Icon', lastKnownNodeId: '1:1' },
    codePropsMap: {},
    figmaBindings: [
      {
        path: 'Icon > Icon > Leading',
        componentPath: 'Icon',
        groupName: 'Icon > Leading',
        propName: 'Size',
        figmaNodeId: '1:1',
        figmaType: 'VARIANT',
        mappingKind: 'direct',
        prop: 'size',
      },
    ],
  };
  const raw = {
    components: [
      { name: 'Icon > Leading', figmaNodeId: '1:1', propertyDefinitions: { Size: {} } },
    ],
  };
  const groups = recoverGroupsFromRegistry(entry, raw);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].name, 'Icon > Leading');
  assert.strictEqual(groups[0].mappings[0].figmaProp, 'Size');
  console.log('recover groups survives > in group name → PASS');
}
function testRecoverGroupsRejectsOldSchemaVersion() {
  const oldEntry = {
    schemaVersion: 2,
    component: { exportName: 'Button', exportType: 'named', filePath: 'ui/button.tsx' },
    figma: { componentPath: 'Button', lastKnownNodeId: '1:1' },
    codePropsMap: {},
    figmaBindings: [
      { path: 'Button > btn > Size', figmaType: 'VARIANT', mappingKind: 'direct', prop: 'size' },
    ],
  };
  assert.throws(
    () => recoverGroupsFromRegistry(oldEntry, { components: [] }),
    /schemaVersion 2, expected 3/,
  );
  console.log('recover groups rejects old schemaVersion → PASS');
}


export const tests = [
  testCodePropsMapIncludesOnlyBoundProps,
  testCodePropsDriftIgnoresUnboundProps,
  testCodeDriftRejectsSchemaV2EvenWithoutHashDrift,
  testCodeRawPreservesUncertainCandidates,
  testFigmaCollectPrunesVariantMembers,
  testStripId,
  testFlattenBundle,
  testIsPathUnderDirNormalizesSeparators,
  testRegistryPath,
  testRegistryPathRejectsTraversalExportName,
  testRegistryPathRejectsFilePathOutsideSourceRoot,
  testRegistryPathAcceptsDotDotPrefixedDirName,
  testRegistryLookupFindsUniqueMatch,
  testRegistryLookupFailsLoudOnCollision,
  testRegistryLookupDisambiguatesCollisionByPath,
  testFrameworkFromCodeCacheHandlesAbsoluteCacheKeys,
  testMergeGroups,
  testRecoverMultiGroupNodeIds,
  testRecoverGroupsSurvivesGtInName,
  testRecoverGroupsRejectsOldSchemaVersion,
];
