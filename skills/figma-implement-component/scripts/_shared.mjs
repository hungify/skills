// Shared helpers for the figma-implement-component gate scripts.
// Kept dependency-free (only node: builtins) so every script that imports
// this still runs with plain `node`, no install step.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key || !key.startsWith("--")) continue;
    out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sha256(filePath) {
  return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
}

export function isPathUnderDir(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function repoRelative(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

// Read + JSON.parse `filePath`, exiting the process on failure.
// - No label: two separate messages ("Could not read file" / "Invalid JSON").
// - With a label: one combined "{label} could not be read or is not valid
//   JSON" message, since the caller already has a more specific noun than
//   "file" (e.g. "Coverage", "Figloom manifest").
export function loadJson(filePath, { label, exitCode = 1 } = {}) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    console.error(
      label
        ? `${label} could not be read or is not valid JSON: ${filePath}\n${e.message}`
        : `Could not read file: ${filePath}\n${e.message}`,
    );
    process.exit(exitCode);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(
      label
        ? `${label} could not be read or is not valid JSON: ${filePath}\n${e.message}`
        : `Invalid JSON: ${filePath}\n${e.message}`,
    );
    process.exit(exitCode);
  }
}

// Resolve `filePath` under `repoRoot` and exit if it doesn't exist. Does NOT
// check that the resolved path stays under repoRoot — only use this for
// paths that come from CLI flags the invoking agent/human typed directly,
// never for a path read out of a JSON file (use resolveFileWithinRoot below
// for that — it adds the traversal check this one skips).
export function resolveFile(repoRoot, filePath, label, exitCode = 2) {
  const resolved = path.resolve(repoRoot, filePath);
  if (!existsSync(resolved)) {
    console.error(`${label} does not exist: ${filePath}`);
    process.exit(exitCode);
  }
  return resolved;
}

// Resolve `filePath` under `repoRoot`, rejecting empty paths and paths that
// escape repoRoot (`..`, or absolute somewhere else). Use this whenever
// `filePath` comes from a less-trusted source, e.g. a field inside a JSON
// manifest, rather than a CLI flag typed directly.
export function resolveFileWithinRoot(repoRoot, filePath, label, mustExist = true, exitCode = 2) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    console.error(`${label} is missing a path.`);
    process.exit(exitCode);
  }
  const resolved = path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    console.error(`${label} must be under the repo root: ${filePath}`);
    process.exit(exitCode);
  }
  if (mustExist && !existsSync(resolved)) {
    console.error(`${label} does not exist: ${filePath}`);
    process.exit(exitCode);
  }
  return resolved;
}

// Derive the canonical registry entry path (registry/<area>/<ExportName>.json)
// that figma-component-registry would look up for `registryEntry.component.filePath`.
// Returns null if the component file isn't under sourceRoot.
export function canonicalRegistryPath(repoRoot, registryRoot, sourceRoot, registryEntry) {
  const sourceRootAbs = path.resolve(repoRoot, sourceRoot);
  const componentFile = path.resolve(repoRoot, registryEntry.component?.filePath || "");
  if (!isPathUnderDir(componentFile, sourceRootAbs)) return null;
  const area = path.dirname(path.relative(sourceRootAbs, componentFile));
  return path.resolve(
    repoRoot,
    registryRoot,
    area === "." ? "" : area,
    `${registryEntry.component.exportName}.json`,
  );
}
