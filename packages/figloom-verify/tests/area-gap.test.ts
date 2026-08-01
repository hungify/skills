import { describe, it, expect } from "vitest";
import { areaGap } from "../src/compare/area-gap.ts";
import { makeSolidPng } from "../src/compare/png.ts";

describe("areaGap", () => {
  it("returns 0% for same-size images", () => {
    const a = makeSolidPng(100, 100, [255, 255, 255, 255]);
    const b = makeSolidPng(100, 100, [0, 0, 0, 255]);
    const result = areaGap(a, b);
    expect(result.areaGapPercent).toBe(0);
  });

  it("detects different sizes", () => {
    const a = makeSolidPng(100, 100, [255, 255, 255, 255]);
    const b = makeSolidPng(200, 200, [0, 0, 0, 255]);
    const result = areaGap(a, b);
    expect(result.areaGapPercent).toBeGreaterThan(0);
  });

  it("same area different aspect fails", () => {
    const gold = makeSolidPng(400, 100, [0, 0, 0, 255]);
    const actual = makeSolidPng(200, 200, [0, 0, 0, 255]);
    const r = areaGap(gold, actual);
    // product areas equal → old impl returned 0; new must be large
    expect(r.areaGapPercent).toBeGreaterThan(50);
  });

  it("same size still 0", () => {
    const a = makeSolidPng(100, 80, [0, 0, 0, 255]);
    const b = makeSolidPng(100, 80, [255, 255, 255, 255]);
    expect(areaGap(a, b).areaGapPercent).toBe(0);
  });
});
