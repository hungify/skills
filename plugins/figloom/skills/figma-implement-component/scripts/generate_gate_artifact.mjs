#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  canonicalRegistryPath,
  isPlainObject,
  loadJson,
  parseArgs,
  resolveFile,
  resolveFileWithinRoot,
  repoRelative,
  sha256,
} from "./_shared.mjs";

function buildDedupArray(dedupProps) {
  const out = [];
  for (const [prop, info] of Object.entries(dedupProps || {})) {
    if (!info.redundant || info.redundant.length === 0) continue;
    out.push({
      prop,
      canonicalFigmaNodeId: info.canonicalFigmaNodeId,
      canonicalPath: info.canonicalPath,
      redundant: info.redundant.map((item) => ({
        figmaNodeId: item.figmaNodeId,
        path: item.path,
        coverageRole: item.coverageRole,
      })),
    });
  }
  return out;
}

// gate-artifact.schema.json closes these three objects with
// additionalProperties: false, but each is loaded from a file this script
// doesn't fully control (registry-evidence/behavior-evidence are hand-authored
// by an agent/human, and the Figloom manifest is produced by a separate
// script) — project onto exactly the allowed fields instead of forwarding
// external JSON verbatim, so an extra key can't produce a gate artifact that
// silently fails schema validation downstream.
function projectFreshnessCommand(cmd) {
  return { status: cmd?.status, command: cmd?.command, stdout: cmd?.stdout };
}

function projectRegistryFreshness(evidence) {
  return {
    schemaVersion: evidence.schemaVersion,
    component: evidence.component,
    registryPath: evidence.registryPath,
    registryRoot: evidence.registryRoot,
    sourceRoot: evidence.sourceRoot,
    registryHash: evidence.registryHash,
    checkedAt: evidence.checkedAt,
    check: projectFreshnessCommand(evidence.check),
    verifySource: projectFreshnessCommand(evidence.verifySource),
  };
}

function projectBehaviorCase(item) {
  return {
    bindingPath: item.bindingPath,
    bindingIdentity: {
      componentPath: item.bindingIdentity?.componentPath,
      groupName: item.bindingIdentity?.groupName,
      propName: item.bindingIdentity?.propName,
      figmaNodeId: item.bindingIdentity?.figmaNodeId ?? null,
    },
    kind: item.kind,
    status: item.status,
    evidence: item.evidence,
  };
}

function projectFigloomEvidenceItem(item) {
  return {
    verificationArtifactPath: item.verificationArtifactPath,
    verificationArtifactHash: item.verificationArtifactHash,
  };
}

function sameBindingIdentity(left, right) {
  return (
    isPlainObject(left) &&
    isPlainObject(right) &&
    left.componentPath === right.componentPath &&
    left.groupName === right.groupName &&
    left.propName === right.propName &&
    (left.figmaNodeId ?? null) === (right.figmaNodeId ?? null)
  );
}

function validateInputs({ dedupData, coverageData, repoRoot, args }) {
  if (
    !isPlainObject(dedupData.props) ||
    !Array.isArray(dedupData.needsHumanReview) ||
    !Array.isArray(dedupData.skippedUnsupported)
  ) {
    console.error("Dedup output violates the contract: needs a props object plus needsHumanReview and skippedUnsupported arrays.");
    process.exit(2);
  }
  if (
    coverageData.direction !== "figma-to-code" ||
    !Array.isArray(coverageData.visualGaps) ||
    !Array.isArray(coverageData.needsHumanReview) ||
    !Array.isArray(coverageData.notes) ||
    !Array.isArray(coverageData.expectedTestids) ||
    !Array.isArray(coverageData.expectedCases) ||
    !isPlainObject(coverageData.inputs)
  ) {
    console.error("Coverage output violates the contract or is missing evidence fields.");
    process.exit(2);
  }
  if (coverageData.notes.length > 0) {
    console.error("Coverage still has unresolved notes; not generating a gate artifact.");
    process.exit(2);
  }
  if (coverageData.expectedTestids.some((value) => typeof value !== "string" || value.length === 0)) {
    console.error("coverage.expectedTestids must be a string[] with no empty items.");
    process.exit(2);
  }
  if (
    coverageData.expectedCases.length !== coverageData.expectedTestids.length ||
    coverageData.expectedCases.some(
      (item, index) => !isPlainObject(item) || item.testid !== coverageData.expectedTestids[index],
    )
  ) {
    console.error("coverage.expectedCases must map 1:1 onto expectedTestids.");
    process.exit(2);
  }
  if (
    coverageData.expectedTestids.length === 0 &&
    coverageData.visualGaps.length === 0 &&
    coverageData.needsHumanReview.length === 0
  ) {
    console.error("Coverage has no states, gaps, or human-review evidence.");
    process.exit(2);
  }
  if (JSON.stringify(coverageData.needsHumanReview) !== JSON.stringify(dedupData.needsHumanReview)) {
    console.error("Coverage needsHumanReview does not match the dedup output.");
    process.exit(2);
  }
  if (coverageData.expectedTestids.length > 0 && coverageData.harnessVerified !== true) {
    console.error("Harness has not been verified by coverage_check.");
    process.exit(2);
  }

  const componentPath = resolveFile(repoRoot, args["component-file"], "Component file");
  const registryPath = resolveFile(repoRoot, args["registry-path"], "Registry entry");
  const harnessPath = resolveFile(repoRoot, args["harness-file"], "Harness file");
  const testidsPath = resolveFile(repoRoot, args["testids-file"], "Testids file");
  const registryEvidencePath = resolveFile(repoRoot, args["registry-evidence"], "Registry evidence");
  const behaviorEvidencePath = resolveFile(repoRoot, args["behavior-evidence"], "Behavior evidence");

  const evidencePairs = [
    [coverageData.inputs.registryPath, registryPath, "registry"],
    [coverageData.inputs.dedupPath, path.resolve(repoRoot, args.dedup), "dedup"],
    [coverageData.inputs.harnessFilePath, harnessPath, "harness"],
    [coverageData.inputs.testidsFilePath, testidsPath, "testids"],
  ];
  for (const [evidencePath, actualPath, label] of evidencePairs) {
    if (typeof evidencePath !== "string" || path.resolve(repoRoot, evidencePath) !== actualPath) {
      console.error(`Coverage evidence ${label} does not match the gate's input.`);
      process.exit(2);
    }
  }

  const registry = loadJson(registryPath);
  if (
    registry.schemaVersion !== 3 ||
    registry.component?.exportName !== args["export-name"] ||
    path.resolve(repoRoot, registry.component?.filePath || "") !== componentPath
  ) {
    console.error("Registry entry does not match schema v3, export-name, or the gate's component-file.");
    process.exit(2);
  }

  const registryEvidence = loadJson(registryEvidencePath);
  const evidenceRegistryRoot = registryEvidence.registryRoot;
  const evidenceSourceRoot = registryEvidence.sourceRoot;
  if (
    registryEvidence.schemaVersion !== 1 ||
    registryEvidence.component !== args["export-name"] ||
    typeof evidenceRegistryRoot !== "string" ||
    evidenceRegistryRoot.length === 0 ||
    typeof evidenceSourceRoot !== "string" ||
    evidenceSourceRoot.length === 0 ||
    path.resolve(repoRoot, registryEvidence.registryPath || "") !== registryPath ||
    canonicalRegistryPath(repoRoot, evidenceRegistryRoot, evidenceSourceRoot, registry) !== registryPath ||
    registryEvidence.registryHash !== sha256(registryPath) ||
    registryEvidence.check?.status !== "passed" ||
    registryEvidence.verifySource?.status !== "passed" ||
    !Number.isFinite(Date.parse(registryEvidence.checkedAt))
  ) {
    console.error("Registry freshness evidence does not match the current entry/check/verify-source.");
    process.exit(2);
  }
  const behaviorEvidence = loadJson(behaviorEvidencePath);
  if (behaviorEvidence.schemaVersion !== 1 || !Array.isArray(behaviorEvidence.cases)) {
    console.error("Behavior evidence must follow schemaVersion 1 with cases[].");
    process.exit(2);
  }
  const allowedKinds = new Set(["interaction", "a11y", "visual-state", "not-applicable"]);
  const allowedStatuses = new Set(["passed", "waived"]);
  for (const skipped of dedupData.skippedUnsupported) {
    const matches = behaviorEvidence.cases.filter((item) =>
      sameBindingIdentity(item?.bindingIdentity, skipped.identity),
    );
    const behaviorCase = matches[0];
    if (
      matches.length !== 1 ||
      !allowedKinds.has(behaviorCase?.kind) ||
      !allowedStatuses.has(behaviorCase?.status) ||
      typeof behaviorCase?.evidence !== "string" ||
      behaviorCase.evidence.length === 0 ||
      (behaviorCase?.status === "waived" && behaviorCase?.kind !== "not-applicable")
    ) {
      console.error(`Behavior evidence is missing/wrong for unsupported binding: ${skipped.path}`);
      process.exit(2);
    }
    if (behaviorCase.status === "passed") {
      resolveFile(repoRoot, behaviorCase.evidence, `Behavior evidence ${skipped.path}`);
    }
  }
  if (behaviorEvidence.cases.length !== dedupData.skippedUnsupported.length) {
    console.error("Behavior evidence has extra cases or cases not tied to a current unsupported binding.");
    process.exit(2);
  }
  return {
    registryFreshness: projectRegistryFreshness(registryEvidence),
    behaviorEvidence: {
      schemaVersion: behaviorEvidence.schemaVersion,
      cases: behaviorEvidence.cases.map(projectBehaviorCase),
    },
  };
}

// Re-reads the evidence manifest that validate_figloom_evidence.mjs already
// produced (contract cross-check + done-gate already ran there) and confirms
// it still points at the current coverage output and un-tampered artifacts.
function verifyFigloomEvidenceManifest({ args, coveragePath, repoRoot, totalStates }) {
  if (!args["figloom-evidence"]) {
    console.error("Missing --figloom-evidence; the gate requires Figloom verify + done-gate evidence.");
    process.exit(2);
  }
  const manifestPath = resolveFile(repoRoot, args["figloom-evidence"], "Figloom evidence manifest");
  const data = loadJson(manifestPath);
  if (
    data.schemaVersion !== 1 ||
    data.package !== "figloom-verify@0.0.3" ||
    data.coveragePath !== repoRelative(repoRoot, coveragePath) ||
    data.coverageHash !== sha256(coveragePath) ||
    !Array.isArray(data.artifacts) ||
    (totalStates > 0 && data.artifacts.length === 0) ||
    (totalStates === 0 && data.artifacts.length > 0)
  ) {
    console.error("Figloom evidence manifest violates the contract or does not match the current coverage.");
    process.exit(2);
  }
  const seen = new Set();
  for (const item of data.artifacts) {
    if (
      !isPlainObject(item) ||
      typeof item.verificationArtifactPath !== "string" ||
      typeof item.verificationArtifactHash !== "string" ||
      seen.has(item.verificationArtifactPath)
    ) {
      console.error("Figloom evidence artifact violates the contract or duplicates a path.");
      process.exit(2);
    }
    const artifactPath = resolveFile(repoRoot, item.verificationArtifactPath, "Figloom verification artifact");
    if (item.verificationArtifactHash !== sha256(artifactPath)) {
      console.error(`Figloom verification artifact is stale or has a mismatched hash: ${item.verificationArtifactPath}`);
      process.exit(2);
    }
    seen.add(item.verificationArtifactPath);
  }
  return data.artifacts.map(projectFigloomEvidenceItem);
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const required = [
    "component-name",
    "component-file",
    "registry-path",
    "export-name",
    "dedup",
    "coverage",
    "registry-evidence",
    "behavior-evidence",
    "harness-file",
    "testids-file",
    "total-states",
    "out",
  ];
  for (const r of required) {
    if (!a[r]) {
      console.error(`Missing --${r}.`);
      process.exit(2);
    }
  }

  const repoRoot = a["repo-root"] || ".";
  const dedupPath = resolveFile(repoRoot, a.dedup, "Dedup");
  const coveragePath = resolveFile(repoRoot, a.coverage, "Coverage");
  const dedupData = loadJson(dedupPath);
  const coverageData = loadJson(coveragePath);
  const { registryFreshness, behaviorEvidence } = validateInputs({ dedupData, coverageData, repoRoot, args: a });
  const totalStatesRaw = a["total-states"];
  if (!/^(0|[1-9]\d*)$/.test(totalStatesRaw)) {
    console.error(
      `--total-states must be a non-negative integer, got "${totalStatesRaw}".`
    );
    process.exit(2);
  }
  const totalStates = Number(totalStatesRaw);
  if (!Number.isSafeInteger(totalStates)) {
    console.error(
      `--total-states exceeds the safe integer range, got "${totalStatesRaw}".`
    );
    process.exit(2);
  }
  if (totalStates !== coverageData.expectedTestids.length) {
    console.error(
      `--total-states must equal coverage.expectedTestids.length ` +
        `(${coverageData.expectedTestids.length}), got "${totalStatesRaw}".`,
    );
    process.exit(2);
  }

  const figloomEvidence = verifyFigloomEvidenceManifest({
    args: a,
    coveragePath,
    repoRoot: path.resolve(repoRoot),
    totalStates,
  });

  const needsHumanReview = coverageData.needsHumanReview;

  const artifact = {
    schemaVersion: 3,
    component: {
      name: a["component-name"],
      filePath: a["component-file"],
    },
    registryRef: {
      path: a["registry-path"],
      exportName: a["export-name"],
    },
    registryFreshness,
    classification: {
      type: "design-system-component",
      reasoning: a["classification-reasoning"] || "Manually confirmed in step 2 (classification).",
    },
    dedup: buildDedupArray(dedupData.props),
    harness: {
      showcaseFilePath: a["harness-file"],
      testidsFilePath: a["testids-file"],
      totalStates,
    },
    coverage: {
      direction: "figma-to-code",
      visualGaps: coverageData.visualGaps || [],
      needsHumanReview,
    },
    behavior: behaviorEvidence,
    figloomEvidence,
    status: "pending-human-review",
    generatedAt: new Date().toISOString(),
  };

  const outPath = resolveFileWithinRoot(repoRoot, a.out, "Output", false);
  try {
    writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  } catch (e) {
    console.error(`Could not write gate artifact: ${a.out}\n${e.message}`);
    process.exit(1);
  }

  console.log(`Wrote gate artifact: ${a.out}`);
  console.log(`figloomEvidence = ${figloomEvidence.length} verification artifact(s)`);
  if (artifact.coverage.visualGaps.length > 0) {
    console.log(`WARNING: ${artifact.coverage.visualGaps.length} visualGap(s) — see coverage.visualGaps in the file.`);
  }
  if (needsHumanReview.length > 0) {
    console.log(`WARNING: ${needsHumanReview.length} needsHumanReview entr(y/ies) — see coverage.needsHumanReview in the file.`);
  }
  console.log(
    `status = "pending-human-review" — ONLY change to "done" after a human reviewer confirms ` +
      `(see "Definition of Done" in SKILL.md, item 4).`
  );
}

main();
