// Native-ESM mirror of figma-fidelity v0.2 done-gate contract.
// Keep reason strings and schema checks aligned with upstream before upgrading the engine.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
const SCHEMA_VERSION = 2;
const DEFAULT_MAX_SCORE_AGE_MS = 15 * 60 * 1e3;
const DEFAULT_MAX_GOLD_AGE_MS = 24 * 60 * 60 * 1e3;
const CLOCK_SKEW_MS = 6e4;
function resolveArtifactPath(input, cwd = process.cwd()) {
  if (!input) return input;
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(cwd, input);
}
function checkDoneGate(options) {
  const maxAge = options.maxScoreAgeMs ?? DEFAULT_MAX_SCORE_AGE_MS;
  const now = options.now?.() ?? Date.now();
  const cwd = options.cwd ?? process.cwd();
  const viewports = options.viewports.map((contract) => {
    const reasons = validateContract(contract);
    const outDir = resolveArtifactPath(contract.outDir, cwd);
    const scorePath = path.join(outDir, "visual-score.json");
    if (!fs.existsSync(scorePath)) {
      reasons.push(`missing visual-score.json at ${scorePath}.`);
      return verdict(contract.viewport, reasons);
    }
    let score;
    try {
      score = JSON.parse(fs.readFileSync(scorePath, "utf8"));
    } catch {
      reasons.push(`unreadable visual-score.json at ${scorePath}.`);
      return verdict(contract.viewport, reasons);
    }
    if (score.schemaVersion !== SCHEMA_VERSION) {
      reasons.push(`score schemaVersion must be ${SCHEMA_VERSION}.`);
    }
    if (score.pass !== true) reasons.push("pass is not true.");
    if (score.runType !== "final") reasons.push('runType must be "final".');
    if (score.fileKey !== contract.fileKey) reasons.push("fileKey does not match contract.");
    if (score.nodeId !== contract.nodeId) reasons.push("nodeId does not match contract.");
    if (score.viewport !== contract.viewport) reasons.push("viewport does not match contract.");
    if (score.profile !== contract.profile) reasons.push("profile does not match contract.");
    if (score.profile === "page" && !score.pageReason?.trim()) {
      reasons.push("page score missing pageReason.");
    }
    if ((score.selector ?? void 0) !== contract.selector) {
      reasons.push("selector does not match contract.");
    }
    if (!sameSize(score.expectSize, contract.expectSize)) {
      reasons.push("expectSize does not match contract.");
    }
    if (score.stability !== "stable") reasons.push('stability must be "stable".');
    if (!score.outDir || path.resolve(score.outDir) !== outDir) {
      reasons.push("score outDir does not match declared artifact directory.");
    }
    const residualBlock = score.topIssues?.some(
      (issue) =>
        issue.kind === "residual" && (issue.severity === "medium" || issue.severity === "high"),
    );
    if (residualBlock) reasons.push("blocking residual diff cluster remains.");
    const capturedAtMs = score.capturedAt ? Date.parse(score.capturedAt) : Number.NaN;
    if (!Number.isFinite(capturedAtMs)) {
      reasons.push("capturedAt missing/unparseable.");
    } else if (capturedAtMs > now + CLOCK_SKEW_MS) {
      reasons.push("capturedAt is in future.");
    } else if (now - capturedAtMs > maxAge) {
      reasons.push(`capturedAt older than ${Math.round(maxAge / 6e4)}min.`);
    }
    const expectedGold = path.join(outDir, "figma-gold.png");
    const expectedGoldMeta = path.join(outDir, "figma-gold.meta.json");
    if (score.gold?.fileKey !== contract.fileKey || score.gold?.nodeId !== contract.nodeId) {
      reasons.push("gold evidence does not match fileKey/nodeId contract.");
    }
    if (score.gold?.path !== expectedGold || score.gold?.metaPath !== expectedGoldMeta) {
      reasons.push("gold evidence paths do not match contract directory.");
    }
    const goldFetchedAtMs = score.gold?.fetchedAt ? Date.parse(score.gold.fetchedAt) : Number.NaN;
    if (!Number.isFinite(goldFetchedAtMs)) {
      reasons.push("gold fetchedAt missing/unparseable.");
    } else if (goldFetchedAtMs > now + CLOCK_SKEW_MS) {
      reasons.push("gold fetchedAt is in future.");
    } else if (now - goldFetchedAtMs > DEFAULT_MAX_GOLD_AGE_MS) {
      reasons.push("gold older than 24h; re-run fidelity_fetch_gold.");
    } else if (Number.isFinite(capturedAtMs) && goldFetchedAtMs > capturedAtMs + CLOCK_SKEW_MS) {
      reasons.push("gold fetchedAt is later than capture.");
    }
    for (const name of [
      "figma-gold.png",
      "figma-gold.meta.json",
      "actual.png",
      "diff.png",
      "run-meta.json",
      "punch-list.json",
    ]) {
      if (!fs.existsSync(path.join(outDir, name))) reasons.push(`missing ${name}.`);
    }
    verifyGoldMeta(expectedGoldMeta, contract, score.gold?.fetchedAt, reasons);
    verifyEvidenceHashes(outDir, score, reasons);
    return verdict(contract.viewport, reasons);
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    done: viewports.every((viewport) => viewport.done),
    viewports,
  };
}
function validateContract(contract) {
  const reasons = [];
  if (!contract.fileKey || !contract.nodeId) reasons.push("fileKey/nodeId required.");
  if (contract.profile === "component/dev") {
    reasons.push("done gate forbids component/dev; use component/strict for final contract.");
  }
  if (contract.profile === "page") {
    if (contract.selector) reasons.push("page contract must not set selector.");
    if (contract.expectSize) reasons.push("page contract must not set expectSize.");
  } else {
    if (!contract.selector) reasons.push("component contract requires selector.");
    if (contract.profile === "component/strict" && !contract.expectSize) {
      reasons.push("component/strict contract requires expectSize.");
    }
  }
  return reasons;
}
function verifyGoldMeta(metaPath, contract, expectedFetchedAt, reasons) {
  if (!fs.existsSync(metaPath)) return;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (meta.fileKey !== contract.fileKey || meta.nodeId !== contract.nodeId) {
      reasons.push("figma-gold.meta.json does not match fileKey/nodeId contract.");
    }
    if (!expectedFetchedAt || meta.fetchedAt !== expectedFetchedAt) {
      reasons.push("gold fetchedAt evidence does not match figma-gold.meta.json.");
    }
  } catch {
    reasons.push("figma-gold.meta.json unreadable.");
  }
}
function verifyEvidenceHashes(outDir, score, reasons) {
  const files = {
    gold: "figma-gold.png",
    goldMeta: "figma-gold.meta.json",
    actual: "actual.png",
    diff: "diff.png",
  };
  for (const key of Object.keys(files)) {
    const name = files[key];
    const filePath = path.join(outDir, name);
    if (!fs.existsSync(filePath)) continue;
    const actual = `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
    if (!score.evidenceHashes?.[key] || score.evidenceHashes[key] !== actual) {
      reasons.push(`${name} hash does not match score.`);
    }
  }
}
function sameSize(actual, expected) {
  if (!actual && !expected) return true;
  return actual?.width === expected?.width && actual?.height === expected?.height;
}
function verdict(viewport, reasons) {
  return { viewport, done: reasons.length === 0, reasons };
}
export { DEFAULT_MAX_GOLD_AGE_MS, DEFAULT_MAX_SCORE_AGE_MS, checkDoneGate };
