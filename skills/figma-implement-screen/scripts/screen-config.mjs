import * as fs from "node:fs";
import * as path from "node:path";

import { z } from "zod";
const SCREEN_CONFIG_PATH = ".figma/screen.config.json";
const screenConfigSchema = z
  .object({
    framework: z.string().min(1).default("react"),
    packageManager: z.enum(["pnpm", "npm", "yarn", "bun"]).default("pnpm"),
    pathAliases: z.record(z.string().min(1), z.string().min(1)).default({ "#/": "src/" }),
    screensGlob: z.string().min(1).default("src/features/*/screens/*/"),
    componentRegistryCli: z
      .string()
      .min(1)
      .default(".agents/skills/figma-component-registry/scripts/figma-component-registry.mjs"),
  })
  .strict();
const DEFAULT_SCREEN_CONFIG = {
  framework: "react",
  packageManager: "pnpm",
  pathAliases: { "#/": "src/" },
  screensGlob: "src/features/*/screens/*/",
  componentRegistryCli:
    ".agents/skills/figma-component-registry/scripts/figma-component-registry.mjs",
};
function normalizeSlashes(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}
function formatConfigIssues(error) {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`)
    .join("; ");
}
function loadScreenConfig(cwd = process.cwd()) {
  const configPath = path.join(cwd, SCREEN_CONFIG_PATH);
  if (!fs.existsSync(configPath)) return { ...DEFAULT_SCREEN_CONFIG };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    throw new Error(`screen config is not valid JSON: ${SCREEN_CONFIG_PATH}`);
  }
  const parsed = screenConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`screen config invalid: ${formatConfigIssues(parsed.error)}`);
  }
  return parsed.data;
}
function normalizeImportPath(importPath, config) {
  const normalized = normalizeSlashes(importPath);
  const aliases = Object.entries(config.pathAliases).sort(
    ([, left], [, right]) => right.length - left.length,
  );
  for (const [rawAlias, rawTarget] of aliases) {
    const alias = normalizeSlashes(rawAlias);
    const target = normalizeSlashes(rawTarget);
    if (normalized === target.replace(/\/$/, "")) return alias.replace(/\/$/, "");
    if (normalized.startsWith(target)) return `${alias}${normalized.slice(target.length)}`;
  }
  return normalized;
}
function aliasBarrelSources(importPath, config) {
  const direct = normalizeImportPath(importPath, config);
  const sources = /* @__PURE__ */ new Set([direct]);
  for (const rawAlias of Object.keys(config.pathAliases)) {
    const alias = normalizeSlashes(rawAlias);
    const uiPrefix = `${alias}components/ui/`;
    const componentPrefix = `${alias}components/`;
    if (direct.startsWith(uiPrefix)) sources.add(`${alias}components/ui`);
    if (direct.startsWith(componentPrefix) && !direct.startsWith(uiPrefix)) {
      sources.add(`${alias}components`);
    }
  }
  return sources;
}
function globToRegExp(glob) {
  const normalized = normalizeSlashes(glob);
  let source = "(?:^|.*/)";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
  }
  if (normalized.endsWith("/")) source += ".*";
  source += "$";
  return new RegExp(source);
}
function matchesScreensGlob(filePath, config) {
  return globToRegExp(config.screensGlob).test(normalizeSlashes(filePath));
}
function packageScriptCommand(packageManager, script, args = []) {
  switch (packageManager) {
    case "npm":
      return { command: "npm", args: ["run", script, ...(args.length > 0 ? ["--", ...args] : [])] };
    case "yarn":
      return { command: "yarn", args: [script, ...args] };
    case "bun":
      return { command: "bun", args: ["run", script, ...(args.length > 0 ? ["--", ...args] : [])] };
    case "pnpm":
      return { command: "pnpm", args: [script, ...(args.length > 0 ? ["--", ...args] : [])] };
  }
}
function componentRegistryCommand(config, action, components) {
  if (!new Set(["check", "verify-source"]).has(action)) {
    throw new Error(`unsupported component registry action: ${action}`);
  }
  const args = [config.componentRegistryCli, action];
  if (components.length > 0) args.push("--components", components.join(","));
  return { command: process.execPath, args };
}
export {
  DEFAULT_SCREEN_CONFIG,
  SCREEN_CONFIG_PATH,
  aliasBarrelSources,
  componentRegistryCommand,
  loadScreenConfig,
  matchesScreensGlob,
  normalizeImportPath,
  packageScriptCommand,
};
