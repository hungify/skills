import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withCodeCacheLock } from '../lib/infra/cache-io.mjs';
import { withRegistryLock } from '../lib/infra/registry-lock.mjs';
import { fetchFileNodes } from '../lib/infra/figma-client.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.join(__dirname, '..');

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
async function testRegistryLockSerializesConcurrentWriters() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-registry-lock-'));
  const target = path.join(dir, 'registry', 'ui', 'Button.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ groups: [] }));

  async function worker(groupId) {
    await withRegistryLock(target, async () => {
      const current = JSON.parse(fs.readFileSync(target, 'utf8'));
      await new Promise((r) => setTimeout(r, 30));
      fs.writeFileSync(target, JSON.stringify({ groups: [...current.groups, groupId] }));
    });
  }

  await Promise.all([worker('a'), worker('b')]);
  const final = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.ok(final.groups.includes('a'), 'lost writer a — race condition not fixed');
  assert.ok(final.groups.includes('b'), 'lost writer b — race condition not fixed');
  assert.strictEqual(final.groups.length, 2, 'exactly one writer should have won the race without the lock');
  console.log('registry lock serializes concurrent read-merge-write → PASS');
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


export const tests = [
  testParallelCacheMerge,
  testRegistryLockSerializesConcurrentWriters,
  testCacheSkipsUnchangedWrite,
  testFigmaClientBatches,
  testFigmaClientRetries,
];
