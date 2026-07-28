import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadAncestorEnv } from "../src/load-env.ts";

const originalValue = process.env.FIGMA_FIDELITY_LOAD_ENV_TEST;

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env.FIGMA_FIDELITY_LOAD_ENV_TEST;
  } else {
    process.env.FIGMA_FIDELITY_LOAD_ENV_TEST = originalValue;
  }
});

describe("loadAncestorEnv", () => {
  it("stops loading env files above the nearest repository root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fidelity-env-"));
    const repo = path.join(root, "repo");
    const nested = path.join(repo, "apps", "web");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(repo, ".git"), "");
    fs.writeFileSync(
      path.join(root, ".env"),
      "FIGMA_FIDELITY_LOAD_ENV_TEST=outside\n",
    );
    fs.writeFileSync(
      path.join(repo, ".env"),
      "FIGMA_FIDELITY_LOAD_ENV_TEST=inside\n",
    );

    delete process.env.FIGMA_FIDELITY_LOAD_ENV_TEST;
    const loaded = loadAncestorEnv(nested);

    expect(loaded).toEqual([path.join(repo, ".env")]);
    expect(process.env.FIGMA_FIDELITY_LOAD_ENV_TEST).toBe("inside");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
