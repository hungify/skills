#!/usr/bin/env node
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertFrameworkAdapter,
  getFrameworkAdapter,
} from "./adapters/index.mjs";
import {
  aliasBarrelSources,
  DEFAULT_SCREEN_CONFIG,
  loadScreenConfig,
  matchesScreensGlob,
  normalizeImportPath,
  packageScriptCommand,
} from "./screen-config.mjs";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(scriptDir, "fixtures");
const failures = [];
function expect(name, condition, detail) {
  if (condition) {
    l8u;
    console.log(`\u2713 ${name}`);
  } else {
    failures.push(`${name}: ${detail}`);
    console.error(`\u2717 ${name}: ${detail}`);
  }
}
const custom = loadScreenConfig(path.join(fixtures, "config-custom-alias"));
const reactAnalysis = getFrameworkAdapter("react").analyzeFile(
  path.join(
    fixtures,
    "config-custom-alias/app/modules/auth/views/login/AliasScreen.jsx",
  ),
);
expect(
  "custom framework",
  custom.framework === "react",
  `got ${custom.framework}`,
);
expect(
  "custom package manager",
  custom.packageManager === "npm",
  `got ${custom.packageManager}`,
);
expect(
  "custom alias normalizes target file",
  normalizeImportPath("app/components/ui/button", custom) ===
    "@/components/ui/button",
  normalizeImportPath("app/components/ui/button", custom),
);
expect(
  "custom alias includes UI barrel",
  aliasBarrelSources("@/components/ui/button", custom).has("@/components/ui"),
  [...aliasBarrelSources("@/components/ui/button", custom)].join(", "),
);
expect(
  "custom screens glob matches nested component",
  matchesScreensGlob(
    "app/modules/auth/views/login/components/login-form.tsx",
    custom,
  ),
  custom.screensGlob,
);
expect(
  "custom screens glob rejects other tree",
  !matchesScreensGlob("src/features/auth/screens/login/login-form.tsx", custom),
  custom.screensGlob,
);
expect(
  "custom alias import analyzed through JSX adapter",
  reactAnalysis.imports.get("Button")?.source === "@/components/ui/button" &&
    reactAnalysis.componentNames.has("Button") &&
    reactAnalysis.localRoots.includes("AliasScreen"),
  JSON.stringify({
    buttonImport: reactAnalysis.imports.get("Button"),
    componentNames: [...reactAnalysis.componentNames],
    localRoots: reactAnalysis.localRoots,
  }),
);
const unsupported = loadScreenConfig(
  path.join(fixtures, "config-unsupported-framework"),
);
let unsupportedMessage = "";
try {
  getFrameworkAdapter(unsupported.framework);
} catch (error) {
  unsupportedMessage = error instanceof Error ? error.message : String(error);
}
expect(
  "unsupported framework fails clearly",
  unsupportedMessage.includes("framework adapter unavailable: vue") &&
    unsupportedMessage.includes("available adapters: react"),
  unsupportedMessage,
);
let invalidAdapterMessage = "";
try {
  assertFrameworkAdapter({ id: "broken", fileExtensions: [".vue"] });
} catch (error) {
  invalidAdapterMessage =
    error instanceof Error ? error.message : String(error);
}
expect(
  "adapter contract fails clearly",
  invalidAdapterMessage.includes(
    "framework adapter broken requires analyzeFile()",
  ),
  invalidAdapterMessage,
);
expect(
  "React adapter extensions",
  getFrameworkAdapter("react").fileExtensions.join(",") === ".tsx,.jsx",
  getFrameworkAdapter("react").fileExtensions.join(","),
);
expect(
  "default behavior remains React/pnpm",
  DEFAULT_SCREEN_CONFIG.framework === "react" &&
    DEFAULT_SCREEN_CONFIG.packageManager === "pnpm" &&
    DEFAULT_SCREEN_CONFIG.pathAliases["#/"] === "src/",
  JSON.stringify(DEFAULT_SCREEN_CONFIG),
);
expect(
  "npm script command",
  JSON.stringify(
    packageScriptCommand("npm", "figma-gate:screen", ["--artifact", "x.json"]),
  ) ===
    JSON.stringify({
      command: "npm",
      args: ["run", "figma-gate:screen", "--", "--artifact", "x.json"],
    }),
  JSON.stringify(
    packageScriptCommand("npm", "figma-gate:screen", ["--artifact", "x.json"]),
  ),
);
if (failures.length > 0) {
  console.error(`
${failures.length} config pressure case(s) failed`);
  process.exit(1);
}
console.log("\nAll screen config pressure cases ok");
