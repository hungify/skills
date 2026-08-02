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
    bundleEntry: 'scripts/figma-component-registry.mjs',
  },
  {
    source: path.join(repoRoot, 'skills', 'verify-visual'),
    destination: path.join(repoRoot, 'plugins', 'figloom', 'skills', 'verify-visual'),
  },
  {
    source: path.join(repoRoot, 'skills', 'figma-implement-component'),
    destination: path.join(repoRoot, 'plugins', 'figloom', 'skills', 'figma-implement-component'),
    // Only coverage_check.mjs needs bundling — it's the one script that
    // imports npm packages (@babel/parser, @babel/types); every other script
    // in this skill stays dependency-free and is copied through as source,
    // unbundled.
    bundleEntry: 'scripts/coverage_check.mjs',
  },
];
const excludedNames = new Set(['.DS_Store', 'node_modules']);
const managedOnlyExclusions = [
  '.gitignore',
  'evals',
  'scripts/figma-component-registry-tests.mjs',
  'scripts/figma-implement-component-pressure.mjs',
  'scripts/fixtures',
  'scripts/lib',
  'scripts/package-lock.json',
  'scripts/package.json',
  'scripts/test',
];

function shouldInclude(filePath) {
  return !excludedNames.has(path.basename(filePath));
}

// Shared recursive walk: rejects symlinks (never allowed in a source tree that feeds the public
// plugin bundle) and calls onFile(absolutePath, relativePath) for every real file.
function walkFiles(root, onFile) {
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
      onFile(absolutePath, relativePath);
    }
  }

  visit(root);
}

function collectFiles(root) {
  const files = new Map();
  walkFiles(root, (absolutePath, relativePath) => {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
    files.set(relativePath, digest);
  });
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

// Bundle sync only ever copies files git already knows about (see listTrackedFiles below), so an
// edited-but-unstaged source file is silently left out of the plugin mirror. Surface that loudly
// instead of letting the stale mirror pass unnoticed until a `--check` run catches the drift.
function warnUntrackedSourceFiles(source, trackedRelativePaths) {
  const tracked = new Set(trackedRelativePaths);
  const untracked = [];

  if (fs.existsSync(source)) {
    walkFiles(source, (absolutePath) => {
      const repoRelativePath = path.relative(repoRoot, absolutePath).split(path.sep).join('/');
      if (!tracked.has(repoRelativePath)) untracked.push(repoRelativePath);
    });
  }
  if (untracked.length > 0) {
    process.stderr.write(
      `[warn] Not staged in git, so not synced into the Figloom bundle. Run 'git add' first:\n${untracked
        .map((file) => `  - ${file}`)
        .join('\n')}\n`,
    );
  }
}

// One `git ls-files` call across every entry's pathspec, instead of one subprocess spawn per
// entry — cuts subprocess overhead as more Figloom skills are added to `entries`.
function listTrackedFiles(sourceDirs) {
  const sourceRelatives = sourceDirs.map((dir) => path.relative(repoRoot, dir));
  const tracked = spawnSync('git', ['ls-files', '-z', '--cached', '--', ...sourceRelatives], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (tracked.status !== 0) {
    throw new Error(tracked.stderr || 'Could not list tracked Figloom source files');
  }
  const allTrackedFiles = tracked.stdout.split('\0').filter(Boolean);
  return new Map(
    sourceDirs.map((dir, index) => {
      const prefix = `${sourceRelatives[index]}/`;
      return [dir, allTrackedFiles.filter((file) => file.startsWith(prefix))];
    }),
  );
}

function syncTree(source, destination, bundleEntry, trackedFiles) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });

  for (const repoRelativePath of trackedFiles) {
    const sourcePath = path.join(repoRoot, repoRelativePath);
    if (!fs.existsSync(sourcePath) || !shouldInclude(sourcePath)) continue;
    const destinationPath = path.join(destination, path.relative(source, sourcePath));
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
    fs.chmodSync(destinationPath, fs.statSync(sourcePath).mode);
  }
  warnUntrackedSourceFiles(source, trackedFiles);

  for (const relativePath of managedOnlyExclusions) {
    fs.rmSync(path.join(destination, relativePath), { recursive: true, force: true });
  }

  if (bundleEntry) {
    const sourceEntry = path.join(source, bundleEntry);
    if (!fs.existsSync(sourceEntry)) {
      throw new Error(`Declared bundle entry is missing: ${path.relative(repoRoot, sourceEntry)}`);
    }
    // Bundle output/shim naming is derived from bundleEntry's own basename
    // (e.g. "scripts/coverage_check.mjs" -> "coverage_check.bundle.mjs"), so
    // adding a new bundled entry never collides with an existing one. The
    // "scripts/lib/validate/" location is arbitrary but shared across every
    // entry for one predictable place to look for generated bundles.
    const entryName = path.basename(bundleEntry, path.extname(bundleEntry));
    const bundledEntry = path.join(destination, 'scripts', 'lib', 'validate', `${entryName}.bundle.mjs`);
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
      path.join(destination, bundleEntry),
      `import './lib/validate/${entryName}.bundle.mjs';\n`,
    );
  }
}

function runSync({ checkOnly } = {}) {
  const trackedByEntry = listTrackedFiles(entries.map((entry) => entry.source));
  for (const entry of entries) {
    const trackedFiles = trackedByEntry.get(entry.source);
    if (!checkOnly) {
      syncTree(entry.source, entry.destination, entry.bundleEntry, trackedFiles);
      continue;
    }
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'figloom-bundle-check-'));
    const expected = path.join(temporaryRoot, path.basename(entry.destination));
    try {
      syncTree(entry.source, expected, entry.bundleEntry, trackedFiles);
      assertEqualTrees(expected, entry.destination);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
  process.stdout.write(checkOnly ? 'Figloom bundle is synchronized.\n' : 'Figloom bundle synchronized.\n');
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runSync({ checkOnly: process.argv.includes('--check') });
}

export { collectFiles, entries, runSync };
