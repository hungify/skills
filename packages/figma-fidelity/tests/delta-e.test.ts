import { describe, it, expect } from "vitest";
import { avgDeltaE2000 } from "../src/compare/delta-e.ts";
import { makeSolidPng } from "../src/compare/png.ts";

describe("avgDeltaE2000", () => {
  it("returns 0 for identical images", () => {
    const png = makeSolidPng(10, 10, [128, 128, 128, 255]);
    const result = avgDeltaE2000(png, png, { x0: 0, y0: 0, x1: 10, y1: 10 });
    expect(result).toBe(0);
  });

  it("detects color difference", () => {
    const gold = makeSolidPng(10, 10, [255, 0, 0, 255]);
    const actual = makeSolidPng(10, 10, [0, 0, 255, 255]);
    const result = avgDeltaE2000(gold, actual, { x0: 0, y0: 0, x1: 10, y1: 10 });
    expect(result).toBeGreaterThan(0);
  });

  it("samples with stride when bbox is large", () => {
    const gold = makeSolidPng(1000, 1000, [100, 150, 200, 255]);
    const actual = makeSolidPng(1000, 1000, [100, 150, 200, 255]);
    const result = avgDeltaE2000(gold, actual, { x0: 0, y0: 0, x1: 1000, y1: 1000 });
    expect(result).toBe(0);
  });
});
