import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTRACTOR_VERSION } from '../../lib/commands/extract-code.mjs';
import { cmdFinalize } from '../../lib/commands/finalize.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.join(__dirname, '..', '..');
const FIXTURES_DIR = path.join(SCRIPTS_DIR, 'fixtures');

function stageFinalizeProject(fixtureName = 'good-matched') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-finalize-'));
  const cacheDir = path.join(dir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const fixtureDir = path.join(FIXTURES_DIR, fixtureName);
  for (const file of [
    '_figma-props-raw.json',
    '_figma-props-matched.json',
  ]) {
    fs.copyFileSync(path.join(fixtureDir, file), path.join(cacheDir, file));
  }
  const codeRaw = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, '_code-props-raw.json'), 'utf8'),
  );
  const sharedCachePath = path.join(dir, '.figma', 'cache', 'code-props-cache.json');
  fs.mkdirSync(path.dirname(sharedCachePath), { recursive: true });
  const sharedCache = {};
  for (const [componentName, component] of Object.entries(codeRaw.components ?? {})) {
    sharedCache[component.file] ??= {
      hash: 'fixture',
      framework: 'react',
      extractorVersion: EXTRACTOR_VERSION,
      extractedAt: '2026-07-26T00:00:00Z',
      components: {},
    };
    sharedCache[component.file].components[componentName] = {
      exportType: component.exportType ?? 'named',
      props: component.props,
      ownedPropNames: Object.keys(component.props ?? {}),
    };
  }
  fs.writeFileSync(sharedCachePath, JSON.stringify(sharedCache));
  const registryDir = path.join(dir, 'registry');
  fs.mkdirSync(registryDir, { recursive: true });
  return { dir, cacheDir, registryDir, sharedCachePath };
}
async function runFinalize(args) {
  let exitCode = 0;
  const origExit = process.exit;
  const logs = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...items) => logs.push(items.join(' '));
  console.error = (...items) => logs.push(items.join(' '));
  process.exit = (code) => {
    exitCode = code ?? 0;
    throw new Error(`exit:${exitCode}`);
  };
  try {
    await cmdFinalize({
      ...args,
      'code-cache':
        args['code-cache'] ??
        (args['project-root']
          ? path.join(args['project-root'], '.figma', 'cache', 'code-props-cache.json')
          : undefined),
    });
  } catch (error) {
    if (!String(error?.message ?? error).startsWith('exit:')) throw error;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origError;
  }
  return { exitCode, output: logs.join('\n') };
}

export { stageFinalizeProject, runFinalize };
