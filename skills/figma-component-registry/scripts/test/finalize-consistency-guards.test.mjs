import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stageFinalizeProject, runFinalize } from './helpers/finalize.mjs';

// Reviewer finding: the write path never checked whether the on-disk registry entry at
// registryFilePath belongs to a different source file before merging its groups into a new
// cycle's entry — a same-run duplicate exportName was caught by validateMatchedSemantic, but
// two SEPARATE finalize cycles (e.g. Button.tsx then, later, Button2.tsx also exporting
// `Button`) hit the identical registry/ui/Button.json and would silently merge one component's
// Figma bindings into the other's entry. This test reproduces the two-cycle collision.
async function testFinalizeCollisionAcrossRuns() {
  const { dir, cacheDir, registryDir, sharedCachePath } = stageFinalizeProject();
  const first = await runFinalize({ 'cache-dir': cacheDir, 'project-root': dir });
  assert.strictEqual(first.exitCode, 0, first.output);
  assert.ok(fs.existsSync(path.join(registryDir, 'ui', 'Button.json')));

  const altFile = 'src/components/ui/button-alt.tsx';
  const cache = JSON.parse(fs.readFileSync(sharedCachePath, 'utf8'));
  const original = cache['src/components/ui/button.tsx'];
  cache[altFile] = {
    ...original,
    components: { Button: { ...original.components.Button } },
  };
  fs.writeFileSync(sharedCachePath, JSON.stringify(cache));

  const secondRaw = {
    fileKey: 'abc123',
    fetchedAt: '2026-07-06T10:00:00Z',
    components: [
      {
        name: 'btn',
        figmaNodeId: '28:518',
        type: 'COMPONENT_SET',
        propertyDefinitions: {
          Size: { type: 'VARIANT', variantOptions: ['Small', 'Large'] },
          'Show prepend#101:10': { type: 'BOOLEAN', defaultValue: false },
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
        codeFile: altFile,
        groups: [
          {
            figmaNodeId: '28:518',
            name: 'btn',
            mappings: [
              {
                figmaProp: 'Size',
                figmaType: 'VARIANT',
                mappingKind: 'direct',
                prop: 'size',
                valueMap: { Small: 'sm', Large: 'lg' },
              },
              {
                figmaProp: 'Show prepend#101:10',
                figmaType: 'BOOLEAN',
                mappingKind: 'composition',
                note: 'Leading icon child only; no Button prop.',
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

  const second = await runFinalize({ 'cache-dir': cacheDir, 'project-root': dir });

  assert.strictEqual(second.exitCode, 1, `expected exit 1; output:\n${second.output}`);
  assert.ok(
    second.output.includes('already belongs to a different source file'),
    `expected cross-run collision message; output:\n${second.output}`,
  );
  console.log('finalize rejects cross-run exportName collision → PASS');
}
async function testFinalizeAcceptsEquivalentSourcePathRepresentations() {
  const { dir, cacheDir, registryDir } = stageFinalizeProject();
  const rawText = fs.readFileSync(path.join(cacheDir, '_figma-props-raw.json'), 'utf8');
  const matchedText = fs.readFileSync(path.join(cacheDir, '_figma-props-matched.json'), 'utf8');
  const first = await runFinalize({ 'cache-dir': cacheDir, 'project-root': dir });
  assert.strictEqual(first.exitCode, 0, first.output);

  const registryPath = path.join(registryDir, 'ui', 'Button.json');
  const entry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  entry.component.filePath = path.resolve(dir, entry.component.filePath);
  fs.writeFileSync(registryPath, JSON.stringify(entry));
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, '_figma-props-raw.json'), rawText);
  fs.writeFileSync(path.join(cacheDir, '_figma-props-matched.json'), matchedText);

  const second = await runFinalize({ 'cache-dir': cacheDir, 'project-root': dir });
  assert.strictEqual(second.exitCode, 0, second.output);
  console.log('finalize accepts equivalent source path representations → PASS');
}
// Reviewer finding: carried-forward group definitions were resolved against the OLD
// existing.figma.lastKnownFileKey, but the NEW raw.fileKey was persisted into the entry
// regardless — silently mixing groups from two different Figma files under one fileKey. This
// test asserts finalize now fails loud instead when the cycle's raw data is fetched from a
// different Figma file than the registry's last-known one while groups are being carried
// forward.
async function testFinalizeFileKeyMismatchOnCarryForward() {
  const { dir, cacheDir, registryDir } = stageFinalizeProject();
  const first = await runFinalize({ 'cache-dir': cacheDir, 'project-root': dir });
  assert.strictEqual(first.exitCode, 0, first.output);
  assert.ok(fs.existsSync(path.join(registryDir, 'ui', 'Button.json')));

  const secondRaw = {
    fileKey: 'xyz789',
    fetchedAt: '2026-07-06T10:00:00Z',
    components: [
      {
        name: 'btn-v2',
        figmaNodeId: '99:999',
        type: 'COMPONENT_SET',
        propertyDefinitions: {
          Size: { type: 'VARIANT', variantOptions: ['Small', 'Large'] },
        },
      },
    ],
  };
  const secondMatched = {
    schemaVersion: 2,
    fileKey: 'xyz789',
    components: [
      {
        codeComponent: 'Button',
        codeFile: 'src/components/ui/button.tsx',
        groups: [
          {
            figmaNodeId: '99:999',
            name: 'btn-v2',
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

  const second = await runFinalize({ 'cache-dir': cacheDir, 'project-root': dir });

  assert.strictEqual(second.exitCode, 1, `expected exit 1; output:\n${second.output}`);
  assert.ok(
    second.output.includes('carrying forward group(s) resolved against Figma file abc123') &&
      second.output.includes('this cycle fetched xyz789'),
    `expected fileKey-mismatch message; output:\n${second.output}`,
  );
  console.log('finalize fails loud on fileKey mismatch with carried-forward groups → PASS');
}
// Reviewer finding: when a carried-forward group's figmaNodeId IS present in the current
// cycle's raw fetch, definitionsForMergedGroups used the stale cached group.name instead of
// the live rawComponent.name, so a Figma rename could never be detected/applied through this
// path (only the separate "not found in current fetch" carried-forward-fetch path worked,
// already covered by testFinalizeSameIdRename). This test renames the *same* figmaNodeId in
// the current fetch and asserts the new name is written to the registry.
async function testFinalizeRenameDetectedWhenGroupInCurrentFetch() {
  const { dir, cacheDir, registryDir } = stageFinalizeProject();
  const first = await runFinalize({ 'cache-dir': cacheDir, 'project-root': dir });
  assert.strictEqual(first.exitCode, 0, first.output);

  const secondRaw = {
    fileKey: 'abc123',
    fetchedAt: '2026-07-06T10:00:00Z',
    components: [
      {
        name: 'btn-renamed-live',
        figmaNodeId: '28:518',
        type: 'COMPONENT_SET',
        propertyDefinitions: {
          Size: { type: 'VARIANT', variantOptions: ['Small', 'Large'] },
          'Show prepend#101:10': { type: 'BOOLEAN', defaultValue: false },
        },
      },
      {
        name: 'btn-2',
        figmaNodeId: '30:1',
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
            figmaNodeId: '30:1',
            name: 'btn-2',
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

  const second = await runFinalize({ 'cache-dir': cacheDir, 'project-root': dir });

  assert.strictEqual(second.exitCode, 0, second.output);
  const entry = JSON.parse(fs.readFileSync(path.join(registryDir, 'ui', 'Button.json'), 'utf8'));
  assert.ok(
    entry.figmaBindings.some((binding) => binding.groupName === 'btn-renamed-live'),
    `expected carried-forward group's live rename to be applied; bindings: ${JSON.stringify(entry.figmaBindings.map((b) => b.groupName))}`,
  );
  assert.ok(
    !entry.figmaBindings.some((binding) => binding.groupName === 'btn'),
    'expected stale pre-rename group name to be gone',
  );
  console.log('finalize applies rename when group appears in current raw fetch → PASS');
}

export const tests = [
  testFinalizeCollisionAcrossRuns,
  testFinalizeAcceptsEquivalentSourcePathRepresentations,
  testFinalizeFileKeyMismatchOnCarryForward,
  testFinalizeRenameDetectedWhenGroupInCurrentFetch,
];
