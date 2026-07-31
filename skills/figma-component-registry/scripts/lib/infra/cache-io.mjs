import fs from 'fs';
import path from 'path';
import { isDeepStrictEqual } from 'node:util';
import lockfile from 'proper-lockfile';
import { writeJsonAtomic, ensureDir } from './fs-atomic.mjs';

async function withCodeCacheLock(cachePath, fn) {
  ensureDir(path.dirname(cachePath));
  if (!fs.existsSync(cachePath)) writeJsonAtomic(cachePath, {});
  const release = await lockfile.lock(cachePath, {
    retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 1000 },
    stale: 10000,
  });
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const next = await fn(cache);
    if (!isDeepStrictEqual(cache, next)) writeJsonAtomic(cachePath, next);
    return next;
  } finally {
    await release();
  }
}
export { withCodeCacheLock };
