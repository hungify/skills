import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("published CLI", () => {
  it("prints help successfully through the package bin", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(packageRoot, "bin", "figma-fidelity.js"), "--help"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("figma-fidelity mcp");
  });
});
