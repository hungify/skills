import * as path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchGold, run } = vi.hoisted(() => ({
  fetchGold: vi.fn(),
  run: vi.fn(),
}));

vi.mock("../src/fetch-gold.ts", () => ({ fetchGold }));
vi.mock("../src/run.ts", () => ({ run }));

import { verificationArtifactSchema, verificationRequestSchema } from "../src/contracts.ts";
import { doneGateFromArtifact, verify } from "../src/verify.ts";

const pageContract = {
  id: "login.desktop",
  fileKey: "file",
  nodeId: "1:2",
  viewport: { name: "desktop", width: 1440, height: 1024 },
  outDir: ".figma/artifacts/visual-verifications/login/desktop",
  scope: { kind: "page" as const, pageReason: "Complete supplied screen." },
};

beforeEach(() => {
  fetchGold.mockReset();
  run.mockReset();
});

describe("CLI verification contract", () => {
  it("runs a bounded contract and resolves project-relative output", async () => {
    fetchGold.mockResolvedValue({ ok: true, fetched: true });
    run.mockResolvedValue({ ok: true, pass: true });

    const artifact = await verify(
      { schemaVersion: 1, url: "http://127.0.0.1:3000/login", contracts: [pageContract] },
      { projectRoot: "/repo", now: () => new Date("2026-08-01T00:00:00.000Z") },
    );

    expect(artifact).toMatchObject({
      schemaVersion: 1,
      kind: "figloom.visual-verification",
      ok: true,
      allPassed: true,
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    expect(artifact.results[0]?.outDir).toBe(path.resolve("/repo", pageContract.outDir));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "page", runType: "final", stabilitySamples: 3 }),
    );
  });

  it("records gold fetch failure without running capture", async () => {
    fetchGold.mockResolvedValue({ ok: false, fetched: false, message: "token rejected" });

    const artifact = await verify(
      { schemaVersion: 1, url: "http://127.0.0.1:3000/login", contracts: [pageContract] },
      { projectRoot: "/repo" },
    );

    expect(artifact).toMatchObject({ ok: false, allPassed: false });
    expect(artifact.results[0]).toMatchObject({
      error: "GOLD_FETCH_FAILED",
      pass: false,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects batches larger than eight contracts", () => {
    expect(() =>
      verificationRequestSchema.parse({
        schemaVersion: 1,
        url: "http://127.0.0.1:3000",
        contracts: Array.from({ length: 9 }, (_, index) => ({
          ...pageContract,
          id: `screen.${index}`,
        })),
      }),
    ).toThrow();
  });

  it("rejects duplicate contract ids", () => {
    expect(() =>
      verificationRequestSchema.parse({
        schemaVersion: 1,
        url: "http://127.0.0.1:3000",
        contracts: [pageContract, pageContract],
      }),
    ).toThrow(/duplicate contract id/);
  });

  it("keeps a failed verification result blocked at done gate", () => {
    const verdict = doneGateFromArtifact({
      schemaVersion: 1,
      kind: "figloom.visual-verification",
      createdAt: "2026-08-01T00:00:00.000Z",
      projectRoot: "/repo",
      request: {
        schemaVersion: 1,
        url: "http://127.0.0.1:3000/login",
        contracts: [pageContract],
      },
      ok: true,
      allPassed: false,
      results: [
        {
          id: pageContract.id,
          ok: true,
          pass: false,
          outDir: path.resolve("/repo", pageContract.outDir),
        },
      ],
    });

    expect(verdict.done).toBe(false);
    expect(verdict.viewports[0]?.reasons).toContain(
      "verification artifact result is not passing.",
    );
  });

  it("rejects aggregate verdict inconsistent with contract results", () => {
    expect(() =>
      verificationArtifactSchema.parse({
        schemaVersion: 1,
        kind: "figloom.visual-verification",
        createdAt: "2026-08-01T00:00:00.000Z",
        projectRoot: "/repo",
        request: {
          schemaVersion: 1,
          url: "http://127.0.0.1:3000/login",
          contracts: [pageContract],
        },
        ok: true,
        allPassed: true,
        results: [
          {
            id: pageContract.id,
            ok: true,
            pass: false,
            outDir: path.resolve("/repo", pageContract.outDir),
          },
        ],
      }),
    ).toThrow(/allPassed must equal/);
  });
});
