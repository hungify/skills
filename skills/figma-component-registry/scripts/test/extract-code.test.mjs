import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdExtractCode } from '../lib/commands/extract-code.mjs';
import { loadExtractor } from '../lib/extractors/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(SCRIPTS_DIR, 'fixtures');

async function testFailOnStaleCodePropsMap() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-stale-'));
  const cacheDir = path.join(dir, 'cache');
  const uiDir = path.join(dir, 'ui');
  fs.mkdirSync(uiDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES_DIR, 'multi-component/input.tsx'),
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
      schemaVersion: 3,
      component: { exportName: 'Input', exportType: 'named', filePath: 'ui/input.tsx' },
      figma: { componentPath: 'Input' },
      codePropsMap: { forceState: { type: 'enum', values: ['stale-only'] } },
      figmaBindings: [],
    }),
  );

  const script = path.join(SCRIPTS_DIR, 'figma-component-registry.mjs');
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
  const uiDir = path.join(FIXTURES_DIR, 'multi-component');
  const codeCache = path.join(dir, 'code-props-cache.json');

  await cmdExtractCode({
    'project-root': dir,
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
    path.join(FIXTURES_DIR, 'vue3/Button.vue'),
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
  const abs = path.join(FIXTURES_DIR, 'multi-component/input.tsx');
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
  const abs = path.join(FIXTURES_DIR, 'inherited-props/Button.tsx');
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
  const abs = path.join(FIXTURES_DIR, 'vue3/Button.vue');
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
  const uiDir = path.join(FIXTURES_DIR, 'vue3');
  const codeCache = path.join(dir, 'code-props-cache.json');

  await cmdExtractCode({
    'project-root': dir,
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
async function testExtractCodeSkipsBrokenFileContinuesOthers() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-vue-broken-'));
  const uiDir = path.join(dir, 'ui');
  fs.mkdirSync(uiDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES_DIR, 'vue3/Broken.vue'),
    path.join(uiDir, 'Broken.vue'),
  );
  fs.writeFileSync(
    path.join(uiDir, 'Good.vue'),
    '<script setup lang="ts">defineProps<{ size: string }>()</script><template><div /></template>',
  );
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }));
  const cachePath = path.join(dir, '.figma', 'cache', 'code-props-cache.json');

  const logs = [];
  const origWarn = console.warn;
  const origLog = console.log;
  console.warn = (...items) => logs.push(items.join(' '));
  console.log = (...items) => logs.push(items.join(' '));
  try {
    await cmdExtractCode({ 'ui-dir': uiDir, 'project-root': dir, 'code-cache': cachePath });
  } finally {
    console.warn = origWarn;
    console.log = origLog;
  }

  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.ok(cache[path.join(uiDir, 'Good.vue')], 'Good.vue should still be extracted');
  assert.ok(!cache[path.join(uiDir, 'Broken.vue')], 'Broken.vue should not be cached');
  assert.ok(
    logs.some((line) => line.includes('Broken.vue')),
    `expected a warning naming Broken.vue; logs:\n${logs.join('\n')}`,
  );
  console.log('extract-code skips broken file, continues others → PASS');
}
async function testExtractCodeDropsWarmCacheEntryAfterParseFailure() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-vue-warm-cache-failure-'));
  const uiDir = path.join(dir, 'ui');
  const componentPath = path.join(uiDir, 'Button.vue');
  const cachePath = path.join(dir, '.figma', 'cache', 'code-props-cache.json');
  fs.mkdirSync(uiDir, { recursive: true });
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }));
  fs.copyFileSync(path.join(FIXTURES_DIR, 'vue3/Broken.vue'), componentPath);
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      [componentPath]: {
        hash: 'sha256:stale',
        framework: 'vue',
        extractorVersion: 9,
        extractedAt: '2026-07-31T00:00:00Z',
        components: { Button: { exportType: 'default', props: { stale: { type: 'boolean' } } } },
      },
    }),
  );
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await cmdExtractCode({
      'ui-dir': uiDir,
      'project-root': dir,
      'code-cache': cachePath,
      framework: 'vue',
      quiet: true,
    });
  } finally {
    console.warn = originalWarn;
  }

  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.ok(!cache[componentPath], 'failed reparse must remove previous cached component API');
  console.log('extract-code drops warm cache entry after parse failure → PASS');
}
// Final whole-branch review finding 3: a file that fails extraction is skipped (its previous
// cache entry, if any, is left untouched) rather than aborting the whole run — but that means
// `checkCodePropsDrift` only ever sees the successfully-extracted files, so `--fail-on-stale`
// (and therefore `check`) could exit 0 purely because nothing among the *successful* extractions
// drifted, even though a file failed to parse at all. Extraction errors must independently fail
// the `--fail-on-stale`/`check` path's exit code, regardless of what `checkCodePropsDrift` finds.
async function testCheckFailsOnExtractionErrorEvenWithoutDrift() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-check-extract-err-'));
  const uiDir = path.join(dir, 'ui');
  fs.mkdirSync(uiDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES_DIR, 'vue3/Broken.vue'),
    path.join(uiDir, 'Broken.vue'),
  );
  fs.writeFileSync(
    path.join(uiDir, 'Good.vue'),
    '<script setup lang="ts">defineProps<{ size: string }>()</script><template><div /></template>',
  );
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }));
  // Deliberately no registry/ dir at all: checkCodePropsDrift finds zero stale entries among
  // the successfully-extracted files (Good.vue), since there's nothing on disk to compare
  // against — isolating the assertion to extractionErrors alone driving the exit code.
  const cachePath = path.join(dir, '.figma', 'cache', 'code-props-cache.json');

  let exitCode = 0;
  const origExit = process.exit;
  const logs = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...items) => logs.push(items.join(' '));
  console.error = (...items) => logs.push(items.join(' '));
  console.warn = (...items) => logs.push(items.join(' '));
  process.exit = (code) => {
    exitCode = code ?? 0;
    throw new Error(`exit:${exitCode}`);
  };
  try {
    await cmdExtractCode({
      'ui-dir': uiDir,
      'project-root': dir,
      'code-cache': cachePath,
      'fail-on-stale': true,
    });
  } catch (error) {
    if (!String(error?.message ?? error).startsWith('exit:')) throw error;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }

  assert.strictEqual(
    exitCode,
    1,
    `expected exit 1 due to extraction error alone (no codePropsMap drift possible here); logs:\n${logs.join('\n')}`,
  );
  assert.ok(
    logs.some((line) => line.includes('extraction')),
    `expected extraction-error failure mentioned in output; logs:\n${logs.join('\n')}`,
  );
  console.log('check fails on extraction error even without drift → PASS');
}
async function testExtractCodeQuietStale() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-quiet-'));
  const cacheDir = path.join(dir, 'cache');
  const uiDir = path.join(dir, 'ui');
  fs.mkdirSync(uiDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES_DIR, 'multi-component/input.tsx'),
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

  const script = path.join(SCRIPTS_DIR, 'figma-component-registry.mjs');
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


export const tests = [
  testFailOnStaleCodePropsMap,
  testExtractCodeCommand,
  testExtractCodeDetectsFrameworkWithoutConfig,
  testExtractCodeRejectsMixedFrameworkRoot,
  testExtractMulti,
  testReactExtractorExcludesOnlyConfirmedNoise,
  testExtractVue3Sfc,
  testExtractVue3Command,
  testExtractCodeSkipsBrokenFileContinuesOthers,
  testExtractCodeDropsWarmCacheEntryAfterParseFailure,
  testCheckFailsOnExtractionErrorEvenWithoutDrift,
  testExtractCodeQuietStale,
];
