import fs from 'fs';
import path from 'path';
import lockfile from 'proper-lockfile';
import { ensureDir } from './fs-atomic.mjs';

async function withRegistryLock(outPath, fn, lockOptions = {}) {
  const lockTarget = `${outPath}.lock`;
  ensureDir(path.dirname(lockTarget));
  if (!fs.existsSync(lockTarget)) fs.writeFileSync(lockTarget, '');
  const release = await lockfile.lock(lockTarget, {
    retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 1000 },
    stale: 10000,
    ...lockOptions,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
export { withRegistryLock };
