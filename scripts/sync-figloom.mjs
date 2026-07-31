import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = [
  {
    source: path.join(repoRoot, 'skills', 'figma-component-registry'),
    destination: path.join(repoRoot, 'plugins', 'figloom', 'skills', 'figma-component-registry'),
  },
];
const excludedNames = new Set(['.DS_Store', 'node_modules']);
const managedOnlyExclusions = [
  '.gitignore',
  'evals',
  'scripts/figma-component-registry-tests.mjs',
  'scripts/fixtures',
  'scripts/lib',
  'scripts/package-lock.json',
  'scripts/package.json',
  'scripts/test',
];

function shouldInclude(filePath) {
  return !excludedNames.has(path.basename(filePath));
}

function collectFiles(root) {
  const files = new Map();

  function visit(current, relative = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!shouldInclude(entry.name)) continue;
      const absolutePath = path.join(current, entry.name);
      const relativePath = path.join(relative, entry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symlink is not allowed in a public plugin bundle: ${absolutePath}`);
      }
      if (stat.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) continue;
      const digest = crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
      files.set(relativePath, digest);
    }
  }

  visit(root);
  return files;
}

function assertEqualTrees(expected, destination) {
  if (!fs.existsSync(destination)) {
    throw new Error(`Generated bundle is missing: ${path.relative(repoRoot, destination)}`);
  }
  const sourceFiles = collectFiles(expected);
  const destinationFiles = collectFiles(destination);
  const allPaths = new Set([...sourceFiles.keys(), ...destinationFiles.keys()]);
  const drift = [...allPaths].filter(
    (relativePath) => sourceFiles.get(relativePath) !== destinationFiles.get(relativePath),
  );
  if (drift.length > 0) {
    throw new Error(
      `Figloom bundle drift detected:\n${drift.map((file) => `- ${file}`).join('\n')}`,
    );
  }
}

function syncTree(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });

  const sourceRelative = path.relative(repoRoot, source);
  const tracked = spawnSync('git', ['ls-files', '-z', '--cached', '--', sourceRelative], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (tracked.status !== 0) {
    throw new Error(tracked.stderr || 'Could not list tracked Figloom source files');
  }
  const trackedFiles = tracked.stdout.split('\0').filter(Boolean);
  for (const repoRelativePath of trackedFiles) {
    const sourcePath = path.join(repoRoot, repoRelativePath);
    if (!fs.existsSync(sourcePath) || !shouldInclude(sourcePath)) continue;
    const destinationPath = path.join(destination, path.relative(source, sourcePath));
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
    fs.chmodSync(destinationPath, fs.statSync(sourcePath).mode);
  }

  for (const relativePath of managedOnlyExclusions) {
    fs.rmSync(path.join(destination, relativePath), { recursive: true, force: true });
  }

  const sourceEntry = path.join(source, 'scripts', 'figma-component-registry.mjs');
  const bundledEntry = path.join(
    destination,
    'scripts',
    'lib',
    'validate',
    'figma-component-registry.bundle.mjs',
  );
  buildSync({
    entryPoints: [sourceEntry],
    outfile: bundledEntry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'bundle',
    minify: true,
    banner: {
      js: 'import { createRequire as __figloomCreateRequire } from "node:module"; import { fileURLToPath as __figloomFileURLToPath } from "node:url"; import { dirname as __figloomDirname } from "node:path"; const require = __figloomCreateRequire(import.meta.url); const __filename = __figloomFileURLToPath(import.meta.url); const __dirname = __figloomDirname(__filename);',
    },
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(destination, 'scripts', 'figma-component-registry.mjs'),
    "import './lib/validate/figma-component-registry.bundle.mjs';\n",
  );
}

const checkOnly = process.argv.includes('--check');
for (const entry of entries) {
  if (!checkOnly) {
    syncTree(entry.source, entry.destination);
    continue;
  }
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'figloom-bundle-check-'));
  const expected = path.join(temporaryRoot, path.basename(entry.destination));
  try {
    syncTree(entry.source, expected);
    assertEqualTrees(expected, entry.destination);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

process.stdout.write(checkOnly ? 'Figloom bundle is synchronized.\n' : 'Figloom bundle synchronized.\n');

export { collectFiles };
