import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion = readJson('package.json').version;
const manifestPaths = [
  'plugins/figloom/.codex-plugin/plugin.json',
  'plugins/figloom/.claude-plugin/plugin.json',
  'plugins/figloom/.cursor-plugin/plugin.json',
];
const bundledCli = path.join(
  repoRoot,
  'plugins',
  'figloom',
  'skills',
  'figma-component-registry',
  'scripts',
  'figma-component-registry.mjs',
);

function fail(message) {
  throw new Error(message);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function requirePath(relativePath) {
  if (!fs.existsSync(path.join(repoRoot, relativePath))) fail(`Missing required path: ${relativePath}`);
}

function assertManifest(relativePath) {
  const manifest = readJson(relativePath);
  if (manifest.name !== 'figloom') fail(`${relativePath}: name must be figloom`);
  if (manifest.version !== expectedVersion) {
    fail(`${relativePath}: version ${manifest.version} does not match ${expectedVersion}`);
  }
  if (manifest.skills !== './skills/') fail(`${relativePath}: skills must be ./skills/`);
  if (!manifest.description || !manifest.author?.name) {
    fail(`${relativePath}: description and author.name are required`);
  }
}

function assertNoSymlinks(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (fs.lstatSync(entryPath).isSymbolicLink()) fail(`Public bundle contains symlink: ${entryPath}`);
    if (entry.isDirectory()) assertNoSymlinks(entryPath);
  }
}

function assertStandaloneSkills() {
  const skillsRoot = path.join(repoRoot, 'skills');
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsRoot, entry.name, 'SKILL.md');
    requirePath(path.relative(repoRoot, skillPath));
    const source = fs.readFileSync(skillPath, 'utf8');
    const match = source.match(/^---\n([\s\S]*?)\n---/);
    if (!match) fail(`${path.relative(repoRoot, skillPath)}: missing YAML frontmatter`);
    const name = match[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = match[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (name !== entry.name) fail(`${path.relative(repoRoot, skillPath)}: name must be ${entry.name}`);
    if (!description) fail(`${path.relative(repoRoot, skillPath)}: description is required`);
  }
}

function assertMarketplace(relativePath, expectedSource) {
  const marketplace = readJson(relativePath);
  if (marketplace.name !== 'hungify') fail(`${relativePath}: marketplace name must be hungify`);
  const plugin = marketplace.plugins?.find((entry) => entry.name === 'figloom');
  if (!plugin) fail(`${relativePath}: figloom entry is missing`);
  const actualSource = typeof plugin.source === 'string' ? plugin.source : plugin.source?.path;
  if (actualSource !== expectedSource) {
    fail(`${relativePath}: expected source ${expectedSource}, received ${actualSource}`);
  }
}

function assertCursorSchemas() {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const checks = [
    {
      schema: readJson('scripts/schemas/cursor-marketplace.schema.json'),
      data: readJson('.cursor-plugin/marketplace.json'),
      label: '.cursor-plugin/marketplace.json',
    },
    {
      schema: readJson('scripts/schemas/cursor-plugin.schema.json'),
      data: readJson('plugins/figloom/.cursor-plugin/plugin.json'),
      label: 'plugins/figloom/.cursor-plugin/plugin.json',
    },
  ];

  for (const check of checks) {
    const validate = ajv.compile(check.schema);
    if (!validate(check.data)) {
      const details = validate.errors
        .map((error) => `${error.instancePath || '/'} ${error.message}`)
        .join('; ');
      fail(`${check.label}: Cursor schema validation failed: ${details}`);
    }
  }
}

function assertNoEmoji(root) {
  const ignored = new Set(['.git', 'node_modules']);
  const textExtensions = new Set(['.json', '.md', '.mjs', '.js', '.ts', '.tsx', '.yaml', '.yml']);
  const emoji = /\p{Extended_Pictographic}/u;

  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !textExtensions.has(path.extname(entry.name))) continue;
      if (emoji.test(fs.readFileSync(entryPath, 'utf8'))) {
        fail(`Emoji is not allowed in release text: ${path.relative(repoRoot, entryPath)}`);
      }
    }
  }

  visit(root);
}

for (const requiredPath of [
  '.agents/plugins/marketplace.json',
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
  'plugins/figloom/hooks/hooks.json',
  'plugins/figloom/hooks/claude-hooks.json',
  'plugins/figloom/hooks/cursor-hooks.json',
  'drafts/figloom',
  'deprecated/figloom',
]) {
  requirePath(requiredPath);
}

if (fs.existsSync(path.join(repoRoot, '.codex-plugin/plugin.json'))) {
  fail('Root .codex-plugin/plugin.json must not exist');
}
if (fs.existsSync(path.join(repoRoot, '.claude-plugin/plugin.json'))) {
  fail('Root .claude-plugin/plugin.json must not exist');
}

for (const manifestPath of manifestPaths) assertManifest(manifestPath);
assertMarketplace('.agents/plugins/marketplace.json', './plugins/figloom');
assertMarketplace('.claude-plugin/marketplace.json', './plugins/figloom');
assertMarketplace('.cursor-plugin/marketplace.json', 'plugins/figloom');
assertCursorSchemas();
assertStandaloneSkills();
assertNoSymlinks(path.join(repoRoot, 'plugins', 'figloom'));
assertNoEmoji(repoRoot);

const bundledSkills = fs
  .readdirSync(path.join(repoRoot, 'plugins', 'figloom', 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
if (bundledSkills.length !== 1 || bundledSkills[0] !== 'figma-component-registry') {
  fail(`Figloom must bundle only figma-component-registry; found ${bundledSkills.join(', ')}`);
}

const syncCheck = spawnSync(process.execPath, ['scripts/sync-figloom.mjs', '--check'], {
  cwd: repoRoot,
  encoding: 'utf8',
});
if (syncCheck.status !== 0) fail(syncCheck.stderr || syncCheck.stdout || 'Bundle sync check failed');

const bundledCliCheck = spawnSync(process.execPath, [bundledCli, '__figloom_load_check__'], {
  cwd: repoRoot,
  encoding: 'utf8',
});
if (
  bundledCliCheck.status !== 1 ||
  !bundledCliCheck.stderr.includes('ERROR: Unknown command "__figloom_load_check__"')
) {
  fail(
    bundledCliCheck.stderr ||
      bundledCliCheck.stdout ||
      'Bundled Figloom registry CLI did not load correctly',
  );
}

const smokeCases = [
  {
    framework: 'react',
    dependency: 'react',
    dependencyVersion: '^18.0.0',
    file: 'Button.tsx',
    source:
      'export interface ButtonProps { disabled?: boolean }\nexport function Button(props: ButtonProps) { return null }\n',
  },
  {
    framework: 'vue',
    dependency: 'vue',
    dependencyVersion: '^3.0.0',
    file: 'Button.vue',
    source:
      '<script setup lang="ts">\ndefineProps<{ disabled?: boolean }>()\n</script>\n<template><button /></template>\n',
  },
];

for (const smokeCase of smokeCases) {
  const smokeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `figloom-managed-${smokeCase.framework}-`),
  );
  try {
    const smokeUiDir = path.join(smokeRoot, 'src', 'components');
    fs.mkdirSync(smokeUiDir, { recursive: true });
    fs.writeFileSync(
      path.join(smokeRoot, 'package.json'),
      `${JSON.stringify(
        { dependencies: { [smokeCase.dependency]: smokeCase.dependencyVersion } },
        null,
        2,
      )}\n`,
    );
    fs.writeFileSync(path.join(smokeUiDir, smokeCase.file), smokeCase.source);
    const smoke = spawnSync(
      process.execPath,
      [
        bundledCli,
        'extract-code',
        '--project-root',
        smokeRoot,
        '--ui-dir',
        smokeUiDir,
        '--framework',
        smokeCase.framework,
        '--quiet',
      ],
      { cwd: smokeRoot, encoding: 'utf8' },
    );
    if (smoke.status !== 0) {
      fail(
        smoke.stderr ||
          smoke.stdout ||
          `Bundled Figloom ${smokeCase.framework} smoke test failed`,
      );
    }
  } finally {
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
}

process.stdout.write('Release structure is valid.\n');
