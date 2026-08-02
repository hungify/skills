#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadJson, parseArgs, repoRelative, resolveFileWithinRoot, sha256 } from "./_shared.mjs";

const FIGLOOM_PACKAGE = "figloom-verify@0.0.3";
const FIGLOOM_SCHEMA_VERSION = 4;
const FIGMA_NODE_ID = /^(?:I\d+:\d+(?:;\d+:\d+)+|\d+:\d+)$/;

function fail(message) {
  console.error(message);
  process.exit(2);
}

function selectorTestid(selector) {
  if (typeof selector !== "string") return null;
  const match = selector.match(/^\[data-testid=(?:"([^"]+)"|'([^']+)')\]$/);
  return match?.[1] ?? match?.[2] ?? null;
}

function expectedTestids(coverage) {
  if (!Array.isArray(coverage.expectedTestids)) {
    fail("coverage.expectedTestids must be an array (empty if the component has no visual state).");
  }
  const expected = new Set();
  for (const testid of coverage.expectedTestids) {
    if (typeof testid !== "string" || testid.length === 0 || expected.has(testid)) {
      fail(`Coverage has an empty or duplicate testid: ${testid ?? "<missing>"}.`);
    }
    expected.add(testid);
  }
  return expected;
}

function validateCoverageContracts(artifact, expected, seen, artifactPath, repoRoot) {
  if (
    artifact.schemaVersion !== FIGLOOM_SCHEMA_VERSION ||
    artifact.kind !== "figloom.visual-verification" ||
    typeof artifact.projectRoot !== "string" ||
    artifact.projectRoot.length === 0 ||
    path.resolve(artifact.projectRoot) !== repoRoot ||
    artifact.request?.schemaVersion !== FIGLOOM_SCHEMA_VERSION ||
    !Array.isArray(artifact.request.contracts) ||
    artifact.request.contracts.length < 1 ||
    artifact.request.contracts.length > 8
  ) {
    fail(`Figloom verification artifact is not a valid schema-v4 artifact: ${artifactPath}.`);
  }
  for (const contract of artifact.request.contracts) {
    const testid = selectorTestid(contract.scope?.selector);
    if (
      !testid ||
      !expected.has(testid) ||
      seen.has(testid) ||
      contract.profile !== "component/strict" ||
      contract.scope?.kind !== "region" ||
      !Number.isFinite(contract.scope.expectSize?.width) ||
      contract.scope.expectSize.width <= 0 ||
      !Number.isFinite(contract.scope.expectSize?.height) ||
      contract.scope.expectSize.height <= 0 ||
      contract.baseline?.kind !== "figma" ||
      typeof contract.baseline.fileKey !== "string" ||
      contract.baseline.fileKey.length === 0 ||
      !FIGMA_NODE_ID.test(contract.baseline.nodeId ?? "")
    ) {
      fail(`Contract does not map 1:1 onto coverage via a Figma component/strict region: ${contract?.id ?? "<missing>"}.`);
    }
    seen.add(testid);
  }
}

function runDoneGate(artifactPath, repoRoot) {
  const result = spawnSync(
    "npm",
    ["exec", "--yes", `--package=${FIGLOOM_PACKAGE}`, "--", "figloom", "done-gate", "--artifact", artifactPath],
    { cwd: repoRoot, encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error) {
    fail(`Could not run Figloom done-gate for ${artifactPath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`Figloom done-gate failed for ${artifactPath} (exit ${result.status}).\n${result.stderr || result.stdout || "<no output>"}`);
  }
  let verdict;
  try {
    verdict = JSON.parse(result.stdout);
  } catch (error) {
    fail(`Figloom done-gate did not return valid JSON for ${artifactPath}.\n${error.message}`);
  }
  if (verdict.schemaVersion !== FIGLOOM_SCHEMA_VERSION || verdict.done !== true) {
    fail(`Figloom done-gate has not passed for ${artifactPath}.`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const key of ["coverage", "out"]) if (!args[key]) fail(`Missing --${key}.`);
  const repoRoot = path.resolve(args["repo-root"] ?? ".");
  const coveragePath = resolveFileWithinRoot(repoRoot, args.coverage, "Coverage");
  const outputPath = resolveFileWithinRoot(repoRoot, args.out, "Output", false);
  const coverage = loadJson(coveragePath, { label: "Coverage", exitCode: 2 });
  const expected = expectedTestids(coverage);

  const seen = new Set();
  const evidence = [];

  if (expected.size === 0) {
    // Component with 0 expected visual states (every binding is composition/
    // unsupported/static) — nothing for Figloom to verify, --manifest is not
    // required; generate_gate_artifact.mjs accepts an empty figloomEvidence
    // when harness.totalStates == 0 (see gate-artifact.schema.json).
    if (args.manifest) fail("Coverage has no expectedTestids; --manifest must not be passed.");
  } else {
    if (!args.manifest) fail("Missing --manifest (required when coverage.expectedTestids is non-empty).");
    const manifestPath = resolveFileWithinRoot(repoRoot, args.manifest, "Figloom manifest");
    const manifest = loadJson(manifestPath, { label: "Figloom manifest", exitCode: 2 });
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
      fail("Figloom manifest must have schemaVersion 1 and a non-empty artifacts[].");
    }

    const artifactPaths = new Set();
    for (const entry of manifest.artifacts) {
      const artifactPath = resolveFileWithinRoot(repoRoot, entry?.verificationArtifactPath, "Figloom verification artifact");
      const relativePath = repoRelative(repoRoot, artifactPath);
      if (artifactPaths.has(relativePath)) fail(`Figloom manifest has a duplicate artifact: ${relativePath}.`);
      const artifact = loadJson(artifactPath, { label: "Figloom verification artifact", exitCode: 2 });
      validateCoverageContracts(artifact, expected, seen, artifactPath, repoRoot);
      runDoneGate(artifactPath, repoRoot);
      evidence.push({ verificationArtifactPath: relativePath, verificationArtifactHash: sha256(artifactPath) });
      artifactPaths.add(relativePath);
    }
    if (seen.size !== expected.size) {
      fail(`Figloom artifacts do not cover all expected testids: ${[...expected].filter((id) => !seen.has(id)).join(", ")}.`);
    }
  }

  writeFileSync(outputPath, `${JSON.stringify({
    schemaVersion: 1,
    package: FIGLOOM_PACKAGE,
    coveragePath: repoRelative(repoRoot, coveragePath),
    coverageHash: sha256(coveragePath),
    artifacts: evidence,
  }, null, 2)}\n`, "utf8");
  console.log(`Wrote ${evidence.length} Figloom verification artifact reference(s): ${args.out}`);
}

main();
