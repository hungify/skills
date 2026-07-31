import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { tests as validateTests } from './test/validate.test.mjs';
import { tests as domainTests } from './test/domain.test.mjs';
import { tests as infraTests } from './test/infra.test.mjs';
import { tests as extractCodeTests } from './test/extract-code.test.mjs';
import { tests as finalizeTests } from './test/finalize.test.mjs';
import { tests as finalizeConsistencyGuardTests } from './test/finalize-consistency-guards.test.mjs';

const tests = [
  ...validateTests,
  ...domainTests,
  ...infraTests,
  ...extractCodeTests,
  ...finalizeTests,
  ...finalizeConsistencyGuardTests,
];

async function runAll() {
  const failures = [];
  for (const t of tests) {
    try {
      await t();
    } catch (err) {
      failures.push({ name: t.name || '(anonymous test)', err });
      console.error(`FAIL: ${t.name || '(anonymous test)'} FAILED`);
      console.error(err);
    }
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length}/${tests.length} test(s) failed:`);
    for (const { name } of failures) console.error(`  - ${name}`);
    throw new Error(`${failures.length}/${tests.length} test(s) failed`);
  }
}

export { tests, runAll };

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runAll().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
