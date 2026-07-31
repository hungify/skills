import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRegistryLock } from '../lib/infra/registry-lock.mjs';
import { stageFinalizeProject, runFinalize } from './helpers/finalize.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.join(__dirname, '..');

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
  assert.strictEqual(entry.schemaVersion, 3);
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
  const script = path.join(SCRIPTS_DIR, 'figma-component-registry.mjs');
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
// Note: deviates from the task brief's originally-proposed fixture. A same-cycle removal of
// a code prop referenced by `matched.json` is already caught earlier by `validateMatchedSemantic`
// (prop "X" missing from code API), before `cmdFinalize`'s loop ever calls `toCodePropsMap` — so
// that scenario can't exercise the new try/catch at all. The real gap `toCodePropsMap`'s catch
// closes is a *carried-forward* group (recovered from a previous registry entry, not part of the
// current cycle's `matched.json`) whose bound code prop was removed since it was first written —
// `validateMatchedSemantic` only validates the current cycle's `matched`, so it never re-checks
// carried-forward bindings. This test reproduces that: cycle 1 finalizes the `btn` group (binding
// `size`); cycle 2 only introduces an unrelated `btn-extra` group while the code prop `size` is
// deleted from the shared cache — the carried-forward `btn` group's stale `size` binding is what
// must surface as a clean `ERROR: Button: …` error instead of an uncaught stack trace.
async function testFinalizeReportsPropRemovalCleanly() {
  const { dir, cacheDir, sharedCachePath, registryDir } = stageFinalizeProject();
  const first = await runFinalize({ 'cache-dir': cacheDir, 'project-root': dir });
  assert.strictEqual(first.exitCode, 0, first.output);
  assert.ok(
    fs.existsSync(path.join(registryDir, 'ui', 'Button.json')),
    'expected cycle 1 to write the registry entry carried forward into cycle 2',
  );

  const cache = JSON.parse(fs.readFileSync(sharedCachePath, 'utf8'));
  for (const entry of Object.values(cache)) {
    for (const component of Object.values(entry.components ?? {})) {
      delete component.props.size; // remove the code prop the carried-forward `btn` group binds to
    }
  }
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
      {
        name: 'btn-extra',
        figmaNodeId: '99:1',
        type: 'COMPONENT_SET',
        propertyDefinitions: {
          Extra: { type: 'BOOLEAN', defaultValue: false },
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
            figmaNodeId: '99:1',
            name: 'btn-extra',
            mappings: [
              {
                figmaProp: 'Extra',
                figmaType: 'BOOLEAN',
                mappingKind: 'unsupported',
                note: 'not wired up yet',
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

  const { exitCode, output } = await runFinalize({ 'cache-dir': cacheDir, 'project-root': dir });

  assert.strictEqual(exitCode, 1, `expected exit 1; output:\n${output}`);
  assert.ok(output.includes('ERROR: Button:'), `expected clean component-scoped error; output:\n${output}`);
  assert.ok(
    output.includes('missing code prop "size"'),
    `expected prop-removal message; output:\n${output}`,
  );
  assert.ok(
    !output.toLowerCase().includes('at object.<anonymous>') && !output.includes('.mjs:'),
    `expected no raw stack trace; output:\n${output}`,
  );
  console.log('finalize reports prop-removal drift cleanly → PASS');
}
// Reviewer finding: definitionsForMergedGroups (inside the lock) can call out to the Figma API
// with retries, holding the critical section for seconds under real latency — meanwhile
// withRegistryLock's own retry budget (~4.5s) can be exhausted by a second concurrent finalize,
// causing lockfile.lock() to reject with an ELOCKED error. That rejection previously propagated
// uncaught out of cmdFinalize to the top-level main().catch, printing a raw stack trace — the
// exact failure mode this task exists to eliminate. This test forces that condition
// deterministically: it holds the lock open (never resolving the callback) and passes
// `registryLockOptions: { retries: 0 }` so the contended attempt fails immediately instead of
// waiting out the real ~4.5s retry budget.
async function testFinalizeReportsLockContentionCleanly() {
  const { dir, cacheDir, registryDir } = stageFinalizeProject();
  const target = path.join(registryDir, 'ui', 'Button.json');

  let releaseHeld;
  const heldLockPromise = withRegistryLock(
    target,
    () => new Promise((resolve) => { releaseHeld = resolve; }),
  );
  // Give the held lock time to actually acquire before racing the contended attempt.
  await new Promise((r) => setTimeout(r, 50));

  try {
    const { exitCode, output } = await runFinalize({
      'cache-dir': cacheDir,
      'project-root': dir,
      registryLockOptions: { retries: 0 },
    });

    assert.strictEqual(exitCode, 1, `expected exit 1; output:\n${output}`);
    assert.ok(
      output.includes('ERROR: Button:'),
      `expected clean component-scoped error; output:\n${output}`,
    );
    assert.ok(
      output.toLowerCase().includes('lock'),
      `expected lock-contention message; output:\n${output}`,
    );
    assert.ok(
      !output.toLowerCase().includes('at object.<anonymous>') && !output.includes('.mjs:'),
      `expected no raw stack trace; output:\n${output}`,
    );
  } finally {
    releaseHeld();
    await heldLockPromise;
  }
  console.log('finalize reports lock contention cleanly → PASS');
}
// Final whole-branch review finding 1: `recoverGroupsFromRegistry`'s throw (Task 7's
// schemaVersion guard) was the one throw site inside `withRegistryLock`'s callback that Task 8
// did NOT wrap in try/catch, unlike its two neighbors (`definitionsForMergedGroups`,
// `toCodePropsMap`). A host project with a pre-existing schemaVersion-2 registry entry is
// exactly the documented upgrade scenario, so it must fail with the same clean, component-scoped
// message as its neighbors — not an uncaught stack trace out of `withRegistryLock`.
async function testFinalizeReportsSchemaV2UpgradeCleanly() {
  const { dir, cacheDir, registryDir } = stageFinalizeProject();
  const registryPath = path.join(registryDir, 'ui', 'Button.json');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      schemaVersion: 2,
      component: { exportName: 'Button', exportType: 'named', filePath: 'src/components/ui/button.tsx' },
      figma: { componentPath: 'Button', lastKnownNodeId: '28:518' },
      codePropsMap: { size: { type: 'enum', values: ['sm', 'lg'] } },
      figmaBindings: [
        {
          path: 'Button > btn > Size',
          figmaType: 'VARIANT',
          mappingKind: 'direct',
          prop: 'size',
        },
      ],
    }),
  );

  const { exitCode, output } = await runFinalize({ 'cache-dir': cacheDir, 'project-root': dir });

  assert.strictEqual(exitCode, 1, `expected exit 1; output:\n${output}`);
  assert.ok(output.includes('ERROR: Button:'), `expected clean component-scoped error; output:\n${output}`);
  assert.ok(
    output.includes('schemaVersion 2, expected 3'),
    `expected schemaVersion upgrade message; output:\n${output}`,
  );
  assert.ok(
    !output.toLowerCase().includes('at object.<anonymous>') && !output.includes('.mjs:'),
    `expected no raw stack trace; output:\n${output}`,
  );
  console.log('finalize reports schemaVersion v2 upgrade cleanly → PASS');
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
  assert.ok(output.includes('DRY-RUN:'), `expected dry-run summary; output:\n${output}`);
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
// Reviewer finding: withRegistryLock unconditionally ensureDir's the lock target's directory
// and creates a `.lock` placeholder file, and the lock previously wrapped BOTH the dry-run
// preview branch and the real write branch — so a `--dry-run` finalize on a fresh project
// created the full `registry/<area>/` directory tree plus a `<Export>.json.lock` file, even
// though `<Export>.json` itself was never written. Since `registry/` is a durable, git-tracked
// directory in host projects, this meant a preview-only command dirtied `git status`. Dry-run
// never writes, so it doesn't need the lock at all; this test asserts no such side effects.
async function testFinalizeDryRunHasNoFilesystemSideEffects() {
  const { dir, cacheDir, registryDir } = stageFinalizeProject();

  const { exitCode, output } = await runFinalize({
    'cache-dir': cacheDir,
    'project-root': dir,
    'dry-run': true,
  });

  assert.strictEqual(exitCode, 0, output);
  assert.strictEqual(
    fs.existsSync(path.join(registryDir, 'ui')),
    false,
    'dry-run must not create the registry/ui directory tree',
  );
  const strayLockFiles = fs.existsSync(registryDir)
    ? fs.readdirSync(registryDir, { recursive: true }).filter((entry) => entry.endsWith('.lock'))
    : [];
  assert.deepStrictEqual(
    strayLockFiles,
    [],
    `dry-run must not create any .lock file; found: ${strayLockFiles.join(', ')}`,
  );
  console.log('finalize dry-run has no filesystem side effects → PASS');
}

export const tests = [
  testFinalizeHappyPath,
  testFinalizePruneRejected,
  testFinalizeRequiresCachedFramework,
  testFinalizeCarriedForwardMissing,
  testFinalizeIncompatibleRename,
  testFinalizeReportsPropRemovalCleanly,
  testFinalizeReportsLockContentionCleanly,
  testFinalizeReportsSchemaV2UpgradeCleanly,
  testFinalizeSameIdRename,
  testFinalizeDryRun,
  testFinalizeDryRunHasNoFilesystemSideEffects,
];
