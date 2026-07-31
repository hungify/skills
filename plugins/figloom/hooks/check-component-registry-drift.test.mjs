import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  editedPaths,
  extractPatchedPaths,
  handleHook,
  touchesComponentSource,
} from './check-component-registry-drift.mjs';

function stageProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'figloom-hook-'));
  fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

test('extracts add, update, and delete patch paths', () => {
  const paths = extractPatchedPaths(`*** Begin Patch
*** Update File: src/components/Button.tsx
*** Add File: src/components/Input.tsx
*** Delete File: src/legacy.ts
*** End Patch`);
  assert.deepStrictEqual(paths, [
    'src/components/Button.tsx',
    'src/components/Input.tsx',
    'src/legacy.ts',
  ]);
});

test('extracts direct Claude and Cursor edit paths', () => {
  assert.deepStrictEqual(editedPaths({ file_path: '/project/src/components/Button.tsx' }), [
    '/project/src/components/Button.tsx',
  ]);
  assert.deepStrictEqual(editedPaths({ tool_input: { file_path: 'src/components/Input.tsx' } }), [
    'src/components/Input.tsx',
  ]);
});

test('matches component files and ignores unrelated files', () => {
  const root = stageProject();
  assert.equal(
    touchesComponentSource(
      { tool_input: { command: '*** Update File: src/components/Button.tsx' } },
      root,
      root,
    ),
    true,
  );
  assert.equal(
    touchesComponentSource({ file_path: path.join(root, 'src/app/page.tsx') }, root, root),
    false,
  );
});

test('runs one scoped check for a component patch', () => {
  const root = stageProject();
  const calls = [];
  const result = handleHook(
    {
      cwd: root,
      tool_input: { command: '*** Update File: src/components/Button.tsx' },
    },
    {
      pluginRoot: '/plugin',
      spawnImpl: (...args) => {
        calls.push(args);
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepStrictEqual(calls[0][1].slice(1), [
    'check',
    '--project-root',
    root,
    '--ui-dir',
    path.join(root, 'src', 'components'),
    '--fail-on-stale',
    '--quiet',
  ]);
});

test('returns PostToolUse context when Codex check fails', () => {
  const root = stageProject();
  const result = handleHook(
    {
      cwd: root,
      tool_input: { command: '*** Update File: src/components/Button.tsx' },
    },
    {
      pluginRoot: '/plugin',
      spawnImpl: () => ({ status: 1, stdout: '', stderr: 'registry stale' }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(result.output.hookSpecificOutput.additionalContext, /registry stale/);
});

test('returns Cursor-compatible context for afterFileEdit', () => {
  const root = stageProject();
  const result = handleHook(
    {
      cwd: root,
      hook_event_name: 'afterFileEdit',
      file_path: path.join(root, 'src/components/Button.tsx'),
    },
    {
      pluginRoot: '/plugin',
      spawnImpl: () => ({ status: 1, stdout: '', stderr: 'registry stale' }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.output.continue, true);
  assert.match(result.output.agent_message, /registry stale/);
});
