import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const manifests = [
  'plugins/figloom/.codex-plugin/plugin.json',
  'plugins/figloom/.claude-plugin/plugin.json',
  'plugins/figloom/.cursor-plugin/plugin.json',
];

for (const relativePath of manifests) {
  const manifestPath = path.join(repoRoot, relativePath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = packageJson.version;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

process.stdout.write(`Synchronized Figloom manifests to ${packageJson.version}.\n`);
