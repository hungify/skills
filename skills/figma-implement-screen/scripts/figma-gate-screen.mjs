#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getFrameworkAdapter } from "./adapters/index.mjs";
import {
  componentRegistryCommand,
  loadScreenConfig,
  visualVerifyCommand,
} from "./screen-config.mjs";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const componentGate = path.join(scriptDir, "figma-gate-screen-components-internal.mjs");
function fail(reasons) {
  console.error("FAIL");
  for (const reason of reasons) console.error(`- ${reason}`);
  process.exit(1);
}
function parseArtifactPath() {
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  if (argv.length !== 2 || argv[0] !== "--artifact" || !argv[1]) {
    fail(["usage: figma-gate-screen.mjs --artifact <screen-implementation.json>"]);
  }
  return path.resolve(argv[1]);
}
function runStep(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output2 = `${result.stdout ?? ""}
${result.stderr ?? ""}
${result.error?.message ?? ""}`.trim();
    fail([
      `${label} failed${
        output2
          ? `:
${output2}`
          : ""
      }`,
    ]);
  }
  const output = `${result.stdout ?? ""}
${result.stderr ?? ""}`;
  if (output.includes("WARN")) {
    console.warn(`${label}:
${output.trim()}`);
  }
}
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    fail([`unreadable JSON: ${file}`]);
  }
}
function sameJson(left, right) {
  return canonicalize(left) === canonicalize(right);
}
function formatMatchRatio(value) {
  return typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "n/a";
}
function validateVisuals(artifact, config, reasons) {
  const reference = artifact.visualVerification;
  if (!reference) {
    reasons.push("visualVerification artifact reference required by unified gate");
    return artifact.visualContracts.length;
  }
  const verificationPath = path.resolve(reference.artifactPath);
  if (!fs.existsSync(verificationPath)) {
    reasons.push(`visual verification artifact missing: ${reference.artifactPath}`);
    return artifact.visualContracts.length;
  }
  const actualHash = `sha256:${crypto
    .createHash("sha256")
    .update(fs.readFileSync(verificationPath))
    .digest("hex")}`;
  if (actualHash !== reference.contentHash) {
    reasons.push(`visual verification artifact hash mismatch: ${reference.artifactPath}`);
    return artifact.visualContracts.length;
  }
  const verification = readJson(verificationPath);
  if (
    verification.schemaVersion !== 3 ||
    verification.kind !== "figloom.visual-verification" ||
    verification.request?.schemaVersion !== 3 ||
    typeof verification.request?.url !== "string" ||
    !Array.isArray(verification.request?.contracts) ||
    !Array.isArray(verification.results)
  ) {
    reasons.push("visual verification artifact schema/kind invalid");
    return artifact.visualContracts.length;
  }
  const requestById = new Map(verification.request.contracts.map((contract) => [contract.id, contract]));
  const resultById = new Map(verification.results.map((result) => [result.id, result]));
  if (requestById.size !== verification.request.contracts.length) {
    reasons.push("visual verification contains duplicate contract IDs");
  }
  if (resultById.size !== verification.results.length) {
    reasons.push("visual verification contains duplicate result IDs");
  }
  for (const contract of artifact.visualContracts) {
    const requested = requestById.get(contract.id);
    if (!requested) {
      reasons.push(`visual verification missing contract ${contract.id}`);
      continue;
    }
    const expected = {
      id: contract.id,
      fileKey: artifact.source.fileKey,
      nodeId: contract.goldNodeId,
      viewport: contract.viewport,
      outDir: contract.outDir,
      scope:
        contract.scope === "page"
          ? { kind: "page", pageReason: contract.pageReason }
          : { kind: "region", selector: contract.selector, expectSize: contract.expectSize },
      ...(contract.scope === "region" ? { profile: contract.profile } : {}),
    };
    const actual = Object.fromEntries(
      Object.keys(expected).map((key) => [key, requested[key]]),
    );
    if (!sameJson(actual, expected)) {
      reasons.push(`visual verification contract ${contract.id} does not match screen declaration`);
    }
    const result = resultById.get(contract.id);
    if (!result || result.ok !== true || result.pass !== true) {
      reasons.push(`visual verification result ${contract.id} is not passing`);
    }
  }
  if (requestById.size !== artifact.visualContracts.length) {
    reasons.push("visual verification contract count does not match screen declaration");
  }
  if (resultById.size !== artifact.visualContracts.length) {
    reasons.push("visual verification result count does not match screen declaration");
  }
  if (verification.ok !== true) reasons.push("visual verification ok is not true");
  if (verification.allPassed !== true) reasons.push("visual verification allPassed is not true");
  if (reasons.length > 0) return artifact.visualContracts.length;

  const command = visualVerifyCommand(config, verificationPath);
  runStep(command.command, command.args, "visual verification done gate");
  for (const contract of artifact.visualContracts) {
    const scorePath = path.join(path.resolve(contract.outDir), "visual-score.json");
    const score = readJson(scorePath);
    console.log(
      `visual-review: ${contract.id} match=${formatMatchRatio(score.matchRatio)} engine-pass=${String(score.pass === true)} diff=${path.join(path.resolve(contract.outDir), "diff.png")}`,
    );
  }
  return artifact.visualContracts.length;
}
function main() {
  const artifactPath = parseArtifactPath();
  const artifact = readJson(artifactPath);
  let config;
  try {
    config = loadScreenConfig();
  } catch (error) {
    fail([error instanceof Error ? error.message : String(error)]);
  }
  try {
    getFrameworkAdapter(config.framework);
  } catch (error) {
    fail([error instanceof Error ? error.message : String(error)]);
  }
  const frameworkName = config.framework === "react" ? "React" : config.framework;
  if (artifact?.target?.kind !== "screen") {
    fail([
      `figma-gate:screen requires target.kind=screen; got ${String(artifact?.target?.kind)}`,
    ]);
  }
  const designSystemComponents = [
    ...new Set(
      (Array.isArray(artifact.resolved) ? artifact.resolved : [])
        .filter((resolution) => resolution.kind === "design-system")
        .map((resolution) => resolution.codeComponent),
    ),
  ];
  runStep(process.execPath, [componentGate, "--artifact", artifactPath], "component contract gate");
  if (designSystemComponents.length > 0) {
    if (!fs.existsSync(config.componentRegistryCli)) {
      fail([`component registry CLI missing: ${config.componentRegistryCli}`]);
    }
    const driftCheck = componentRegistryCommand(
      config,
      "check",
      designSystemComponents,
    );
    runStep(driftCheck.command, driftCheck.args, "task component registry drift check");
    const sourceCheck = componentRegistryCommand(
      config,
      "verify-source",
      designSystemComponents,
    );
    runStep(sourceCheck.command, sourceCheck.args, "current Figma component-source check");
  }
  const reasons = [];
  const relativeArtifactPath = path.relative(process.cwd(), artifactPath).replace(/\\/g, "/");
  if (
    !relativeArtifactPath.startsWith(".figma/artifacts/screens/") ||
    path.basename(relativeArtifactPath) !== "screen-implementation.json"
  ) {
    reasons.push(
      "screen artifact must be .figma/artifacts/screens/<feature>/<screen>/screen-implementation.json",
    );
  }
  const taskDir = path.posix.dirname(relativeArtifactPath);
  for (const [label, evidence] of [["inventoryEvidence", artifact.inventoryEvidence]]) {
    if (evidence && path.posix.dirname(evidence.filePath) !== taskDir) {
      reasons.push(`${label} must live beside screen-implementation.json`);
    }
  }
  for (const contract of artifact.visualContracts) {
    if (!contract.outDir.startsWith(".figma/artifacts/visual-verifications/")) {
      reasons.push(`visual contract ${contract.id} must use visual-verifications artifact root`);
    }
  }
  if (!artifact.inventoryEvidence) reasons.push("inventoryEvidence required by unified gate");
  if (!Array.isArray(artifact.ignoredInventoryNodes)) {
    reasons.push("ignoredInventoryNodes[] required by unified gate (empty allowed)");
  }
  if (!Array.isArray(artifact.entryComponents)) {
    reasons.push(
      `entryComponents[] required by unified gate (empty allowed only when no local ${frameworkName} roots)`,
    );
  }
  const visualContracts = validateVisuals(artifact, config, reasons);
  if (reasons.length > 0) fail(reasons);
  console.log("PASS");
  console.log(`artifact: ${path.relative(process.cwd(), artifactPath)}`);
  console.log(`name: ${artifact.name}`);
  console.log(`implementation-files: ${artifact.implementationFiles.length}`);
  console.log(`visual-contracts-done: ${visualContracts}`);
  console.log(
    "gates: inventory, component-registry, components, ownership, visual-done",
  );
  console.log("review: developer code review + visual diff + manual UI test required");
}
main();
