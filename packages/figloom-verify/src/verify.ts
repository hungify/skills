import * as fs from "node:fs";
import * as path from "node:path";

import { verificationRequestSchema } from "./contracts.ts";
import { checkDoneGate, type DoneGateViewport } from "./done-gate.ts";
import { fetchGold } from "./fetch-gold.ts";
import { resolveArtifactPath } from "./paths.ts";
import { run } from "./run.ts";
import type {
  VerificationArtifact,
  VerificationContract,
  VerificationRequest,
} from "./contracts.ts";

export interface VerifyOptions {
  projectRoot?: string;
  now?: () => Date;
  onProgress?: (event: { index: number; total: number; id: string; phase: string }) => void;
}

export async function verify(
  input: VerificationRequest,
  options: VerifyOptions = {},
): Promise<VerificationArtifact> {
  const request = verificationRequestSchema.parse(input);
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const results: VerificationArtifact["results"] = [];

  for (let index = 0; index < request.contracts.length; index += 1) {
    const contract = request.contracts[index]!;
    const outDir = resolveArtifactPath(contract.outDir, projectRoot);
    const goldPath = path.join(outDir, "figma-gold.png");
    try {
      options.onProgress?.({ index, total: request.contracts.length, id: contract.id, phase: "fetch" });
      const gold = await fetchGold({
        fileKey: contract.fileKey,
        nodeId: contract.nodeId,
        outPath: goldPath,
        scale: contract.scale,
        canvasFill: contract.canvasFill,
      });
      if (!gold.fetched) {
        results.push({
          id: contract.id,
          ok: false,
          pass: false,
          error: "GOLD_FETCH_FAILED",
          message: gold.message,
          outDir,
        });
        continue;
      }

      options.onProgress?.({ index, total: request.contracts.length, id: contract.id, phase: "capture" });
      const result = await run({
        url: request.url,
        viewport: contract.viewport.name,
        viewportSize: {
          width: contract.viewport.width,
          height: contract.viewport.height,
        },
        goldPath,
        outDir,
        nodeId: contract.nodeId,
        selector: contract.scope.kind === "region" ? contract.scope.selector : undefined,
        profile:
          contract.scope.kind === "region" ? (contract.profile ?? "component/strict") : "page",
        pageReason: contract.scope.kind === "page" ? contract.scope.pageReason : undefined,
        runType: "final",
        expectSize: contract.scope.kind === "region" ? contract.scope.expectSize : undefined,
        stabilitySamples: contract.stabilitySamples ?? 3,
        timeoutMs: contract.timeoutMs,
        hideDevtoolsChrome: contract.hideDevtoolsChrome,
      });
      results.push({
        id: contract.id,
        ok: result.ok,
        pass: result.ok && result.pass,
        ...(!result.ok ? { error: result.error, message: result.message } : {}),
        outDir,
      });
    } catch (error) {
      results.push({
        id: contract.id,
        ok: false,
        pass: false,
        error: "VERIFY_FAILED",
        message: error instanceof Error ? error.message : String(error),
        outDir,
      });
    }
  }

  return {
    schemaVersion: 1,
    kind: "figloom.visual-verification",
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    projectRoot,
    request,
    ok: results.every((result) => result.ok),
    allPassed: results.every((result) => result.ok && result.pass),
    results,
  };
}

export function doneGateFromArtifact(
  artifact: VerificationArtifact,
  options: { maxScoreAgeMs?: number; maxGoldAgeMs?: number; now?: () => number } = {},
) {
  const viewports = artifact.request.contracts.map((contract) =>
    contractToDoneGate(contract, artifact.projectRoot),
  );
  const verdict = checkDoneGate({
    viewports,
    cwd: artifact.projectRoot,
    maxScoreAgeMs: options.maxScoreAgeMs,
    maxGoldAgeMs: options.maxGoldAgeMs,
    now: options.now,
  });
  const results = new Map(artifact.results.map((result) => [result.id, result]));
  artifact.request.contracts.forEach((contract, index) => {
    const result = results.get(contract.id);
    if (!result || result.ok !== true || result.pass !== true) {
      verdict.viewports[index]?.reasons.push("verification artifact result is not passing.");
      if (verdict.viewports[index]) verdict.viewports[index].done = false;
    }
  });
  if (artifact.ok !== true || artifact.allPassed !== true) {
    verdict.done = false;
  } else {
    verdict.done = verdict.viewports.every((viewport) => viewport.done);
  }
  return verdict;
}

export function writeVerificationArtifact(filePath: string, artifact: VerificationArtifact): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.renameSync(temporary, resolved);
}

function contractToDoneGate(
  contract: VerificationContract,
  projectRoot: string,
): DoneGateViewport {
  return {
    viewport: contract.viewport.name,
    outDir: resolveArtifactPath(contract.outDir, projectRoot),
    fileKey: contract.fileKey,
    nodeId: contract.nodeId,
    profile: contract.scope.kind === "page" ? "page" : (contract.profile ?? "component/strict"),
    selector: contract.scope.kind === "region" ? contract.scope.selector : undefined,
    expectSize: contract.scope.kind === "region" ? contract.scope.expectSize : undefined,
    pageReason: contract.scope.kind === "page" ? contract.scope.pageReason : undefined,
  };
}
