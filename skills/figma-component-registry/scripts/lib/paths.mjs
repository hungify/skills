import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const SHARED_CACHE_DIR = '.figma/cache';
const DEFAULT_UI_DIR = 'src/components';
const CODE_CACHE_NAME = 'code-props-cache.json';
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo']);

function loadDotEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function findProjectRoot(startDir = process.cwd(), override) {
  if (override) {
    const resolved = path.resolve(override);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`--project-root=${override} is not a directory`);
    }
    return resolved;
  }
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find package.json by walking up from ${startDir}`);
}

function getFigmaToken() {
  loadDotEnv();
  return process.env.FIGMA_ACCESS_TOKEN;
}

function cachePaths(cacheDir) {
  return {
    cacheDir,
    raw: path.join(cacheDir, '_figma-props-raw.json'),
    matched: path.join(cacheDir, '_figma-props-matched.json'),
  };
}

function isolatedCacheDir(args, command) {
  const cacheDir = args['cache-dir'];
  if (typeof cacheDir !== 'string' || cacheDir.trim().length === 0) {
    console.error(
      `❌ ${command} requires isolated --cache-dir <path>; reuse the same path for one fetch/extract/finalize cycle`,
    );
    process.exit(1);
  }
  if (path.resolve(cacheDir) === path.resolve(SHARED_CACHE_DIR)) {
    console.error(
      `❌ Shared cache ${SHARED_CACHE_DIR} is forbidden; use ${SHARED_CACHE_DIR}/<task-id>`,
    );
    process.exit(1);
  }
  return cacheDir;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function hashContent(source) {
  return `sha256:${crypto.createHash('sha256').update(source).digest('hex')}`;
}

function hashJson(value) {
  return hashContent(JSON.stringify(value));
}

function walkComponentFiles(dir, extensions) {
  const allowedExtensions = new Set(extensions);
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      results = results.concat(walkComponentFiles(path.join(dir, entry.name), extensions));
    } else if (entry.isFile() && allowedExtensions.has(path.extname(entry.name))) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}
export { SHARED_CACHE_DIR, DEFAULT_UI_DIR, CODE_CACHE_NAME, cachePaths, isolatedCacheDir, loadDotEnv, findProjectRoot, getFigmaToken, nowIso, hashContent, hashJson, walkComponentFiles };
