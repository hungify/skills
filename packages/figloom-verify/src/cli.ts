/** CLI-first visual verification engine. Exit: 0 pass, 1 visual fail, 2 usage/config. */
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";

import { compare } from "./compare/index.ts";
import {
  verificationArtifactSchema,
  verificationRequestSchema,
} from "./contracts.ts";
import { fetchGold } from "./fetch-gold.ts";
import { loadAncestorEnv } from "./load-env.ts";
import { run } from "./run.ts";
import { doneGateFromArtifact, verify, writeVerificationArtifact } from "./verify.ts";
import type { ProfileName, RunType } from "./types.ts";

loadAncestorEnv();

function arg(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function usage(exitCode = 2): never {
  console.error(`Usage:
  figloom verify --contract <visual-contract.json> --output <visual-verification.json> [--project-root <dir>]
  figloom done-gate --artifact <visual-verification.json> [--max-score-age-ms <ms>] [--max-gold-age-ms <ms>]
  figloom status [--project-root <dir>]

Debug commands:
  figloom fetch-gold --file-key <key> --node-id <id> --out <figma-gold.png> [--scale 1] [--canvas-fill '#fff']
  figloom compare --gold <png> --actual <png> --out-dir <dir> [--profile component/strict]
  figloom run --url <url> --viewport <name> --viewport-size WxH --gold <png> --out-dir <dir>
              --node-id <id> [--selector <css>] [--profile <profile>] [--page-reason <reason>]
              [--run-type dev|final] [--expect-width <px> --expect-height <px>]
`);
  process.exit(exitCode);
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read JSON ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function cmdVerify(argv: string[]): Promise<void> {
  const contractPath = arg(argv, "--contract");
  const outputPath = arg(argv, "--output");
  if (!contractPath || !outputPath) usage();
  const request = verificationRequestSchema.parse(readJson(contractPath));
  const projectRoot = path.resolve(arg(argv, "--project-root") ?? process.cwd());
  const artifact = await verify(request, {
    projectRoot,
    onProgress: ({ index, total, id, phase }) => {
      console.error(`[${index + 1}/${total}] ${id}: ${phase}`);
    },
  });
  writeVerificationArtifact(outputPath, artifact);
  const resolvedOutput = path.resolve(outputPath);
  const contentHash = `sha256:${crypto
    .createHash("sha256")
    .update(fs.readFileSync(resolvedOutput))
    .digest("hex")}`;
  console.log(
    JSON.stringify({ ...artifact, artifactPath: resolvedOutput, contentHash }, null, 2),
  );
  process.exit(artifact.allPassed ? 0 : 1);
}

async function cmdDoneGate(argv: string[]): Promise<void> {
  const artifactPath = arg(argv, "--artifact");
  if (!artifactPath) usage();
  const artifact = verificationArtifactSchema.parse(readJson(artifactPath));
  const verdict = doneGateFromArtifact(artifact, {
    maxScoreAgeMs: optionalNumber(argv, "--max-score-age-ms"),
    maxGoldAgeMs: optionalNumber(argv, "--max-gold-age-ms"),
  });
  console.log(JSON.stringify({ artifactPath: path.resolve(artifactPath), ...verdict }, null, 2));
  process.exit(verdict.done ? 0 : 1);
}

async function cmdStatus(argv: string[]): Promise<void> {
  const projectRoot = path.resolve(arg(argv, "--project-root") ?? process.cwd());
  console.log(
    JSON.stringify(
      {
        ok: true,
        name: "figloom-verify",
        version: "0.3.0",
        mode: "cli",
        projectRoot,
        tokenAvailable: Boolean(process.env.FIGMA_ACCESS_TOKEN),
      },
      null,
      2,
    ),
  );
}

async function cmdFetchGold(argv: string[]): Promise<void> {
  const fileKey = arg(argv, "--file-key");
  const nodeId = arg(argv, "--node-id");
  const outPath = arg(argv, "--out");
  if (!fileKey || !nodeId || !outPath) usage();
  const result = await fetchGold({
    fileKey,
    nodeId,
    outPath,
    scale: optionalNumber(argv, "--scale") ?? 1,
    canvasFill: arg(argv, "--canvas-fill"),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

async function cmdCompare(argv: string[]): Promise<void> {
  const gold = arg(argv, "--gold");
  const actual = arg(argv, "--actual");
  const outDir = arg(argv, "--out-dir") ?? (actual ? path.dirname(actual) : undefined);
  if (!gold || !actual || !outDir) usage();
  const result = compare(gold, actual, outDir, {
    profile: (arg(argv, "--profile") ?? "component/strict") as ProfileName,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
}

async function cmdRun(argv: string[]): Promise<void> {
  const url = arg(argv, "--url");
  const viewport = arg(argv, "--viewport");
  const viewportSize = arg(argv, "--viewport-size");
  const goldPath = arg(argv, "--gold");
  const outDir = arg(argv, "--out-dir");
  const nodeId = arg(argv, "--node-id");
  if (!url || !viewport || !viewportSize || !goldPath || !outDir || !nodeId) usage();
  const [width, height] = viewportSize.split("x").map(Number);
  if (!width || !height) usage();
  const expectWidth = optionalNumber(argv, "--expect-width");
  const expectHeight = optionalNumber(argv, "--expect-height");
  if (Boolean(expectWidth) !== Boolean(expectHeight)) usage();
  const result = await run({
    url,
    viewport,
    viewportSize: { width, height },
    goldPath,
    outDir,
    nodeId,
    selector: arg(argv, "--selector"),
    profile: arg(argv, "--profile") as ProfileName | undefined,
    pageReason: arg(argv, "--page-reason"),
    runType: (arg(argv, "--run-type") as RunType | undefined) ?? "dev",
    expectSize:
      expectWidth && expectHeight ? { width: expectWidth, height: expectHeight } : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(2);
  process.exit(result.pass ? 0 : 1);
}

function optionalNumber(argv: string[], flag: string): number | undefined {
  const raw = arg(argv, flag);
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be a positive number`);
  return value;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (command === "-h" || command === "--help") usage(0);
  if (!command) usage();
  const rest = argv.slice(1);
  switch (command) {
    case "verify":
      await cmdVerify(rest);
      return;
    case "done-gate":
      await cmdDoneGate(rest);
      return;
    case "status":
      await cmdStatus(rest);
      return;
    case "fetch-gold":
      await cmdFetchGold(rest);
      return;
    case "compare":
      await cmdCompare(rest);
      return;
    case "run":
      await cmdRun(rest);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
  }
}

const isMain =
  process.argv[1] != null &&
  (process.argv[1].endsWith("/cli.ts") ||
    process.argv[1].endsWith("/cli.js") ||
    process.argv[1].endsWith("figloom.js"));

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
