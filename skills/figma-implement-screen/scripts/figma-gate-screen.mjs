#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getFrameworkAdapter } from "./adapters/index.mjs";
import { checkDoneGate } from "./lib/fidelity-done-gate.mjs";
import { loadScreenConfig, packageScriptCommand } from "./screen-config.mjs";
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
${result.stderr ?? ""}`.trim();
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
function runPackageStep(packageCommand, label) {
  runStep(packageCommand.command, packageCommand.args, label);
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
function isVisualQualityReason(reason) {
  return reason === "pass is not true." || reason === "blocking residual diff cluster remains.";
}
function formatMatchRatio(value) {
  return typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "n/a";
}
function validateVisuals(artifact, reasons) {
  const verdict = checkDoneGate({
    viewports: artifact.visualContracts.map((contract) => ({
      viewport: contract.viewport.name,
      outDir: path.resolve(contract.outDir),
      fileKey: artifact.source.fileKey,
      nodeId: contract.goldNodeId,
      profile: contract.profile,
      selector: contract.scope === "region" ? contract.selector : void 0,
      expectSize: contract.scope === "region" ? contract.expectSize : void 0,
    })),
    cwd: process.cwd(),
  });
  verdict.viewports.forEach((viewport, index) => {
    const contract = artifact.visualContracts[index];
    if (!contract) return;
    const integrityReasons = viewport.reasons.filter((reason) => !isVisualQualityReason(reason));
    if (integrityReasons.length > 0) {
      reasons.push(
        `visual contract ${contract.id} evidence invalid: ${integrityReasons.join("; ")}`,
      );
    }
    const scorePath = path.join(path.resolve(contract.outDir), "visual-score.json");
    if (!fs.existsSync(scorePath)) return;
    const score = readJson(scorePath);
    const qualityReasons = viewport.reasons.filter(isVisualQualityReason);
    const summary = `${contract.id} match=${formatMatchRatio(score.matchRatio)} engine-pass=${String(score.pass === true)} diff=${path.join(path.resolve(contract.outDir), "diff.png")}`;
    if (qualityReasons.length > 0) {
      reasons.push(
        `visual contract ${contract.id} quality blocked: ${summary}; ${qualityReasons.join("; ")}`,
      );
    } else {
      console.log(`visual-review: ${summary}`);
    }
  });
  for (const contract of artifact.visualContracts) {
    const outDir = path.resolve(contract.outDir);
    const runMetaPath = path.join(outDir, "run-meta.json");
    if (!fs.existsSync(runMetaPath)) continue;
    const runMeta = readJson(runMetaPath);
    const expectedViewportSize = {
      width: contract.viewport.width,
      height: contract.viewport.height,
    };
    if (!sameJson(runMeta.viewportSize, expectedViewportSize)) {
      reasons.push(
        `visual contract ${contract.id} runMeta.viewportSize mismatch: actual=${JSON.stringify(runMeta.viewportSize)} expected=${JSON.stringify(expectedViewportSize)}`,
      );
    }
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
  if (artifact.target.kind !== "screen") {
    fail([`figma-gate:screen requires target.kind=screen; got ${artifact.target.kind}`]);
  }
  const designSystemComponents = [
    ...new Set(
      (Array.isArray(artifact.resolved) ? artifact.resolved : [])
        .filter((resolution) => resolution.kind === "design-system")
        .map((resolution) => resolution.codeComponent),
    ),
  ];
  if (designSystemComponents.length > 0) {
    runPackageStep(
      packageScriptCommand(config.packageManager, "figma-props:check", [
        "--components",
        designSystemComponents.join(","),
      ]),
      "task prop-map freshness check",
    );
    runStep(
      "node",
      [
        ".agents/skills/figma-props-sync/scripts/figma-props-sync.cjs",
        "verify-source",
        "--components",
        designSystemComponents.join(","),
      ],
      "current Figma prop-source check",
    );
  }
  runStep(process.execPath, [componentGate, "--artifact", artifactPath], "component contract gate");
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
    if (!contract.outDir.startsWith(`${taskDir}/`)) {
      reasons.push(`visual contract ${contract.id} escapes screen task directory`);
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
  const visualContracts = validateVisuals(artifact, reasons);
  if (reasons.length > 0) fail(reasons);
  console.log("PASS");
  console.log(`artifact: ${path.relative(process.cwd(), artifactPath)}`);
  console.log(`name: ${artifact.name}`);
  console.log(`implementation-files: ${artifact.implementationFiles.length}`);
  console.log(`visual-contracts-done: ${visualContracts}`);
  console.log(
    "gates: inventory, prop-map, components, ownership, visual-done",
  );
  console.log("review: developer code review + visual diff + manual UI test required");
}
main();
