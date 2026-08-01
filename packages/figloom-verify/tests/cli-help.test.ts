import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("published CLI", () => {
  it("prints help successfully through the package bin", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(packageRoot, "bin", "figloom.js"), "--help"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("figloom verify");
    expect(result.stderr).not.toContain("mcp");
  });

  it("reports CLI mode without requiring Figma access", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(packageRoot, "bin", "figloom.js"), "status", "--project-root", packageRoot],
      { encoding: "utf8", env: { ...process.env, FIGMA_ACCESS_TOKEN: "" } },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      name: "figloom-verify",
      version: "0.3.0",
      mode: "cli",
      projectRoot: packageRoot,
      tokenAvailable: false,
    });
  });
});
