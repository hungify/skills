# figma-component-registry Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 9 defects found in code review of `skills/figma-component-registry` and land the two architectural changes approved in the design spec (registry-write locking, structured binding-path fields), without changing the flat-file registry layout or introducing content-addressed storage.

**Architecture:** Nine surgical, independently-testable changes to existing `.mjs` modules under `skills/figma-component-registry/scripts/lib/**`. No new top-level directories; one new infra module (`registry-lock.mjs`) and one new domain helper (`isPathUnderDir` in `paths.mjs`). Schema bumps from v2 to v3 only for the durable `registry-entry.schema.json` (the ephemeral `matched.schema.json` is untouched — its shape doesn't change).

**Tech Stack:** Node ESM (`.mjs` only), `ajv` for JSON Schema validation, `proper-lockfile` for file locking (already a dependency, already used in `cache-io.mjs`), `node:assert/strict` + a hand-rolled runner (`figma-component-registry-pressure.mjs`) for tests — no test framework.

## Global Constraints

- All skill scripts are ESM `.mjs` only — no `.cjs` or `.ts` (per `SKILL.md`).
- No `--prune`/delete capability may be added (existing, deliberate design constraint — `finalize` already rejects `--prune`).
- No content-addressed storage, no `apiVersion`-string schema versioning, no v2→v3 auto-migration tooling (all explicitly rejected in the design spec at `docs/superpowers/specs/2026-07-30-figma-component-registry-hardening-design.md`).
- `matched.schema.json` stays at `schemaVersion: 2` — only `registry-entry.schema.json` bumps to `schemaVersion: 3`.
- Run the full suite with `node scripts/figma-component-registry-pressure.mjs` from `skills/figma-component-registry/` after every task; all tests (existing + new) must pass before committing that task.
- Work happens on branch `fix/figma-component-registry-hardening` (already created, branched off `feat/skill-figma-component-registry`).

---

## Task 1: Path-segment-safe cache filtering (`--ui-dir` / `--source-root`)

**Files:**
- Modify: `skills/figma-component-registry/scripts/lib/paths.mjs`
- Modify: `skills/figma-component-registry/scripts/lib/commands/extract-code.mjs:20-24,80,116-119`
- Test: `skills/figma-component-registry/scripts/figma-component-registry-pressure.mjs`

**Interfaces:**
- Produces: `isPathUnderDir(filePath, dir)` — exported from `paths.mjs`, returns `boolean`. Consumed by Task 1's own callers; no other task depends on it.

**Bug:** `buildCodeRawFromCache` (in `extract-code.mjs:20-24`) and `cmdExtractCode`'s stale-key cleanup (`extract-code.mjs:116-119`) both filter cache keys by raw string prefix (`filePath.startsWith(uiDirPrefix)`). Cache keys are stored exactly as `walkComponentFiles` produced them from whatever `--ui-dir`/`--source-root` string the user passed. If `extract-code --ui-dir src/components` populates the cache, then `finalize --source-root ./src/components` or `src/components/` (trailing slash) is used later, string-prefix comparison can silently match zero files even though both refer to the same directory.

- [ ] **Step 1: Write the failing test**

Add to `figma-component-registry-pressure.mjs` (near `testRegistryPath`, and add `isPathUnderDir` to the import from `./lib/paths.mjs` — that import currently only pulls `cachePaths`/`isolatedCacheDir`/etc., so extend it):

```js
function testIsPathUnderDirNormalizesSeparators() {
  assert.strictEqual(isPathUnderDir('src/components/ui/button.tsx', 'src/components'), true);
  assert.strictEqual(isPathUnderDir('src/components/ui/button.tsx', './src/components'), true);
  assert.strictEqual(isPathUnderDir('src/components/ui/button.tsx', 'src/components/'), true);
  // must NOT false-positive on a directory whose name is a prefix of another
  assert.strictEqual(isPathUnderDir('src/components-legacy/button.tsx', 'src/components'), false);
  assert.strictEqual(isPathUnderDir('src/other/button.tsx', 'src/components'), false);
  console.log('isPathUnderDir normalizes separators → PASS');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/figma-component-registry-pressure.mjs` (add the test to the `tests` array first, right after `testRegistryPath,`, and add `isPathUnderDir` to the destructured import from `'./lib/paths.mjs'` at the top of the file).
Expected: FAIL — `isPathUnderDir is not a function` (or import error), since it doesn't exist yet.

- [ ] **Step 3: Implement `isPathUnderDir` in `paths.mjs`**

Add near the other path helpers in `scripts/lib/paths.mjs` (after `hashJson`, before `walkComponentFiles`):

```js
function isPathUnderDir(filePath, dir) {
  const relative = path.relative(path.resolve(dir), path.resolve(filePath));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
```

Add `isPathUnderDir` to the final `export { ... }` line in `paths.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: `isPathUnderDir normalizes separators → PASS`

- [ ] **Step 5: Replace the two naive string-prefix filters in `extract-code.mjs`**

In `scripts/lib/commands/extract-code.mjs`, add `isPathUnderDir` to the import from `../paths.mjs` (the block currently importing `SHARED_CACHE_DIR, CODE_CACHE_NAME, findProjectRoot, DEFAULT_UI_DIR, nowIso, hashContent, hashJson, walkComponentFiles`).

Replace lines 20-24 (`function buildCodeRawFromCache`'s first two lines):
```js
function buildCodeRawFromCache(cache, uiDir) {
  const uiDirPrefix = uiDir.endsWith(path.sep) ? uiDir : `${uiDir}${path.sep}`;
  const extractedComponents = [];

  for (const [filePath, entry] of Object.entries(cache)) {
    if (!filePath.startsWith(uiDirPrefix)) continue;
```
with:
```js
function buildCodeRawFromCache(cache, uiDir) {
  const extractedComponents = [];

  for (const [filePath, entry] of Object.entries(cache)) {
    if (!isPathUnderDir(filePath, uiDir)) continue;
```

Replace line 80 (`const uiDirPrefix = uiDir.endsWith(path.sep) ? uiDir : \`${uiDir}${path.sep}\`;` inside `cmdExtractCode`) — delete this line entirely, it's now unused there.

Replace lines 116-119:
```js
    for (const knownPath of Object.keys(next)) {
      if (!knownPath.startsWith(uiDirPrefix)) continue;
      if (!seenFiles.has(knownPath)) delete next[knownPath];
    }
```
with:
```js
    for (const knownPath of Object.keys(next)) {
      if (!isPathUnderDir(knownPath, uiDir)) continue;
      if (!seenFiles.has(knownPath)) delete next[knownPath];
    }
```

- [ ] **Step 6: Run the full suite to verify no regression**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: all tests (including the 38 pre-existing ones) PASS.

- [ ] **Step 7: Commit**

```bash
cd skills/figma-component-registry
git add scripts/lib/paths.mjs scripts/lib/commands/extract-code.mjs scripts/figma-component-registry-pressure.mjs
git commit -m "fix(figma-component-registry): compare ui-dir/source-root by path segment, not raw string prefix"
```

---

## Task 2: Sanitize `exportName` in `registryFilePath` against path traversal

**Files:**
- Modify: `skills/figma-component-registry/scripts/lib/domain/registry-path.mjs`
- Test: `skills/figma-component-registry/scripts/figma-component-registry-pressure.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `registryFilePath` now throws on an unsafe `exportName`; same signature and success-path return value as before.

**Bug:** `registryFilePath` builds `path.join(projectRoot, registryRoot, area, \`${exportName}.json\`)` with no validation on `exportName`. `exportName` ultimately comes from `matched.components[].codeComponent` (agent-authored `_figma-props-matched.json`) — an `exportName` like `"../../evil"` would escape `registryRoot`. Upstream `validateMatchedSemantic` doesn't check this field for path-safety, only that it's a non-empty string matching an extracted code component name.

- [ ] **Step 1: Write the failing test**

Add to `figma-component-registry-pressure.mjs`, near `testRegistryPath`:

```js
function testRegistryPathRejectsTraversalExportName() {
  assert.throws(
    () =>
      registryFilePath({
        projectRoot: '/repo',
        registryRoot: 'registry',
        sourceRoot: 'src/components',
        filePath: 'src/components/ui/button.tsx',
        exportName: '../../evil',
      }),
    /invalid exportName/,
  );
  assert.throws(
    () =>
      registryFilePath({
        projectRoot: '/repo',
        registryRoot: 'registry',
        sourceRoot: 'src/components',
        filePath: 'src/components/ui/button.tsx',
        exportName: 'ui/Button',
      }),
    /invalid exportName/,
  );
  console.log('registry path rejects traversal exportName → PASS');
}
```

Add `testRegistryPathRejectsTraversalExportName` to the `tests` array right after `testRegistryPath,`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: FAIL — no error thrown (current code happily joins the traversal path).

- [ ] **Step 3: Implement the sanitization**

Replace the full contents of `scripts/lib/domain/registry-path.mjs`:

```js
import path from 'path';

function assertSafeExportName(exportName) {
  if (
    typeof exportName !== 'string' ||
    exportName.length === 0 ||
    /[\\/]/.test(exportName) ||
    exportName === '.' ||
    exportName === '..'
  ) {
    throw new Error(`invalid exportName "${exportName}"`);
  }
}

function registryFilePath({ projectRoot, registryRoot, sourceRoot, filePath, exportName }) {
  assertSafeExportName(exportName);
  const absSourceRoot = path.join(projectRoot, sourceRoot);
  const absFile = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  const rel = path.relative(absSourceRoot, absFile);
  if (rel.startsWith('..')) {
    throw new Error(`${filePath} is not under sourceRoot ${sourceRoot}`);
  }
  const area = path.dirname(rel);
  return path.join(projectRoot, registryRoot, area === '.' ? '' : area, `${exportName}.json`);
}
export { registryFilePath };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: `registry path rejects traversal exportName → PASS`, all other tests still PASS.

- [ ] **Step 5: Commit**

```bash
cd skills/figma-component-registry
git add scripts/lib/domain/registry-path.mjs scripts/figma-component-registry-pressure.mjs
git commit -m "fix(figma-component-registry): reject path-traversal exportName in registryFilePath"
```

---

## Task 3: Fail loud on ambiguous `exportName` lookup across areas

**Files:**
- Modify: `skills/figma-component-registry/scripts/lib/domain/registry-lookup.mjs`
- Test: `skills/figma-component-registry/scripts/figma-component-registry-pressure.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `findRegistryEntryByExportName(projectRoot, registryRoot, exportName)` — same signature and success/no-match behavior; now throws when 2+ registry files share `exportName`, listing every matching path.

**Bug:** current DFS returns the *first* file matching `exportName`, silently, when `ui/Button.json` and `marketing/Button.json` both exist. `verify-source --components Button` or `check --components Button` would validate the wrong component with no indication anything was ambiguous. `registry-lookup.mjs` currently has **no test coverage at all** — add baseline coverage for the unambiguous case too.

- [ ] **Step 1: Write the failing tests**

Add `findRegistryEntryByExportName` to the import block at the top of `figma-component-registry-pressure.mjs` (currently imports `{ recoverGroupsFromRegistry }` from `'./lib/domain/recover-groups.mjs'` — add a new import line: `import { findRegistryEntryByExportName } from './lib/domain/registry-lookup.mjs';`).

```js
function testRegistryLookupFindsUniqueMatch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-lookup-'));
  const uiPath = path.join(dir, 'registry', 'ui', 'Button.json');
  fs.mkdirSync(path.dirname(uiPath), { recursive: true });
  fs.writeFileSync(uiPath, JSON.stringify({ component: { exportName: 'Button' } }));

  const found = findRegistryEntryByExportName(dir, 'registry', 'Button');
  assert.ok(found, 'expected a match');
  assert.strictEqual(found.filePath, uiPath);
  console.log('registry lookup finds unique match → PASS');
}

function testRegistryLookupFailsLoudOnCollision() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-lookup-collision-'));
  const uiPath = path.join(dir, 'registry', 'ui', 'Button.json');
  const marketingPath = path.join(dir, 'registry', 'marketing', 'Button.json');
  fs.mkdirSync(path.dirname(uiPath), { recursive: true });
  fs.mkdirSync(path.dirname(marketingPath), { recursive: true });
  fs.writeFileSync(uiPath, JSON.stringify({ component: { exportName: 'Button' } }));
  fs.writeFileSync(marketingPath, JSON.stringify({ component: { exportName: 'Button' } }));

  assert.throws(
    () => findRegistryEntryByExportName(dir, 'registry', 'Button'),
    (error) =>
      /ambiguous exportName "Button"/.test(error.message) &&
      error.message.includes('ui/Button.json') &&
      error.message.includes('marketing/Button.json'),
  );
  console.log('registry lookup fails loud on exportName collision → PASS');
}
```

Add both to the `tests` array, right after `testMergeGroups,`.

- [ ] **Step 2: Run tests to verify the collision test fails**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: `testRegistryLookupFindsUniqueMatch` PASSes already (current code handles the unambiguous case correctly); `testRegistryLookupFailsLoudOnCollision` FAILs because no error is thrown today (silently returns the first hit).

- [ ] **Step 3: Implement fail-loud collision detection**

Replace `findRegistryEntryByExportName` in `scripts/lib/domain/registry-lookup.mjs`:

```js
function findRegistryEntryByExportName(projectRoot, registryRoot, exportName) {
  const root = path.join(projectRoot, registryRoot);
  if (!fs.existsSync(root)) return null;

  const matches = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.name.endsWith('.json') || entry.name === 'config.json') continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (parsed?.component?.exportName === exportName) {
          matches.push({ filePath: fullPath, entry: parsed });
        }
      } catch {
        // skip unreadable registry files
      }
    }
  }

  if (matches.length > 1) {
    const relPaths = matches.map((match) => path.relative(root, match.filePath)).sort();
    throw new Error(
      `ambiguous exportName "${exportName}" matches ${matches.length} registry files: ${relPaths.join(', ')} — disambiguate with a full registry path`,
    );
  }

  return matches[0] ?? null;
}
```

(`readExistingRegistry` in the same file is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: both new tests PASS, all others still PASS.

- [ ] **Step 5: Commit**

```bash
cd skills/figma-component-registry
git add scripts/lib/domain/registry-lookup.mjs scripts/figma-component-registry-pressure.mjs
git commit -m "fix(figma-component-registry): fail loud instead of silently picking a winner on exportName collision"
```

---

## Task 4: `verify-source` reports every missing prop per group, not just the first

**Files:**
- Modify: `skills/figma-component-registry/scripts/lib/commands/verify-source.mjs:8-19,96-101`
- Test: `skills/figma-component-registry/scripts/figma-component-registry-pressure.mjs`

**Interfaces:**
- Produces: `mappingPropsResolve(group, propertyDefinitions)` now returns `string[]` (every missing `figmaProp`) instead of `string | null` (first missing one). This is the only place in the codebase that calls it (confirmed: not imported anywhere else), so this is a safe, self-contained signature change.

**Bug:** `mappingPropsResolve` (`verify-source.mjs:8-19`) returns on the *first* mapping whose `figmaProp` isn't found in live Figma `propertyDefinitions`. If a group has 3 stale props, only 1 is reported — a developer fixes it, re-runs, and discovers the next one, one at a time. `verify-source.mjs` currently has **no test coverage at all** — add baseline coverage alongside this fix.

- [ ] **Step 1: Write the failing test**

Add `cmdVerifySource, mappingPropsResolve` to a new import line in `figma-component-registry-pressure.mjs`: `import { cmdVerifySource, mappingPropsResolve } from './lib/commands/verify-source.mjs';`

```js
function testMappingPropsResolveReportsAllMissing() {
  const group = {
    name: 'btn',
    mappings: [
      { figmaProp: 'Size', mappingKind: 'direct', prop: 'size' },
      { figmaProp: 'Show prepend#1:1', mappingKind: 'composition', note: 'x' },
      { figmaProp: 'Legacy axis', mappingKind: 'unsupported', note: 'y' },
    ],
  };
  const propertyDefinitions = { Size: { type: 'VARIANT' } };
  const missing = mappingPropsResolve(group, propertyDefinitions);
  assert.deepStrictEqual(missing, ['Show prepend#1:1', 'Legacy axis']);
  console.log('mappingPropsResolve reports all missing props → PASS');
}
```

Add `testMappingPropsResolveReportsAllMissing` to the `tests` array (near the recover-groups tests).

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: FAIL — `assert.deepStrictEqual` fails because current `mappingPropsResolve` returns `'Show prepend#1:1'` (a string, the first miss only), not the array of both.

- [ ] **Step 3: Implement `mappingPropsResolve` returning all misses**

Replace lines 8-19 of `scripts/lib/commands/verify-source.mjs`:

```js
function mappingPropsResolve(group, propertyDefinitions) {
  const missing = [];
  const keys = Object.keys(propertyDefinitions ?? {});
  for (const mapping of group.mappings ?? []) {
    const found = keys.some(
      (key) => key === mapping.figmaProp || stripFigmaPropId(key) === stripFigmaPropId(mapping.figmaProp),
    );
    if (!found) missing.push(mapping.figmaProp);
  }
  return missing;
}
```

Replace lines 96-101 (the call site inside `cmdVerifySource`'s group loop):
```js
      const missingProp = mappingPropsResolve(group, current.propertyDefinitions);
      if (missingProp) {
        stale.push(
          `${exportName}: mapping prop "${missingProp}" missing from live Figma definitions for ${group.name}`,
        );
      }
```
with:
```js
      const missingProps = mappingPropsResolve(group, current.propertyDefinitions);
      if (missingProps.length > 0) {
        stale.push(
          `${exportName}: mapping prop(s) "${missingProps.join('", "')}" missing from live Figma definitions for ${group.name}`,
        );
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: `mappingPropsResolve reports all missing props → PASS`, all others PASS.

- [ ] **Step 5: Commit**

```bash
cd skills/figma-component-registry
git add scripts/lib/commands/verify-source.mjs scripts/figma-component-registry-pressure.mjs
git commit -m "fix(figma-component-registry): verify-source reports every missing prop per group, not just the first"
```

---

## Task 5: Per-file error isolation in `extract-code` (fixes Vue extractor abort-on-first-error)

**Files:**
- Modify: `skills/figma-component-registry/scripts/lib/commands/extract-code.mjs` (the `withCodeCacheLock(...)` block inside `cmdExtractCode` — already touched once by Task 1, which must land first)
- Test: `skills/figma-component-registry/scripts/figma-component-registry-pressure.mjs`
- Fixture: create `skills/figma-component-registry/scripts/fixtures/vue3/Broken.vue`

**Interfaces:**
- Produces: no new exports; `cmdExtractCode` behavior changes — a single file's extraction failure is now logged as a warning and skipped, not fatal to the whole run.

**Bug:** `vue.mjs`'s `extractComponents` (calling `checkerFor(absPath).getComponentMeta(absPath)`) has no guard, unlike the React extractor's `mergeResolvedProps`, which already wraps its (secondary) docgen pass in try/catch. The real fix point is framework-neutral: `extract-code.mjs`'s per-file loop (lines 89-114) calls `extractor.extractComponents(filePath)` with **no try/catch at all**, for either framework — one bad file throws inside the `withCodeCacheLock` callback and aborts the whole run, discarding every file already reparsed that run (since the lock's `fn` never returns, nothing gets written).

- [ ] **Step 1: Write the failing test**

Create `skills/figma-component-registry/scripts/fixtures/vue3/Broken.vue` with genuinely invalid SFC syntax that `vue-component-meta` will throw on:

```vue
<script setup lang="ts">
defineProps<{ size: 'sm' | ; }>()
</script>
<template><div /></template>
```

Add the test to `figma-component-registry-pressure.mjs` (near `testExtractVue3Sfc`/`testExtractMulti` — check `testExtractMulti` for the exact `cmdExtractCode`-driving pattern to mirror, e.g. how it stages a `uiDir` and reads back the cache):

```js
async function testExtractCodeSkipsBrokenFileContinuesOthers() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-vue-broken-'));
  const uiDir = path.join(dir, 'ui');
  fs.mkdirSync(uiDir, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, 'fixtures/vue3/Broken.vue'),
    path.join(uiDir, 'Broken.vue'),
  );
  fs.writeFileSync(
    path.join(uiDir, 'Good.vue'),
    '<script setup lang="ts">defineProps<{ size: string }>()</script><template><div /></template>',
  );
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }));
  const cachePath = path.join(dir, '.figma', 'cache', 'code-props-cache.json');

  const logs = [];
  const origWarn = console.warn;
  const origLog = console.log;
  console.warn = (...items) => logs.push(items.join(' '));
  console.log = (...items) => logs.push(items.join(' '));
  try {
    await cmdExtractCode({ 'ui-dir': uiDir, 'project-root': dir, 'code-cache': cachePath });
  } finally {
    console.warn = origWarn;
    console.log = origLog;
  }

  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.ok(cache[path.join(uiDir, 'Good.vue')], 'Good.vue should still be extracted');
  assert.ok(!cache[path.join(uiDir, 'Broken.vue')], 'Broken.vue should not be cached');
  assert.ok(
    logs.some((line) => line.includes('Broken.vue')),
    `expected a warning naming Broken.vue; logs:\n${logs.join('\n')}`,
  );
  console.log('extract-code skips broken file, continues others → PASS');
}
```

Add `testExtractCodeSkipsBrokenFileContinuesOthers` to the `tests` array near the other extract-code tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: FAIL — the whole `cmdExtractCode` call throws (uncaught parse error from `vue-component-meta`), so `Good.vue` never gets cached either.

- [ ] **Step 3: Implement per-file isolation in `extract-code.mjs`**

Replace the entire `const cache = await withCodeCacheLock(codeCachePath, async (lockedCache) => { ... });` block in `scripts/lib/commands/extract-code.mjs` (this is the block Task 1 already touched once, to swap in `isPathUnderDir` — that edit is preserved below) with:

```js
  let extractionErrors = [];
  const cache = await withCodeCacheLock(codeCachePath, async (lockedCache) => {
    const next = { ...lockedCache };
    const seenFiles = new Set();
    extractionErrors = [];

    for (const filePath of componentFiles) {
      seenFiles.add(filePath);
      const source = fs.readFileSync(filePath, 'utf8');
      const hash = hashContent(source);
      const cached = next[filePath];

      if (
        cached &&
        cached.hash === hash &&
        cached.components &&
        cached.framework === framework &&
        cached.extractorVersion === EXTRACTOR_VERSION
      ) {
        reused++;
        continue;
      }

      try {
        const components = extractor.extractComponents(filePath);
        reparsed++;
        next[filePath] = {
          hash,
          framework,
          extractorVersion: EXTRACTOR_VERSION,
          extractedAt: nowIso(),
          components,
        };
      } catch (error) {
        extractionErrors.push(`${filePath}: ${error instanceof Error ? error.message : error}`);
      }
    }

    for (const knownPath of Object.keys(next)) {
      if (!isPathUnderDir(knownPath, uiDir)) continue;
      if (!seenFiles.has(knownPath)) delete next[knownPath];
    }

    return next;
  });

  if (extractionErrors.length > 0) {
    console.warn(`⚠️  ${extractionErrors.length} file(s) failed extraction and were skipped:`);
    extractionErrors.forEach((message) => console.warn(`   - ${message}`));
  }
```

(This supersedes Task 1's edit to the same cleanup loop — `isPathUnderDir` replaces `uiDirPrefix` here too, so do Task 1 before this task.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: `extract-code skips broken file, continues others → PASS`, all others PASS.

- [ ] **Step 5: Commit**

```bash
cd skills/figma-component-registry
git add scripts/lib/commands/extract-code.mjs scripts/figma-component-registry-pressure.mjs scripts/fixtures/vue3/Broken.vue
git commit -m "fix(figma-component-registry): isolate per-file extraction errors instead of aborting the whole extract-code run"
```

---

## Task 6: Schema v3 — structured `componentPath`/`groupName`/`propName` fields on `figmaBindings`

**Files:**
- Modify: `skills/figma-component-registry/scripts/lib/domain/flatten-bindings.mjs`
- Modify: `skills/figma-component-registry/scripts/schemas/registry-entry.schema.json`
- Modify: `skills/figma-component-registry/scripts/lib/commands/finalize.mjs:158` (`schemaVersion: 2` → `3`)
- Modify fixtures: `scripts/fixtures/shape/good-entry.json`, `scripts/fixtures/shape/bad-entry-missing-prop.json`
- Test: `skills/figma-component-registry/scripts/figma-component-registry-pressure.mjs`

**Interfaces:**
- Produces: every `figmaBindings[]` entry now includes `componentPath: string`, `groupName: string`, `propName: string` alongside the existing `path`/`figmaType`/`mappingKind`/etc. fields. `path` is retained as a human-readable label only — Task 7 removes all code that parses it back apart.
- Consumes: nothing new from other tasks.

This is the schema v3 foundation Task 7 and Task 8 build on — do this one first among the three.

- [ ] **Step 1: Write the failing test**

Update `testFlattenBundle` in `figma-component-registry-pressure.mjs` (around line 317) to assert the new fields are present:

```js
function testFlattenBundle() {
  assert.strictEqual(mapKind('override'), 'bundle');
  assert.strictEqual(mapKind('unmapped'), 'unsupported');
  assert.strictEqual(mapKind('structural'), 'static');
  const bindings = flattenGroupsToBindings({
    componentPath: 'Checkbox',
    groups: [
      {
        name: 'Checkbox',
        mappings: [
          {
            figmaProp: 'Checked?',
            figmaType: 'VARIANT',
            mappingKind: 'bundle',
            props: ['checked', 'indeterminate'],
            valueProps: { True: { checked: true, indeterminate: false } },
          },
        ],
      },
    ],
  });
  assert.strictEqual(bindings[0].mappingKind, 'bundle');
  assert.deepStrictEqual(bindings[0].props, ['checked', 'indeterminate']);
  assert.strictEqual(bindings[0].componentPath, 'Checkbox');
  assert.strictEqual(bindings[0].groupName, 'Checkbox');
  assert.strictEqual(bindings[0].propName, 'Checked?');
  console.log('flatten bundle → PASS');
}
```

Also add a case with a `#digit:digit` suffix to prove `propName` is stripped like `path` already is — extend `testStripId` (around line 304):

```js
function testStripId() {
  assert.strictEqual(stripFigmaPropId('Show prepend#529:0'), 'Show prepend');
  assert.strictEqual(
    bindingPath({
      componentPath: 'Button',
      groupName: 'btn-size',
      figmaProp: 'Show prepend#529:0',
    }),
    'Button > btn-size > Show prepend',
  );
  const bindings = flattenGroupsToBindings({
    componentPath: 'Button',
    groups: [
      {
        name: 'btn-size',
        mappings: [
          {
            figmaProp: 'Show prepend#529:0',
            figmaType: 'BOOLEAN',
            mappingKind: 'composition',
            note: 'x',
          },
        ],
      },
    ],
  });
  assert.strictEqual(bindings[0].propName, 'Show prepend');
  console.log('path normalize → PASS');
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: FAIL — `bindings[0].componentPath`/`groupName`/`propName` are all `undefined` today.

- [ ] **Step 3: Add the structured fields in `flatten-bindings.mjs`**

Replace the full contents of `scripts/lib/domain/flatten-bindings.mjs`:

```js
import { bindingPath, stripFigmaPropId } from './path-normalize.mjs';

function mapKind(kind) {
  if (kind === 'override') return 'bundle';
  if (kind === 'unmapped') return 'unsupported';
  if (kind === 'structural') return 'static';
  return kind;
}

function propsFromValueOverrides(valueOverrides) {
  const names = new Set();
  for (const overrides of Object.values(valueOverrides ?? {})) {
    for (const prop of Object.keys(overrides ?? {})) {
      names.add(prop);
    }
  }
  return [...names];
}

function flattenMapping({ componentPath, groupName, groupFigmaNodeId, mapping }) {
  const mappingKind = mapKind(mapping.mappingKind);
  const base = {
    path: bindingPath({ componentPath, groupName, figmaProp: mapping.figmaProp }),
    componentPath,
    groupName,
    propName: stripFigmaPropId(mapping.figmaProp),
    figmaType: mapping.figmaType,
    mappingKind,
  };
  if (groupFigmaNodeId != null) {
    base.figmaNodeId = groupFigmaNodeId;
  }

  if (mappingKind === 'direct') {
    const binding = { ...base, prop: mapping.prop ?? mapping.reactProp };
    if (mapping.valueMap) binding.valueMap = mapping.valueMap;
    return binding;
  }

  if (mappingKind === 'bundle') {
    const valueProps = mapping.valueProps ?? mapping.valueOverrides;
    const props = mapping.props ?? propsFromValueOverrides(valueProps);
    return { ...base, props, valueProps };
  }

  return { ...base, note: mapping.note };
}

function flattenGroupsToBindings({ componentPath, groups }) {
  const bindings = [];
  for (const group of groups ?? []) {
    for (const mapping of group.mappings ?? []) {
      bindings.push(
        flattenMapping({
          componentPath,
          groupName: group.name,
          groupFigmaNodeId: group.figmaNodeId,
          mapping,
        }),
      );
    }
  }
  return bindings;
}
export { flattenGroupsToBindings, mapKind };
```

(Only change from the original: `stripFigmaPropId` added to the import, and `componentPath`/`groupName`/`propName` added to `base` in `flattenMapping`.)

- [ ] **Step 4: Bump schema to v3 and require the new fields**

In `scripts/schemas/registry-entry.schema.json`:

Change `"schemaVersion": { "const": 2 }` to `"schemaVersion": { "const": 3 }`.

Add `"componentPath"`, `"groupName"`, `"propName"` to the `required` array and `properties` of `directBinding`, `bundleBinding`, and `noteBinding` in `$defs`. For example, `directBinding` becomes:

```json
"directBinding": {
  "type": "object",
  "additionalProperties": false,
  "required": ["path", "componentPath", "groupName", "propName", "figmaType", "mappingKind", "prop"],
  "properties": {
    "path": { "type": "string", "minLength": 1 },
    "componentPath": { "type": "string", "minLength": 1 },
    "groupName": { "type": "string", "minLength": 1 },
    "propName": { "type": "string", "minLength": 1 },
    "figmaType": { "$ref": "#/$defs/figmaType" },
    "mappingKind": { "const": "direct" },
    "prop": { "type": "string", "minLength": 1 },
    "valueMap": {
      "type": "object",
      "additionalProperties": true
    },
    "figmaNodeId": { "type": ["string", "null"] }
  }
}
```

Apply the same three-field addition (to both `required` and `properties`) to `bundleBinding` and `noteBinding`.

- [ ] **Step 5: Bump `finalize.mjs`'s emitted `schemaVersion`**

In `scripts/lib/commands/finalize.mjs`, change the `entry` object's `schemaVersion: 2` (line 159, inside the `const entry = { ... }` block built in the per-component loop) to `schemaVersion: 3`.

- [ ] **Step 6: Update the shape fixtures to schema v3**

Replace `scripts/fixtures/shape/good-entry.json`:

```json
{
  "schemaVersion": 3,
  "component": {
    "exportName": "Button",
    "exportType": "named",
    "filePath": "src/components/ui/button.tsx"
  },
  "figma": {
    "componentPath": "Button",
    "lastKnownFileKey": "abc",
    "lastKnownNodeId": "1:2"
  },
  "codePropsMap": {
    "size": { "type": "enum", "values": ["sm", "md"] }
  },
  "figmaBindings": [
    {
      "path": "Button > btn > Size",
      "componentPath": "Button",
      "groupName": "btn",
      "propName": "Size",
      "figmaNodeId": "1:2",
      "figmaType": "VARIANT",
      "mappingKind": "direct",
      "prop": "size",
      "valueMap": { "Small": "sm", "Regular": "md" }
    }
  ]
}
```

Replace `scripts/fixtures/shape/bad-entry-missing-prop.json` (still invalid — still missing `prop` — but updated to schema v3 shape so the test exercises the *intended* invalidity, not an incidental v2/v3 mismatch):

```json
{
  "schemaVersion": 3,
  "component": {
    "exportName": "Button",
    "exportType": "named",
    "filePath": "src/components/ui/button.tsx"
  },
  "figma": {
    "componentPath": "Button",
    "lastKnownFileKey": "abc",
    "lastKnownNodeId": "1:2"
  },
  "codePropsMap": {
    "size": { "type": "enum", "values": ["sm", "md"] }
  },
  "figmaBindings": [
    {
      "path": "Button > btn > Size",
      "componentPath": "Button",
      "groupName": "btn",
      "propName": "Size",
      "figmaType": "VARIANT",
      "mappingKind": "direct",
      "valueMap": { "Small": "sm", "Regular": "md" }
    }
  ]
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: `flatten bundle → PASS`, `path normalize → PASS`, `shape good entry → PASS`, `shape bad entry → PASS`. Other tests that build registry entries inline (e.g. `testRecoverMultiGroupNodeIds`, `testFinalizeHappyPath`) will now FAIL — that's expected and fixed in Task 7 and Task 8's steps, which touch the same fixtures/assertions. Do not treat those failures as a regression to fix here; proceed to Task 7 immediately.

- [ ] **Step 8: Commit**

```bash
cd skills/figma-component-registry
git add scripts/lib/domain/flatten-bindings.mjs scripts/schemas/registry-entry.schema.json scripts/lib/commands/finalize.mjs scripts/fixtures/shape/good-entry.json scripts/fixtures/shape/bad-entry-missing-prop.json scripts/figma-component-registry-pressure.mjs
git commit -m "feat(figma-component-registry): schema v3 — structured componentPath/groupName/propName on figmaBindings"
```

---

## Task 7: Remove `parseBindingPath` string-splitting and the dead `entry.groups` fast path

**Files:**
- Modify: `skills/figma-component-registry/scripts/lib/domain/recover-groups.mjs`
- Test: `skills/figma-component-registry/scripts/figma-component-registry-pressure.mjs`

**Interfaces:**
- Consumes: `binding.componentPath`/`groupName`/`propName` from Task 6.
- Produces: `recoverGroupsFromRegistry(entry, raw)` and `bindingToMapping(binding, propertyDefinitions)` — same signatures, same return shapes as before, but `recoverGroupsFromRegistry` now throws when `entry.schemaVersion !== 3`. `parseBindingPath` is deleted (it has no other callers — confirmed via grep, only `recover-groups.mjs` itself imports/uses it).

**Bug (path parsing):** `parseBindingPath` splits `binding.path` on raw `>` instead of the `' > '` separator `bindingPath()` actually joins with. Any component/group name containing a literal `>` corrupts `groupName`/`propName` reconstruction. With Task 6's structured fields available directly on each binding, no string parsing is needed at all — this removes the entire bug class rather than patching the separator.

**Gap closed here (spec's migration requirement):** the design spec requires `finalize`/`check` to "reject any other value [than schemaVersion 3] with an explicit error" for backward compatibility (breaking change, no auto-migration). `validateRegistryEntry` (ajv against `registry-entry.schema.json`'s `"schemaVersion": { "const": 3 }`) only validates *new* entries `finalize` is about to write — it is never called on an *existing* entry being read back in. Without an explicit check, `recoverGroupsFromRegistry` reading an old schema-v2 entry (which has `path` but no `groupName`/`propName`) would silently produce a group named `undefined` instead of failing cleanly. `recoverGroupsFromRegistry` is the single chokepoint both `finalize` (via `readExistingRegistry`) and `verify-source` use to read an existing entry, so the version guard belongs there.

- [ ] **Step 1: Write the failing test**

Add a new test to `figma-component-registry-pressure.mjs`, near `testRecoverMultiGroupNodeIds`:

```js
function testRecoverGroupsSurvivesGtInName() {
  const entry = {
    schemaVersion: 3,
    component: { exportName: 'Icon', exportType: 'named', filePath: 'ui/icon.tsx' },
    figma: { componentPath: 'Icon', lastKnownNodeId: '1:1' },
    codePropsMap: {},
    figmaBindings: [
      {
        path: 'Icon > Icon > Leading',
        componentPath: 'Icon',
        groupName: 'Icon > Leading',
        propName: 'Size',
        figmaNodeId: '1:1',
        figmaType: 'VARIANT',
        mappingKind: 'direct',
        prop: 'size',
      },
    ],
  };
  const raw = {
    components: [
      { name: 'Icon > Leading', figmaNodeId: '1:1', propertyDefinitions: { Size: {} } },
    ],
  };
  const groups = recoverGroupsFromRegistry(entry, raw);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].name, 'Icon > Leading');
  assert.strictEqual(groups[0].mappings[0].figmaProp, 'Size');
  console.log('recover groups survives > in group name → PASS');
}
```

Add `testRecoverGroupsSurvivesGtInName` to the `tests` array right after `testRecoverMultiGroupNodeIds,`.

Also add a test for the version guard, right after it:

```js
function testRecoverGroupsRejectsOldSchemaVersion() {
  const oldEntry = {
    schemaVersion: 2,
    component: { exportName: 'Button', exportType: 'named', filePath: 'ui/button.tsx' },
    figma: { componentPath: 'Button', lastKnownNodeId: '1:1' },
    codePropsMap: {},
    figmaBindings: [
      { path: 'Button > btn > Size', figmaType: 'VARIANT', mappingKind: 'direct', prop: 'size' },
    ],
  };
  assert.throws(
    () => recoverGroupsFromRegistry(oldEntry, { components: [] }),
    /schemaVersion 2, expected 3/,
  );
  console.log('recover groups rejects old schemaVersion → PASS');
}
```

Add `testRecoverGroupsRejectsOldSchemaVersion` to the `tests` array right after `testRecoverGroupsSurvivesGtInName,`.

Also update the existing `testRecoverMultiGroupNodeIds` fixture (it currently omits `componentPath`/`groupName`/`propName` on its inline `figmaBindings`, which will fail once `recoverGroupsFromRegistry` stops parsing `path`): add `componentPath: 'Button'`, `groupName: 'group-a'`/`'group-b'`, and `propName: 'Size'`/`'Label'` to its two binding objects, and bump its `schemaVersion` to `3`.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: `testRecoverGroupsSurvivesGtInName` FAILs — `groups[0].name` comes out as `'Icon'` (parsed from the second-to-last `>`-split segment of `path`, which is wrong) or the group isn't found at all, since current code parses `path` instead of reading `groupName` directly. `testRecoverGroupsRejectsOldSchemaVersion` FAILs — no error is thrown today; `recoverGroupsFromRegistry` happily attempts to parse the old entry's `path` field.

- [ ] **Step 3: Rewrite `recover-groups.mjs` to use structured fields, add the version guard, drop `parseBindingPath` and the dead `entry.groups` branch**

Replace the full contents of `scripts/lib/domain/recover-groups.mjs`:

```js
import { stripFigmaPropId } from './path-normalize.mjs';

function resolveFigmaProp(propName, propertyDefinitions) {
  if (propertyDefinitions?.[propName]) return propName;
  const match = Object.keys(propertyDefinitions ?? {}).find(
    (key) => stripFigmaPropId(key) === propName,
  );
  return match ?? propName;
}

function bindingToMapping(binding, propertyDefinitions) {
  const figmaProp = resolveFigmaProp(binding.propName, propertyDefinitions);
  const mapping = {
    figmaProp,
    figmaType: binding.figmaType,
    mappingKind: binding.mappingKind,
  };

  if (binding.mappingKind === 'direct') {
    mapping.prop = binding.prop;
    if (binding.valueMap) mapping.valueMap = binding.valueMap;
  } else if (binding.mappingKind === 'bundle') {
    mapping.props = binding.props;
    mapping.valueProps = binding.valueProps;
  } else {
    mapping.note = binding.note;
  }

  return mapping;
}

function recoverGroupsFromRegistry(entry, raw) {
  if (entry.schemaVersion !== 3) {
    throw new Error(
      `registry entry for "${entry.component?.exportName ?? 'unknown'}" is schemaVersion ${entry.schemaVersion}, expected 3 — re-run fetch → finalize to regenerate it (no v2 → v3 auto-migration)`,
    );
  }

  const groupsById = new Map();
  const defaultNodeId = entry.figma?.lastKnownNodeId ?? null;

  for (const binding of entry.figmaBindings ?? []) {
    const rawByName = raw?.components?.find((candidate) => candidate.name === binding.groupName);
    const figmaNodeId =
      binding.figmaNodeId ?? rawByName?.figmaNodeId ?? defaultNodeId ?? binding.groupName;
    const key = String(figmaNodeId);

    if (!groupsById.has(key)) {
      groupsById.set(key, {
        figmaNodeId,
        name: binding.groupName,
        mappings: [],
      });
    }

    groupsById.get(key).mappings.push(bindingToMapping(binding, rawByName?.propertyDefinitions ?? {}));
  }

  return [...groupsById.values()];
}

function applyRenamedGroupNames(groups, definitions) {
  const byId = new Map(definitions.map((def) => [def.figmaNodeId, def]));
  return groups.map((group) => {
    const current = byId.get(group.figmaNodeId);
    if (current && current.name !== group.name) {
      return { ...group, name: current.name };
    }
    return group;
  });
}
export { bindingToMapping, recoverGroupsFromRegistry, applyRenamedGroupNames, resolveFigmaProp };
```

(`parseBindingPath` is gone entirely — it is no longer exported or used. The `entry.groups` fast path from the old implementation is also gone: it was dead code, since `finalize.mjs` never sets `entry.groups` on a durable entry and the v3 schema has no `groups` property.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: `recover groups survives > in group name → PASS`, `recover groups rejects old schemaVersion → PASS`, `recover multi-group node ids → PASS` (with its updated fixture), all others PASS except `testFinalizeHappyPath` and its siblings — those are fixed in Task 8.

- [ ] **Step 5: Commit**

```bash
cd skills/figma-component-registry
git add scripts/lib/domain/recover-groups.mjs scripts/figma-component-registry-pressure.mjs
git commit -m "fix(figma-component-registry): reconstruct groups from structured binding fields, not path string-splitting"
```

---

## Task 8: Lock `finalize`'s registry read-merge-write; fail cleanly on prop-removal drift

**Files:**
- Create: `skills/figma-component-registry/scripts/lib/infra/registry-lock.mjs`
- Modify: `skills/figma-component-registry/scripts/lib/commands/finalize.mjs`
- Modify fixtures: `scripts/fixtures/good-matched/_figma-props-matched.json` (no change needed — verify only), all inline `figmaBindings` fixtures inside `testFinalize*` tests that assert on `entry.schemaVersion`/`figmaBindings` shape
- Test: `skills/figma-component-registry/scripts/figma-component-registry-pressure.mjs`

**Interfaces:**
- Consumes: schema v3 entry shape from Task 6/7.
- Produces: `withRegistryLock(outPath, fn)` — exported from `registry-lock.mjs`, mirrors `withCodeCacheLock`'s shape but is generic (no cache-file-specific JSON parsing baked in): `async (outPath: string, fn: () => Promise<T>) => Promise<T>`.

**Bug:** `cmdFinalize`'s per-component loop (`finalize.mjs:109-210`) reads the existing registry entry, merges in new groups, and writes — with no mutual exclusion. Two concurrent `finalize` runs on the same component (different Figma nodes) can each read the same pre-write state and each write their own merge, silently dropping the other's carried-forward groups. Separately, `toCodePropsMap` (called at `finalize.mjs:170`) already throws when a bound code prop was removed — but uncaught, so it surfaces as a raw stack trace via the top-level `main().catch` handler in `figma-component-registry.mjs`, instead of the clean, component-scoped `❌ …` message every other `finalize` failure produces.

- [ ] **Step 1: Write the failing test for the lock**

Add `withRegistryLock` to a new import line in `figma-component-registry-pressure.mjs`: `import { withRegistryLock } from './lib/infra/registry-lock.mjs';`

Mirror the existing `testParallelCacheMerge` pattern (same file, ~line 237) exactly, but for the registry lock — this is a focused unit test of the lock primitive itself; reproducing the full two-`finalize`-processes race deterministically would be flaky, so we verify the mechanism that removes the race directly:

```js
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
```

Add `testRegistryLockSerializesConcurrentWriters` to the `tests` array.

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: FAIL — `withRegistryLock` doesn't exist yet (import error).

- [ ] **Step 3: Implement `registry-lock.mjs`**

Create `scripts/lib/infra/registry-lock.mjs`:

```js
import fs from 'fs';
import path from 'path';
import lockfile from 'proper-lockfile';
import { ensureDir } from './fs-atomic.mjs';

async function withRegistryLock(outPath, fn) {
  const lockTarget = `${outPath}.lock`;
  ensureDir(path.dirname(lockTarget));
  if (!fs.existsSync(lockTarget)) fs.writeFileSync(lockTarget, '');
  const release = await lockfile.lock(lockTarget, {
    retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 1000 },
    stale: 10000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
export { withRegistryLock };
```

(Same lock parameters as `withCodeCacheLock` in `cache-io.mjs`, for consistency. Locks a sibling `<outPath>.lock` file rather than `outPath` itself, so the real registry JSON is never touched by lock bookkeeping — `proper-lockfile` requires its target to exist, and creating an empty placeholder `.lock` file is harmless, unlike writing a placeholder into the real entry.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: `registry lock serializes concurrent read-merge-write → PASS`.

- [ ] **Step 5: Write the failing test for clean prop-removal-drift errors**

Add to `figma-component-registry-pressure.mjs`, near `testFinalizeIncompatibleRename`:

```js
async function testFinalizeReportsPropRemovalCleanly() {
  const { dir, cacheDir, sharedCachePath } = stageFinalizeProject();
  const cache = JSON.parse(fs.readFileSync(sharedCachePath, 'utf8'));
  for (const entry of Object.values(cache)) {
    for (const component of Object.values(entry.components ?? {})) {
      delete component.props.size; // remove a code prop the fixture's matched artifact binds to
    }
  }
  fs.writeFileSync(sharedCachePath, JSON.stringify(cache));

  const { exitCode, output } = await runFinalize({ 'cache-dir': cacheDir, 'project-root': dir });

  assert.strictEqual(exitCode, 1, `expected exit 1; output:\n${output}`);
  assert.ok(output.includes('❌ Button:'), `expected clean component-scoped error; output:\n${output}`);
  assert.ok(
    output.includes('missing code prop "size"'),
    `expected prop-removal message; output:\n${output}`,
  );
  assert.ok(
    !output.toLowerCase().includes('at object.<anonymous>') && !output.includes('.mjs:'),
    `expected no raw stack trace; output:\n${output}`,
  );
  console.log('finalize reports prop-removal drift cleanly → PASS');
}
```

Add `testFinalizeReportsPropRemovalCleanly` to the `tests` array right after `testFinalizeIncompatibleRename,`.

- [ ] **Step 6: Run test to verify it fails**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: FAIL — today `toCodePropsMap`'s thrown error propagates uncaught out of `cmdFinalize`; `runFinalize`'s harness only swallows errors whose message starts with `"exit:"` (i.e., ones that went through `process.exit`), so this test's own `try`/`catch` around `cmdFinalize` (inside `runFinalize`, not shown to this task but already in the file) re-throws it — the test itself will error out rather than observing exit code 1 with a clean message.

- [ ] **Step 7: Wrap `finalize.mjs`'s per-component body in the lock, and catch `toCodePropsMap` cleanly**

Replace the full per-component `for` loop body in `scripts/lib/commands/finalize.mjs` (currently lines 109-210, from `for (const component of matched.components) {` through the closing `}` right before `if (dryRun) { ... }` at the end of the function). Add the import `import { withRegistryLock } from '../infra/registry-lock.mjs';` near the other imports at the top of the file.

```js
  for (const component of matched.components) {
    const codeComponent = findCodeComponent(codeRaw, component.codeComponent, component.codeFile);
    if (!codeComponent) {
      console.error(`❌ Missing code component ${component.codeComponent} (${component.codeFile})`);
      process.exit(1);
    }

    const outPath = registryFilePath({
      projectRoot,
      registryRoot,
      sourceRoot,
      filePath: component.codeFile,
      exportName: component.codeComponent,
    });

    await withRegistryLock(outPath, async () => {
      const existing = readExistingRegistry(outPath);
      const existingGroups = existing ? recoverGroupsFromRegistry(existing, raw) : [];
      const mergedGroups = mergeGroups(existingGroups, component.groups);
      const mergedCount = mergedGroups.length - component.groups.length;
      if (mergedCount > 0) {
        console.log(
          `   ${component.codeComponent}: carrying forward ${mergedCount} group(s) from previous sync`,
        );
      }

      let definitions;
      try {
        definitions = await definitionsForMergedGroups(
          mergedGroups,
          raw,
          existing?.figma?.lastKnownFileKey ?? raw.fileKey,
          fetchOptions,
        );
      } catch (error) {
        console.error(
          `❌ ${component.codeComponent}: ${error instanceof Error ? error.message : error}`,
        );
        process.exit(1);
      }

      const groupsWithNames = applyRenamedGroupNames(mergedGroups, definitions);
      const componentPath = component.codeComponent;
      const figmaBindings = flattenGroupsToBindings({
        componentPath,
        groups: groupsWithNames,
      });

      const primaryNodeId =
        groupsWithNames[0]?.figmaNodeId ?? existing?.figma?.lastKnownNodeId ?? null;

      let codePropsMap;
      try {
        codePropsMap = toCodePropsMap(codeComponent.props, figmaBindings);
      } catch (error) {
        console.error(
          `❌ ${component.codeComponent}: ${error instanceof Error ? error.message : error}`,
        );
        process.exit(1);
      }

      const entry = {
        schemaVersion: 3,
        component: {
          exportName: component.codeComponent,
          exportType: codeComponent.exportType ?? 'named',
          filePath: component.codeFile,
        },
        figma: {
          componentPath,
          lastKnownFileKey: raw.fileKey ?? existing?.figma?.lastKnownFileKey ?? null,
          lastKnownNodeId: primaryNodeId,
        },
        codePropsMap,
        figmaBindings,
      };

      const entryValidation = validateRegistryEntry(entry);
      if (!entryValidation.ok) {
        console.error(`❌ Registry entry invalid for ${component.codeComponent}:`);
        entryValidation.errors.forEach((problem) => console.error(`   - ${problem}`));
        process.exit(1);
      }

      if (dryRun) {
        const before = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
        const after = `${JSON.stringify(entry, null, 2)}\n`;
        const status = before === '' ? 'new file' : before === after ? 'unchanged' : 'would update';
        previewedFiles.push({ outPath, status });
        console.log(`🔍 [dry-run] ${status}: ${outPath}`);
        if (status === 'would update' || status === 'new file') {
          console.log(
            createTwoFilesPatch(
              'registry (before)',
              'registry (after)',
              before,
              after,
              '',
              '',
              { context: 2 },
            ),
          );
        }
      } else {
        ensureDir(path.dirname(outPath));
        writeJsonAtomic(outPath, entry);
        writtenFiles.push(outPath);
      }
      summaries.push({
        component: component.codeComponent,
        groups: groupsWithNames,
        mappings: groupsWithNames.flatMap((group) => group.mappings ?? []),
      });
    });
  }
```

Note: `process.exit(1)` calls inside the locked callback terminate the process before the lock's `finally { await release(); }` runs, leaving the `.lock` file held. This is intentional and matches the existing `withCodeCacheLock` pattern (same `stale: 10000` option) — a killed/exited process's lock is reclaimable by the next run after the 10-second stale timeout, so a hard failure never permanently wedges future `finalize` runs on that component.

- [ ] **Step 8: Fix up remaining schema-v3 fallout in the finalize/recover-groups tests**

Run: `node scripts/figma-component-registry-pressure.mjs` and read the failures. Update any remaining inline `figmaBindings`/`schemaVersion` fixtures inside `testFinalizeSameIdRename` and similar tests in the same style as Task 6 Step 6/Task 7 Step 1 — add `componentPath`/`groupName`/`propName` to any hand-written binding objects those tests construct, and change any `schemaVersion: 2` assertion on a **registry entry** (not on `matched`, which stays 2) to `3`. `testFinalizeHappyPath`'s `assert.strictEqual(entry.schemaVersion, 2);` becomes `assert.strictEqual(entry.schemaVersion, 3);`.

- [ ] **Step 9: Run the full suite to verify everything passes**

Run: `node scripts/figma-component-registry-pressure.mjs`
Expected: all tests, old and new, PASS (should be 38 original + 10 new = 48).

- [ ] **Step 10: Commit**

```bash
cd skills/figma-component-registry
git add scripts/lib/infra/registry-lock.mjs scripts/lib/commands/finalize.mjs scripts/figma-component-registry-pressure.mjs
git commit -m "fix(figma-component-registry): lock finalize's registry read-merge-write; fail cleanly on prop-removal drift"
```

---

## Task 9: Update `SKILL.md` and `references/schema.md` for schema v3

**Files:**
- Modify: `skills/figma-component-registry/SKILL.md`
- Modify: `skills/figma-component-registry/references/schema.md`

**Interfaces:** None — documentation only, no code.

- [ ] **Step 1: Update `references/schema.md`**

In the "Durable registry entry" example (currently showing `"schemaVersion": 2` and bindings without `componentPath`/`groupName`/`propName`), update to schema v3: bump `schemaVersion` to `3`, and add `componentPath`, `groupName`, `propName` to every example binding (`direct`, `bundle`, `composition`, `unsupported`, `static`), matching the real shape `flattenGroupsToBindings` now produces (Task 6). Add one sentence noting `path` is retained purely as a human-readable label — no code parses it back apart, so a group/component name containing `>` is safe.

Also add a short paragraph (near "Finalize rejects") documenting the ambiguous-`exportName` failure mode: `verify-source`/`check --components` fail with every matching path listed when 2+ registry files share an `exportName` across areas, instead of silently picking one.

- [ ] **Step 2: Update `SKILL.md`**

- In the version note block near the top, or in "Storage", add a line: `finalize` serializes concurrent writes to the same `registry/<area>/<Export>.json` via a sibling `<file>.lock` (created on first use, harmless if committed but safe to gitignore — e.g. `registry/**/*.lock`).
- In "mappingKind reference" / near the durable `path` field description, note the schema-v3 structured fields (`componentPath`/`groupName`/`propName`) are now the source of truth for group/prop identity; `path` is a display-only label.
- Add one sentence under "Extra flags" or "Workflow" noting `extract-code`/`check` now skip and warn on a single file that fails extraction, rather than aborting the whole run.

- [ ] **Step 3: Commit**

```bash
cd skills/figma-component-registry
git add SKILL.md references/schema.md
git commit -m "docs(figma-component-registry): document schema v3, registry locking, and per-file extraction isolation"
```

---

## Task 10: Full regression pass

**Files:** none (verification only).

- [ ] **Step 1: Run the full pressure suite one more time from a clean install**

```bash
cd skills/figma-component-registry/scripts
rm -rf node_modules
npm install --silent
node figma-component-registry-pressure.mjs
```
Expected: every test PASSes (48 total: 38 original + 10 new from Tasks 1-8).

- [ ] **Step 2: Confirm `evals.json` scenarios are unaffected**

Read `skills/figma-component-registry/evals/evals.json` and confirm none of its 10 `expected_output`/`expectations` strings reference `schemaVersion`, `figmaBindings` shape, or any of the fixed bugs directly (per the design spec, they shouldn't — they test triggering behavior, not internal schema). No changes expected here; this step is a sanity check, not an edit.

- [ ] **Step 3: Final review of the diff**

```bash
git diff feat/skill-figma-component-registry...fix/figma-component-registry-hardening --stat
```
Confirm the change set matches the 9 fixes + schema v3 + docs — no unrelated files touched.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin fix/figma-component-registry-hardening
gh pr create --base feat/skill-figma-component-registry --title "fix(figma-component-registry): harden registry writes, path parsing, and error isolation" --body "$(cat <<'EOF'
## Summary
- Fixes 9 concrete bugs found in code review: registry write race condition, `>`-in-name path-parsing corruption, dead `entry.groups` field, silent Vue/React extraction abort on one bad file, non-deterministic exportName lookup, string-prefix cache-path mismatches, uncaught prop-removal errors, verify-source only reporting the first stale prop, and exportName path-traversal.
- Bumps the durable registry entry to schema v3 (structured `componentPath`/`groupName`/`propName` fields; `path` is now display-only).
- Rejected approaches (content-addressed storage, apiVersion-string versioning, v2→v3 auto-migration) are documented in `docs/superpowers/specs/2026-07-30-figma-component-registry-hardening-design.md` along with why.

## Test plan
- [ ] `node scripts/figma-component-registry-pressure.mjs` passes (46/46)
- [ ] `SKILL.md` / `references/schema.md` reviewed for accuracy against the new schema v3 shape

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Note:** this PR targets `feat/skill-figma-component-registry` (still open as PR #2, unmerged), not `main` — the hardening branch was created off it per the user's explicit choice, so it should land there first.
