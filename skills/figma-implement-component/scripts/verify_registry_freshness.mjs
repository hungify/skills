#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalRegistryPath, loadJson, parseArgs, sha256 } from "./_shared.mjs";

function runCheck(cliPath, projectRoot, command, exportName, registryRoot, sourceRoot) {
  const args = [
    cliPath,
    command,
    "--project-root",
    projectRoot,
    "--registry-root",
    registryRoot,
    "--components",
    exportName,
  ];
  if (command === "check") args.push("--source-root", sourceRoot, "--ui-dir", sourceRoot);
  const result = spawnSync(process.execPath, args, { cwd: projectRoot, encoding: "utf8", timeout: 120_000 });
  if (result.error) {
    process.stderr.write(`Could not run the registry CLI (${command}): ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `${command} failed without output\n`);
    process.exit(result.status ?? 1);
  }
  return {
    status: "passed",
    command: [process.execPath, ...args].map((value) => JSON.stringify(value)).join(" "),
    stdout: result.stdout.trim(),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ["registry-cli", "registry", "component", "project-root", "out"]) {
    if (!args[required]) {
      console.error(`Missing --${required}.`);
      process.exit(2);
    }
  }

  const projectRoot = path.resolve(args["project-root"]);
  const cliPath = path.resolve(args["registry-cli"]);
  const registryPath = path.resolve(projectRoot, args.registry);
  const registryRoot = args["registry-root"] || "registry";
  const sourceRoot = args["source-root"] || "src/components";
  const entry = loadJson(registryPath, { exitCode: 2 });
  if (entry.schemaVersion !== 3 || entry.component?.exportName !== args.component) {
    console.error("Registry entry does not match schemaVersion 3 or --component.");
    process.exit(2);
  }
  const canonicalPath = canonicalRegistryPath(projectRoot, registryRoot, sourceRoot, entry);
  if (canonicalPath === null) {
    console.error(`${entry.component?.filePath} is not under source root ${sourceRoot}.`);
    process.exit(2);
  }
  if (canonicalPath !== registryPath) {
    console.error(
      `--registry is not the canonical entry the registry CLI will check: ` +
        `${path.relative(projectRoot, registryPath)} != ${path.relative(projectRoot, canonicalPath)}`,
    );
    process.exit(2);
  }
  const checkedAt = new Date().toISOString();
  const check = runCheck(cliPath, projectRoot, "check", args.component, registryRoot, sourceRoot);
  const verifySource = runCheck(cliPath, projectRoot, "verify-source", args.component, registryRoot, sourceRoot);

  const evidence = {
    schemaVersion: 1,
    component: args.component,
    registryPath: args.registry,
    registryRoot,
    sourceRoot,
    registryHash: sha256(registryPath),
    checkedAt,
    check,
    verifySource,
  };
  try {
    writeFileSync(args.out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  } catch (e) {
    console.error(`Could not write registry evidence: ${args.out}\n${e.message}`);
    process.exit(1);
  }
  console.log(`Registry freshness verified: ${args.component}`);
}

main();
