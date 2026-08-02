#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { repoRelative, sha256 } from "./_shared.mjs";

const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(scriptDir, "fixtures", "button-gate");
const tempDir = mkdtempSync(path.join(tmpdir(), "figma-implement-component-"));
const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
let smokeServer;

function run(script, args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [path.join(scriptDir, script), ...args], { encoding: "utf8" });
  assert.equal(
    result.status,
    expectedStatus,
    `${script} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function runFigloom(args, cwd, expectedStatus = 0) {
  const result = spawnSync(
    "npm",
    ["exec", "--yes", "--package=figloom-verify@0.0.3", "--", "figloom", ...args],
    { cwd, encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(
    result.status,
    expectedStatus,
    `figloom ${args[0]} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function gateArgs({ dedupFile, coverageFile, evidenceFile, out }) {
  return [
    "--component-name", "Button",
    "--component-file", "src/components/ui/button.tsx",
    "--registry-path", "registry/ui/Button.json",
    "--export-name", "Button",
    "--dedup", dedupFile,
    "--coverage", coverageFile,
    "--registry-evidence", "src/components/ui/button.registry-evidence.json",
    "--behavior-evidence", "src/components/ui/button.behavior-evidence.json",
    "--harness-file", "src/components/ui/button-showcase.tsx",
    "--testids-file", "src/components/ui/button-showcase.testids.ts",
    "--total-states", "6",
    "--repo-root", tempDir,
    "--figloom-evidence", repoRelative(tempDir, evidenceFile),
    "--out", out,
  ];
}

function writeFigloomFixture(coverage) {
  const root = path.join(tempDir, ".figloom", "artifacts", "visual-verifications", "button");
  mkdirSync(root, { recursive: true });
  const target = { kind: "web", url: "http://127.0.0.1:3000/components/button" };
  const capturedAt = new Date().toISOString();
  const contracts = [];
  const results = [];

  coverage.expectedTestids.forEach((testid, index) => {
    const id = testid.replaceAll("_", "-");
    const outDir = `.figloom/artifacts/visual-verifications/button/${id}`;
    const absoluteOutDir = path.join(tempDir, outDir);
    mkdirSync(absoluteOutDir, { recursive: true });
    for (const file of ["figma-gold.png", "actual.png", "diff.png"]) {
      writeFileSync(path.join(absoluteOutDir, file), PNG_FIXTURE);
    }
    const baselinePath = path.join(absoluteOutDir, "figma-gold.png");
    const baselineMetaPath = path.join(absoluteOutDir, "figma-gold.meta.json");
    const actualPath = path.join(absoluteOutDir, "actual.png");
    const diffPath = path.join(absoluteOutDir, "diff.png");
    const nodeId = `100:${index + 1}`;
    const expectSize = { width: 120 + index, height: 40 };
    const selector = `[data-testid="${testid}"]`;
    const viewport = { name: `component-${id}`, width: 800, height: 600 };
    writeFileSync(baselineMetaPath, JSON.stringify({ fileKey: "fixture-file-key", nodeId, fetchedAt: capturedAt, lastModified: null }));
    const baseline = {
      kind: "figma",
      path: baselinePath,
      metaPath: baselineMetaPath,
      fileKey: "fixture-file-key",
      nodeId,
      fetchedAt: capturedAt,
      lastModified: null,
    };
    const contract = {
      id,
      baseline: { kind: "figma", fileKey: "fixture-file-key", nodeId },
      viewport,
      outDir,
      scope: { kind: "region", selector, expectSize },
      profile: "component/strict",
    };
    const evidenceHashes = {
      baseline: sha256(baselinePath),
      baselineMeta: sha256(baselineMetaPath),
      actual: sha256(actualPath),
      diff: sha256(diffPath),
    };
    writeFileSync(path.join(absoluteOutDir, "visual-score.json"), JSON.stringify({
      schemaVersion: 4,
      ok: true,
      pass: true,
      runType: "final",
      capturedAt,
      target,
      profile: "component/strict",
      viewport: viewport.name,
      pageReason: null,
      selector,
      expectSize,
      maskSelectors: null,
      baseline,
      stability: "stable",
      diffPixels: 0,
      outDir: absoluteOutDir,
      evidenceHashes,
      topIssues: [],
    }));
    writeFileSync(path.join(absoluteOutDir, "run-meta.json"), JSON.stringify({
      schemaVersion: 4,
      target,
      baseline,
      selector,
      viewport: viewport.name,
      viewportSize: { width: viewport.width, height: viewport.height },
      profile: "component/strict",
      pageReason: null,
      runType: "final",
      expectSize,
      maskSelectors: null,
      actualPath,
      capturedAt,
      stability: "stable",
      stabilitySamples: 3,
      warnings: [],
    }));
    writeFileSync(path.join(absoluteOutDir, "punch-list.json"), JSON.stringify({ schemaVersion: 4, fidelityScore: 100, pass: true, items: [] }));
    contracts.push(contract);
    results.push({ id, ok: true, pass: true, outDir: absoluteOutDir });
  });

  const verificationPath = path.join(root, "visual-verification.json");
  writeFileSync(verificationPath, JSON.stringify({
    schemaVersion: 4,
    kind: "figloom.visual-verification",
    createdAt: capturedAt,
    projectRoot: tempDir,
    ok: true,
    allPassed: true,
    request: { schemaVersion: 4, target, contracts },
    results,
  }));
  const manifestPath = path.join(root, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    artifacts: [{ verificationArtifactPath: repoRelative(tempDir, verificationPath) }],
  }));
  return { root, verificationPath, manifestPath };
}

function realVerifySmoke() {
  const port = 39000 + (process.pid % 1000);
  const serverFile = path.join(tempDir, "smoke-server.mjs");
  writeFileSync(serverFile, `
    import http from "node:http";
    const html = '<!doctype html><style>html,body{margin:0}#box{width:80px;height:40px;background:#1565c0}</style><div id="box"></div>';
    http.createServer((_req,res)=>{res.writeHead(200,{"content-type":"text/html"});res.end(html)}).listen(${port}, "127.0.0.1");
  `);
  smokeServer = spawn(process.execPath, [serverFile], { stdio: "ignore" });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = spawnSync("curl", ["-fsS", `http://127.0.0.1:${port}`], { stdio: "ignore" });
    if (probe.status === 0) { ready = true; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  assert.equal(ready, true, "real Figloom smoke server did not start");

  const contractPath = path.join(tempDir, "real-verify-contract.json");
  const outputPath = path.join(tempDir, "real-verify-artifact.json");
  const url = `http://127.0.0.1:${port}`;
  writeFileSync(contractPath, JSON.stringify({
    schemaVersion: 4,
    target: { kind: "web", url },
    contracts: [{
      id: "smoke.box",
      baseline: { kind: "web", url, revision: "fixture-v1" },
      viewport: { name: "smoke", width: 320, height: 200 },
      outDir: ".figloom/artifacts/visual-verifications/smoke/box",
      scope: { kind: "region", selector: "#box", expectSize: { width: 80, height: 40 } },
      profile: "component/strict",
    }],
  }));
  runFigloom(["verify", "--project-root", tempDir, "--contract", contractPath, "--output", outputPath], tempDir);
  const artifact = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(artifact.schemaVersion, 4);
  assert.equal(artifact.kind, "figloom.visual-verification");
  assert.equal(artifact.allPassed, true);
  runFigloom(["done-gate", "--artifact", outputPath], tempDir);
}

try {
  const registry = path.join(fixtureDir, "registry-entry.json");
  const testids = path.join(fixtureDir, "button-showcase.testids.ts");
  const harness = path.join(fixtureDir, "button-showcase.tsx");
  const figmaOptions = path.join(fixtureDir, "figma-options.json");
  const dedupFile = path.join(tempDir, "dedup.json");
  const coverageFile = path.join(tempDir, "coverage.json");

  run("validate_registry_entry.mjs", [registry]);
  const dedupRun = run("dedup_bindings.mjs", [registry]);
  writeFileSync(dedupFile, dedupRun.stdout);
  const dedup = JSON.parse(dedupRun.stdout);
  assert.equal(dedup.props.variant.canonicalFigmaNodeId, "28:518");
  assert.equal(dedup.props.variant.redundant[0].figmaNodeId, "28:383");

  const coverageRun = run("coverage_check.mjs", [
    "--registry", registry,
    "--dedup", dedupFile,
    "--testids", testids,
    "--harness", harness,
    "--component", "button",
    "--figma-options", figmaOptions,
  ]);
  writeFileSync(coverageFile, coverageRun.stdout);
  const coverage = JSON.parse(coverageRun.stdout);
  assert.deepEqual(coverage.visualGaps, []);
  assert.equal(coverage.harnessVerified, true);
  assert.equal(coverage.expectedTestids.length, 6);

  const componentDir = path.join(tempDir, "src", "components", "ui");
  const registryDir = path.join(tempDir, "registry", "ui");
  mkdirSync(componentDir, { recursive: true });
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(path.join(componentDir, "button.tsx"), "export function Button() { return null; }\n");
  copyFileSync(registry, path.join(registryDir, "Button.json"));
  copyFileSync(harness, path.join(componentDir, "button-showcase.tsx"));
  copyFileSync(testids, path.join(componentDir, "button-showcase.testids.ts"));
  copyFileSync(path.join(fixtureDir, "behavior-evidence.json"), path.join(componentDir, "button.behavior-evidence.json"));

  const fakeRegistryCli = path.join(tempDir, "fake-registry-cli.mjs");
  writeFileSync(fakeRegistryCli, `const command=process.argv[2];if(!new Set(["check","verify-source"]).has(command))process.exit(2);console.log("OK: "+command);\n`);
  run("verify_registry_freshness.mjs", [
    "--registry-cli", fakeRegistryCli,
    "--registry", "registry/ui/Button.json",
    "--component", "Button",
    "--project-root", tempDir,
    "--out", path.join(componentDir, "button.registry-evidence.json"),
  ]);
  const projectCoverage = run("coverage_check.mjs", [
    "--registry", path.join(registryDir, "Button.json"),
    "--dedup", dedupFile,
    "--testids", path.join(componentDir, "button-showcase.testids.ts"),
    "--harness", path.join(componentDir, "button-showcase.tsx"),
    "--component", "button",
    "--figma-options", figmaOptions,
  ]);
  writeFileSync(coverageFile, projectCoverage.stdout);

  const figloom = writeFigloomFixture(JSON.parse(projectCoverage.stdout));
  const evidenceFile = path.join(figloom.root, "figloom-evidence.json");
  run("validate_figloom_evidence.mjs", [
    "--coverage", repoRelative(tempDir, coverageFile),
    "--manifest", repoRelative(tempDir, figloom.manifestPath),
    "--repo-root", tempDir,
    "--out", repoRelative(tempDir, evidenceFile),
  ]);
  const evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
  assert.equal(evidence.package, "figloom-verify@0.0.3");
  assert.equal(evidence.artifacts.length, 1);

  const artifactFile = path.join(tempDir, "button.implementation.json");
  run("generate_gate_artifact.mjs", gateArgs({ dedupFile, coverageFile, evidenceFile, out: artifactFile }));
  const artifact = JSON.parse(readFileSync(artifactFile, "utf8"));
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const validateGate = ajv.compile(JSON.parse(readFileSync(path.join(scriptDir, "..", "references", "gate-artifact.schema.json"), "utf8")));
  assert.equal(validateGate(artifact), true, JSON.stringify(validateGate.errors));
  assert.equal(artifact.schemaVersion, 3);
  assert.equal(artifact.status, "pending-human-review");
  assert.equal("fidelity" in artifact, false);
  assert.deepEqual(artifact.figloomEvidence, evidence.artifacts);

  const noEvidence = run("generate_gate_artifact.mjs", gateArgs({
    dedupFile,
    coverageFile,
    evidenceFile,
    out: path.join(tempDir, "no-evidence.json"),
  }).filter((value, index, args) => args[index - 1] !== "--figloom-evidence" && value !== "--figloom-evidence"), 2);
  assert.match(noEvidence.stderr, /Missing --figloom-evidence/);

  const staleArtifact = readFileSync(figloom.verificationPath, "utf8");
  writeFileSync(figloom.verificationPath, `${staleArtifact}\n`);
  const staleRun = run("generate_gate_artifact.mjs", gateArgs({
    dedupFile,
    coverageFile,
    evidenceFile,
    out: path.join(tempDir, "stale.json"),
  }), 2);
  assert.match(staleRun.stderr, /stale or has a mismatched hash/);
  writeFileSync(figloom.verificationPath, staleArtifact);

  const invalidArtifact = JSON.parse(staleArtifact);
  invalidArtifact.request.contracts[0].profile = "component/dev";
  const invalidPath = path.join(figloom.root, "invalid-verification.json");
  writeFileSync(invalidPath, JSON.stringify(invalidArtifact));
  const invalidManifest = path.join(figloom.root, "invalid-manifest.json");
  writeFileSync(invalidManifest, JSON.stringify({ schemaVersion: 1, artifacts: [{ verificationArtifactPath: repoRelative(tempDir, invalidPath) }] }));
  const invalidRun = run("validate_figloom_evidence.mjs", [
    "--coverage", repoRelative(tempDir, coverageFile),
    "--manifest", repoRelative(tempDir, invalidManifest),
    "--repo-root", tempDir,
    "--out", repoRelative(tempDir, path.join(figloom.root, "invalid-evidence.json")),
  ], 2);
  assert.match(invalidRun.stderr, /component\/strict region/);

  const mismatchedCount = [...gateArgs({ dedupFile, coverageFile, evidenceFile, out: path.join(tempDir, "count.json") })];
  mismatchedCount[mismatchedCount.indexOf("--total-states") + 1] = "999";
  assert.match(run("generate_gate_artifact.mjs", mismatchedCount, 2).stderr, /coverage\.expectedTestids\.length/);

  const marker = path.join(tempDir, "injection-ran");
  const maliciousTestids = path.join(tempDir, "malicious.testids.ts");
  writeFileSync(maliciousTestids, `export const TESTIDS=(()=>{require("node:fs").writeFileSync(${JSON.stringify(marker)},"bad");return {}})();\n`);
  const maliciousRun = run("coverage_check.mjs", [
    "--registry", registry,
    "--dedup", dedupFile,
    "--testids", maliciousTestids,
    "--harness", harness,
    "--component", "button",
  ], 1);
  assert.match(maliciousRun.stderr, /Could not parse testids file/);
  assert.equal(existsSync(marker), false);

  realVerifySmoke();
  console.log("figma-implement-component pressure suite: PASS");
} finally {
  smokeServer?.kill("SIGTERM");
  rmSync(tempDir, { recursive: true, force: true });
}
