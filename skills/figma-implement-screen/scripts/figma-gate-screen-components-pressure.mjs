#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const gate = path.join(
  root,
  ".agents/skills/figma-implement-screen/scripts/figma-gate-screen-components-internal.mjs",
);
const fixtures = path.join(root, ".agents/skills/figma-implement-screen/scripts/fixtures");
function runGate(args) {
  return spawnSync(process.execPath, [gate, ...args], {
    cwd: root,
    encoding: "utf-8",
  });
}
function runStalePropMapCase() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-stale-prop-map-"));
  const fixture = ".agents/skills/figma-implement-screen/scripts/fixtures/bad-stale-prop-map";
  try {
    return spawnSync(
      "node",
      [
        ".agents/skills/figma-props-sync/scripts/figma-props-sync.cjs",
        "extract-code",
        "--ui-dir",
        fixture,
        "--cache-dir",
        tempDir,
        "--prop-map-dir",
        `${fixture}/prop-map`,
        "--fail-on-stale",
      ],
      { cwd: root, encoding: "utf-8" },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
function runSpreadPropsCase() {
  const relativeDir = `.figma/artifacts/pressure-spread-${process.pid}`;
  const absoluteDir = path.join(root, relativeDir);
  const componentFile = `${relativeDir}/SpreadProps.tsx`;
  const artifactFile = path.join(absoluteDir, "component-resolution.json");
  try {
    fs.mkdirSync(absoluteDir, { recursive: true });
    fs.writeFileSync(
      path.join(root, componentFile),
      'import { Button } from "#/components/ui/button";\n\nconst figmaProps = { Size: "Large" };\n\nexport function SpreadProps() {\n  return <Button {...figmaProps}>Click</Button>;\n}\n',
    );
    fs.writeFileSync(
      artifactFile,
      `${JSON.stringify(
        {
          schemaVersion: 5,
          name: "pressure-spread",
          target: { kind: "screen", route: "/pressure" },
          source: { fileKey: "x", nodes: [{ id: "component", nodeId: "1:2" }] },
          detectedComponents: [
            {
              sourceId: "component",
              nodeId: "2:1",
              name: "Button",
              kind: "design-system",
            },
          ],
          implementationFiles: [componentFile],
          resolved: [
            {
              kind: "design-system",
              figmaNodes: ["2:1"],
              codeComponent: "Button",
              importPath: "#/components/ui/button",
              decision: "reuse",
            },
          ],
          unresolved: [],
          screenCompositions: [],
          assets: [],
          visualContracts: [
            {
              id: "component.page",
              sourceId: "component",
              sourceNodeId: "1:2",
              goldNodeId: "1:2",
              role: "primary",
              scope: "page",
              viewport: { name: "desktop", width: 1440, height: 1024 },
              outDir: `${relativeDir}/component/page`,
              profile: "page",
              pageReason: "Pressure fixture.",
            },
          ],
        },
        null,
        2,
      )}
`,
    );
    return runGate(["--artifact", artifactFile]);
  } finally {
    fs.rmSync(absoluteDir, { recursive: true, force: true });
  }
}
const cases = [
  {
    name: "bad-extend",
    expect: "FAIL",
    args: ["--artifact", path.join(fixtures, "bad-extend/component-resolution.json")],
    mustInclude: ["component-resolution resolved.0.decision"],
  },
  {
    name: "bad-raw-create",
    expect: "FAIL",
    args: ["--artifact", path.join(fixtures, "bad-raw-create/component-resolution.json")],
    mustInclude: ["raw primitive markup"],
  },
  {
    name: "bad-figma-prop-name",
    expect: "FAIL",
    args: ["--artifact", path.join(fixtures, "bad-figma-prop-name/component-resolution.json")],
    mustInclude: ["figma prop name"],
  },
  {
    name: "bad-v1",
    expect: "FAIL",
    args: ["--artifact", path.join(fixtures, "bad-v1/component-resolution.json")],
    mustInclude: ["component-resolution schemaVersion"],
  },
  {
    name: "bad-uncovered-inventory",
    expect: "FAIL",
    args: ["--artifact", path.join(fixtures, "bad-uncovered-inventory/component-resolution.json")],
    mustInclude: ["detected component lacks resolved/unresolved coverage"],
  },
  {
    name: "bad-visual-naming",
    expect: "FAIL",
    args: ["--artifact", path.join(fixtures, "bad-visual-naming/component-resolution.json")],
    mustInclude: ["component-resolution source.nodes.0"],
  },
  {
    name: "bad-contract-path",
    expect: "FAIL",
    args: ["--artifact", path.join(fixtures, "bad-contract-path/component-resolution.json")],
    mustInclude: ["id must be", "outDir must end with"],
  },
  {
    name: "bad-missing-primary",
    expect: "FAIL",
    args: ["--artifact", path.join(fixtures, "bad-missing-primary/component-resolution.json")],
    mustInclude: ["requires exactly one primary visualContract; found 0"],
  },
  {
    name: "bad-duplicate-primary",
    expect: "FAIL",
    args: ["--artifact", path.join(fixtures, "bad-duplicate-primary/component-resolution.json")],
    mustInclude: ["requires exactly one primary visualContract; found 2"],
  },
  {
    name: "bad-source-node-mismatch",
    expect: "FAIL",
    args: ["--artifact", path.join(fixtures, "bad-source-node-mismatch/component-resolution.json")],
    mustInclude: ["does not match source desktop node"],
  },
  {
    name: "bad-unused-resolution",
    expect: "FAIL",
    args: ["--artifact", path.join(fixtures, "bad-unused-resolution/component-resolution.json")],
    mustInclude: ["resolved component not used in implementationFiles: TextField"],
  },
  {
    name: "bad-unapproved-composition",
    expect: "FAIL",
    args: [
      "--artifact",
      path.join(fixtures, "bad-unapproved-composition/component-resolution.json"),
    ],
    mustInclude: ["custom component not approved: Unapproved"],
  },
  {
    name: "bad-missing-implementation-file",
    expect: "FAIL",
    args: [
      "--artifact",
      path.join(fixtures, "bad-missing-implementation-file/component-resolution.json"),
    ],
    mustInclude: ["implementation file missing"],
  },
  {
    name: "bad-stale-prop-map",
    expect: "FAIL",
    run: runStalePropMapCase,
    mustInclude: ["code API hash changed"],
  },
  {
    name: "bad-spread-props",
    expect: "FAIL",
    run: runSpreadPropsCase,
    mustInclude: ["unresolved JSX spread props"],
  },
  {
    name: "good-screen",
    expect: "PASS",
    args: ["--artifact", path.join(fixtures, "good-screen/component-resolution.json")],
  },
  {
    name: "good-empty-component-screen",
    expect: "PASS",
    args: ["--artifact", path.join(fixtures, "good-empty-screen/component-resolution.json")],
  },
  {
    name: "good-region-screen",
    expect: "PASS",
    args: ["--artifact", path.join(fixtures, "good-region-screen/component-resolution.json")],
  },
  {
    name: "old-weakening-flag",
    expect: "FAIL",
    args: [
      "--artifact",
      path.join(fixtures, "good-screen/component-resolution.json"),
      "--files",
      path.join(fixtures, "good-button/GoodButton.tsx"),
    ],
    mustInclude: ["unknown argument", "contract owns files"],
  },
];
let failed = 0;
for (const testCase of cases) {
  const result = testCase.run?.() ?? runGate(testCase.args ?? []);
  const output = `${result.stdout ?? ""}
${result.stderr ?? ""}`;
  const passed = output.includes("PASS") && result.status === 0;
  const failedRun = output.includes("FAIL") || result.status !== 0;
  const ok =
    testCase.expect === "PASS"
      ? passed
      : failedRun && (testCase.mustInclude?.every((needle) => output.includes(needle)) ?? true);
  if (!ok) {
    failed += 1;
    console.error(`\u2717 ${testCase.name} (expected ${testCase.expect})`);
    console.error(output);
  } else {
    console.log(`\u2713 ${testCase.name} \u2192 ${testCase.expect}`);
  }
}
if (failed > 0) {
  console.error(`
${failed} pressure case(s) failed`);
  process.exit(1);
}
console.log(`
All ${cases.length} pressure cases ok`);
