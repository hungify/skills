import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function findProjectRoot(startDir) {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 20; depth++) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function extractPatchedPaths(command) {
  const paths = [];
  const pattern = /^\*\*\* (?:Add|Update|Delete) File:\s+(.+?)\s*$/gm;
  for (const match of String(command ?? '').matchAll(pattern)) paths.push(match[1]);
  return paths;
}

function isPathUnderDir(filePath, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function editedPaths(input) {
  const directPath = input?.file_path ?? input?.tool_input?.file_path;
  const paths = directPath ? [directPath] : [];
  return [...paths, ...extractPatchedPaths(input?.tool_input?.command)];
}

function touchesComponentSource(input, cwd, projectRoot) {
  const componentRoot = path.join(projectRoot, 'src', 'components');
  return editedPaths(input).some((filePath) => {
    if (path.isAbsolute(filePath)) return isPathUnderDir(filePath, componentRoot);
    return (
      isPathUnderDir(path.resolve(cwd, filePath), componentRoot) ||
      isPathUnderDir(path.resolve(projectRoot, filePath), componentRoot)
    );
  });
}

function failureMessage(details) {
  return `Figma component registry check failed after a component edit.\n${details}`.slice(-4000);
}

function hostOutput(input, message) {
  if (input?.hook_event_name === 'afterFileEdit') {
    return { continue: true, user_message: message, agent_message: message };
  }
  return {
    systemMessage: 'Figma component registry check failed after a component edit.',
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: message,
    },
  };
}

function handleHook(input, options = {}) {
  const cwd = path.resolve(input?.cwd || process.cwd());
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return { ran: false, reason: 'project-root-missing' };
  if (!touchesComponentSource(input, cwd, projectRoot)) {
    return { ran: false, reason: 'component-source-untouched' };
  }

  const pluginRoot =
    options.pluginRoot ||
    process.env.PLUGIN_ROOT ||
    process.env.CLAUDE_PLUGIN_ROOT ||
    process.env.CURSOR_PLUGIN_ROOT;
  if (!pluginRoot) {
    const message = failureMessage('Plugin root environment variable is missing.');
    return { ran: true, ok: false, output: hostOutput(input, message) };
  }

  const script = path.join(
    pluginRoot,
    'skills',
    'figma-component-registry',
    'scripts',
    'figma-component-registry.mjs',
  );
  const uiDir = path.join(projectRoot, 'src', 'components');
  const spawn = options.spawnImpl || spawnSync;
  const result = spawn(
    process.execPath,
    [
      script,
      'check',
      '--project-root',
      projectRoot,
      '--ui-dir',
      uiDir,
      '--fail-on-stale',
      '--quiet',
    ],
    { cwd: projectRoot, encoding: 'utf8' },
  );

  if (result.status === 0) return { ran: true, ok: true };
  const details = [result.stdout, result.stderr, result.error?.message]
    .filter(Boolean)
    .join('\n')
    .trim();
  const message = failureMessage(
    details || `Registry check exited with status ${result.status}.`,
  );
  return { ran: true, ok: false, output: hostOutput(input, message) };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const result = handleHook(input);
  if (result.output) process.stdout.write(`${JSON.stringify(result.output)}\n`);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    const message = failureMessage(error instanceof Error ? error.message : String(error));
    process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
  });
}

export {
  editedPaths,
  extractPatchedPaths,
  findProjectRoot,
  handleHook,
  isPathUnderDir,
  touchesComponentSource,
};
