import { describe, it, expect } from "vitest";
import { countRealDiffPixels, diffBoundingBox, largestRealDiffCluster, pixelCompare } from "../src/compare/pixel.ts";
import { makeSolidPng } from "../src/compare/png.ts";
import { PNG } from "pngjs";

describe("countRealDiffPixels", () => {
  it("returns 0 for a black (no diff) image", () => {
    const png = makeSolidPng(10, 10, [0, 0, 0, 255]);
    expect(countRealDiffPixels(png)).toBe(0);
  });

  it("keeps anti-alias yellow out of real-diff counts", () => {
    const aaDiff = makeSolidPng(1, 1, [255, 255, 0, 255]);
    expect(countRealDiffPixels(aaDiff)).toBe(0);
  });
});

describe("pixelCompare", () => {
  it("defaults includeAA to false", () => {
    const gold = makeSolidPng(3, 3, [0, 0, 0, 255]);
    const actual = makeSolidPng(3, 3, [0, 0, 0, 255]);
    actual.data[(3 * 1 + 1) << 2] = 255;
    actual.data[((3 * 1 + 1) << 2) + 1] = 255;
    actual.data[((3 * 1 + 1) << 2) + 2] = 255;
    expect(pixelCompare(gold, actual).diffPixels).toBe(
      pixelCompare(gold, actual, undefined, false).diffPixels,
    );
  });
});

describe("diffBoundingBox", () => {
  it("returns null for no diff pixels", () => {
    const png = makeSolidPng(10, 10, [0, 0, 0, 255]);
    expect(diffBoundingBox(png)).toBeNull();
  });
});

describe("largestRealDiffCluster", () => {
  it("returns null for empty image", () => {
    const png = makeSolidPng(10, 10, [0, 0, 0, 255]);
    expect(largestRealDiffCluster(png)).toBeNull();
  });
});
