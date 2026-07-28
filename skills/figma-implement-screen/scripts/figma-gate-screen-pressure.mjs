#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  layoutMapDuplicateIdentities,
  propMapGroupConflicts,
} from "./figma-gate-screen-components-internal.mjs";
import { loadScreenConfig, packageScriptCommand } from "./screen-config.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const screenConfig = loadScreenConfig(root);
const screenScripts = path.join(root, ".agents/skills/figma-implement-screen/scripts");
const fixtureFile =
  ".agents/skills/figma-implement-screen/scripts/fixtures/good-button/GoodButton.tsx";
const artifactRoot = `.figma/artifacts/screens/pressure/unified-${process.pid}`;
const absoluteArtifactRoot = path.join(root, artifactRoot);
const propSourceFixture = path.join(
  root,
  ".agents/skills/figma-implement-component/scripts/fixtures/button-definition-groups.json",
);
const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-screen-fetch-mock-"));
const mockFetchPath = path.join(mockDir, "mock-fetch.cjs");
const propSourceGroups = JSON.parse(fs.readFileSync(propSourceFixture, "utf-8")).groups;
fs.writeFileSync(
  mockFetchPath,
  `const groups = ${JSON.stringify(propSourceGroups)};
global.fetch = async (url) => { const ids = new URL(url).searchParams.get('ids').split(','); const byId = new Map(groups.map((group) => [group.figmaNodeId, group])); return { ok: true, status: 200, statusText: 'OK', json: async () => ({ version: 'pressure-v1', lastModified: '2026-07-19T00:00:00Z', nodes: Object.fromEntries(ids.map((id) => { const group = byId.get(id); return [id, { document: group ? { id, name: group.name, type: 'COMPONENT_SET', componentPropertyDefinitions: group.propertyDefinitions } : { id, name: 'Source', type: 'FRAME' } }]; })) }) }; };
`,
);
const testEnv = {
  ...process.env,
  FIGMA_ACCESS_TOKEN: "pressure-token",
  NODE_OPTIONS: `--require=${mockFetchPath}`,
};
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function sha256(content) {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}
function payloadHash(value) {
  return sha256(canonicalize(value));
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify(value, null, 2)}
`,
  );
}
function runNode(scriptPath, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    env: testEnv,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
}
function runScreenPackage(artifactPath) {
  const packageCommand = packageScriptCommand(screenConfig.packageManager, "figma-gate:screen", [
    "--artifact",
    artifactPath,
  ]);
  return spawnSync(packageCommand.command, packageCommand.args, {
    cwd: root,
    env: testEnv,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
}
function output(result) {
  return `${result.stdout ?? ""}
${result.stderr ?? ""}`;
}
function assertCase(name, result, expectation, needle) {
  const text = output(result);
  const passed = result.status === 0 && text.includes("PASS");
  const failed = result.status !== 0 && text.includes("FAIL");
  const ok =
    expectation === "PASS"
      ? passed && (!needle || text.includes(needle))
      : failed && (!needle || text.includes(needle));
  if (!ok)
    throw new Error(`${name} expected ${expectation}
${text}`);
  console.log(`\u2713 ${name} \u2192 ${expectation}`);
}
function makeVisualEvidence(outDir) {
  const absoluteOutDir = path.join(root, outDir);
  const files = {
    gold: path.join(absoluteOutDir, "figma-gold.png"),
    goldMeta: path.join(absoluteOutDir, "figma-gold.meta.json"),
    actual: path.join(absoluteOutDir, "actual.png"),
    diff: path.join(absoluteOutDir, "diff.png"),
  };
  fs.mkdirSync(absoluteOutDir, { recursive: true });
  fs.writeFileSync(files.gold, "gold");
  fs.writeFileSync(files.actual, "actual");
  fs.writeFileSync(files.diff, "diff");
  const capturedAt = /* @__PURE__ */ new Date().toISOString();
  writeJson(files.goldMeta, { fileKey: "x", nodeId: "1:2", fetchedAt: capturedAt });
  const shared = {
    fileKey: "x",
    nodeId: "1:2",
    viewport: "desktop",
    profile: "page",
    selector: null,
    expectSize: null,
    pageReason: "Full-bleed pressure fixture.",
  };
  writeJson(path.join(absoluteOutDir, "visual-score.json"), {
    schemaVersion: 2,
    ...shared,
    pass: true,
    runType: "final",
    capturedAt,
    stability: "stable",
    outDir: absoluteOutDir,
    gold: {
      path: files.gold,
      metaPath: files.goldMeta,
      fileKey: shared.fileKey,
      nodeId: shared.nodeId,
      fetchedAt: capturedAt,
    },
    topIssues: [],
    evidenceHashes: Object.fromEntries(
      Object.entries(files).map(([key, file]) => [key, sha256(fs.readFileSync(file))]),
    ),
  });
  writeJson(path.join(absoluteOutDir, "run-meta.json"), {
    schemaVersion: 2,
    ...shared,
    viewportSize: { width: 1440, height: 1024 },
  });
  writeJson(path.join(absoluteOutDir, "punch-list.json"), {
    schemaVersion: 2,
    pass: true,
    items: [],
  });
}
function main() {
  fs.mkdirSync(absoluteArtifactRoot, { recursive: true });
  try {
    const propConflicts = propMapGroupConflicts({
      schemaVersion: 2,
      target: { component: "Pressure", file: "src/components/ui/pressure.tsx", apiHash: "x" },
      groups: [
        {
          figmaNodeId: "1:1",
          name: "first",
          mappings: [
            {
              figmaProp: "State#1:10",
              figmaType: "VARIANT",
              mappingKind: "direct",
              reactProp: "state",
            },
          ],
        },
        {
          figmaNodeId: "2:2",
          name: "second",
          mappings: [
            {
              figmaProp: "State#2:20",
              figmaType: "VARIANT",
              mappingKind: "direct",
              reactProp: "variant",
            },
          ],
        },
      ],
    });
    if (propConflicts.length !== 1 || !propConflicts[0]?.startsWith("State ")) {
      throw new Error(
        `prop-map group conflict detector missed conflict: ${propConflicts.join(",")}`,
      );
    }
    console.log("\u2713 conflicting group-local prop mappings \u2192 FAIL");
    const duplicateLayoutIdentities = layoutMapDuplicateIdentities({
      schemaVersion: 1,
      mappings: [
        {
          fileKey: "file",
          componentId: "1:2",
          componentName: "Header",
          codeComponent: "Header",
          importPath: "#/components/layout/header",
        },
        {
          fileKey: "file",
          componentId: "1:2",
          componentName: "Header",
          codeComponent: "OtherHeader",
          importPath: "#/components/layout/other-header",
        },
      ],
    });
    if (duplicateLayoutIdentities.length !== 1) {
      throw new Error("layout registry duplicate identity detector missed conflict");
    }
    console.log("\u2713 duplicate layout registry identity \u2192 FAIL");
    const responsePath = path.join(absoluteArtifactRoot, "figma-response.json");
    const inventoryPath = `${artifactRoot}/figma-inventory.json`;
    writeJson(responsePath, {
      version: "pressure-v1",
      lastModified: "2026-07-19T00:00:00Z",
      nodes: {
        "1:2": {
          document: {
            id: "1:2",
            name: "Root",
            type: "FRAME",
            absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 1024 },
            children: [
              {
                id: "2:1",
                name: "Button",
                type: "INSTANCE",
                componentId: "3:1",
                absoluteBoundingBox: { x: 640, y: 480, width: 160, height: 48 },
              },
              { id: "2:2", name: "Hidden", type: "INSTANCE", visible: false },
            ],
          },
          components: { "3:1": { name: "Button" } },
        },
      },
    });
    assertCase(
      "raw-inventory-generator",
      runNode(path.join(screenScripts, "figma-inventory.mjs"), [
        "--file-key",
        "x",
        "--source",
        "component=1:2",
        "--out",
        inventoryPath,
        "--input-response",
        responsePath,
      ]),
      "PASS",
    );
    const inventory = JSON.parse(fs.readFileSync(path.join(root, inventoryPath), "utf-8"));
    if (
      inventory.items.length !== 1 ||
      inventory.items[0].nodeId !== "2:1" ||
      inventory.nodeTree.length !== 2 ||
      inventory.nodeTree.find((node) => node.nodeId === "2:1")?.parentNodeId !== "1:2" ||
      inventory.nodeTree.find((node) => node.nodeId === "1:2")?.bounds?.width !== 1440
    ) {
      throw new Error("raw inventory did not exclude hidden node deterministically");
    }
    const visualOutDir = `${artifactRoot}/component/page`;
    makeVisualEvidence(visualOutDir);
    const artifact = {
      schemaVersion: 5,
      name: "pressure-unified",
      target: { kind: "screen", route: "/pressure" },
      source: { fileKey: "x", nodes: [{ id: "component", nodeId: "1:2" }] },
      inventoryEvidence: { filePath: inventoryPath, contentHash: inventory.contentHash },
      detectedComponents: [
        { sourceId: "component", nodeId: "2:1", name: "Button", kind: "design-system" },
      ],
      ignoredInventoryNodes: [],
      implementationFiles: [fixtureFile],
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
      entryComponents: [{ componentName: "GoodButton", filePath: fixtureFile, role: "showcase" }],
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
          outDir: visualOutDir,
          profile: "page",
          pageReason: "Full-bleed pressure fixture.",
        },
      ],
    };
    const artifactPath = path.join(absoluteArtifactRoot, "screen-implementation.json");
    writeJson(artifactPath, artifact);
    const regionArtifact = {
      ...artifact,
      visualContracts: [
        {
          id: "component.region.button",
          sourceId: "component",
          sourceNodeId: "1:2",
          goldNodeId: "2:1",
          role: "primary",
          scope: "region",
          region: "button",
          viewport: { name: "desktop", width: 1440, height: 1024 },
          outDir: `${artifactRoot}/component/regions/button`,
          profile: "component/strict",
          selector: '[data-testid="fixture"]',
          expectSize: { width: 160, height: 48 },
        },
      ],
    };
    writeJson(artifactPath, regionArtifact);
    assertCase(
      "region-gold-descendant-binding",
      runNode(path.join(screenScripts, "figma-gate-screen-components-internal.mjs"), [
        "--artifact",
        artifactPath,
      ]),
      "PASS",
    );
    writeJson(artifactPath, {
      ...regionArtifact,
      visualContracts: [{ ...regionArtifact.visualContracts[0], goldNodeId: "9:9" }],
    });
    assertCase(
      "region-gold-unrelated-node",
      runNode(path.join(screenScripts, "figma-gate-screen-components-internal.mjs"), [
        "--artifact",
        artifactPath,
      ]),
      "FAIL",
      "must be a visible descendant",
    );
    const regionCandidatePayload = structuredClone(inventory);
    delete regionCandidatePayload.contentHash;
    regionCandidatePayload.nodeTree.push({
      sourceId: "component",
      nodeId: "2:3",
      parentNodeId: "1:2",
      name: "Primary card",
      nodeType: "INSTANCE",
      bounds: { x: 360, y: 160, width: 720, height: 640 },
    });
    const regionCandidateInventory = {
      ...regionCandidatePayload,
      contentHash: payloadHash(regionCandidatePayload),
    };
    writeJson(path.join(root, inventoryPath), regionCandidateInventory);
    writeJson(artifactPath, {
      ...artifact,
      inventoryEvidence: {
        filePath: inventoryPath,
        contentHash: regionCandidateInventory.contentHash,
      },
    });
    assertCase(
      "page-primary-remains-developer-choice",
      runNode(path.join(screenScripts, "figma-gate-screen-components-internal.mjs"), [
        "--artifact",
        artifactPath,
      ]),
      "PASS",
    );
    writeJson(artifactPath, {
      ...regionArtifact,
      inventoryEvidence: {
        filePath: inventoryPath,
        contentHash: regionCandidateInventory.contentHash,
      },
    });
    assertCase(
      "region-primary-remains-developer-choice",
      runNode(path.join(screenScripts, "figma-gate-screen-components-internal.mjs"), [
        "--artifact",
        artifactPath,
      ]),
      "PASS",
    );
    writeJson(artifactPath, {
      ...regionArtifact,
      inventoryEvidence: {
        filePath: inventoryPath,
        contentHash: regionCandidateInventory.contentHash,
      },
      visualContracts: [{ ...regionArtifact.visualContracts[0], goldNodeId: "2:3" }],
    });
    assertCase(
      "region-primary-generated-candidate",
      runNode(path.join(screenScripts, "figma-gate-screen-components-internal.mjs"), [
        "--artifact",
        artifactPath,
      ]),
      "PASS",
    );
    const primitiveSubtreePayload = structuredClone(inventory);
    delete primitiveSubtreePayload.contentHash;
    primitiveSubtreePayload.nodeTree.push({
      sourceId: "component",
      nodeId: "2:4",
      parentNodeId: "2:1",
      name: "Button inner frame",
      nodeType: "FRAME",
      bounds: { x: 620, y: 450, width: 320, height: 180 },
    });
    const primitiveSubtreeInventory = {
      ...primitiveSubtreePayload,
      contentHash: payloadHash(primitiveSubtreePayload),
    };
    writeJson(path.join(root, inventoryPath), primitiveSubtreeInventory);
    writeJson(artifactPath, {
      ...artifact,
      inventoryEvidence: {
        filePath: inventoryPath,
        contentHash: primitiveSubtreeInventory.contentHash,
      },
    });
    assertCase(
      "primitive-subtree-excluded-from-region-candidates",
      runNode(path.join(screenScripts, "figma-gate-screen-components-internal.mjs"), [
        "--artifact",
        artifactPath,
      ]),
      "PASS",
    );
    writeJson(path.join(root, inventoryPath), inventory);
    writeJson(artifactPath, {
      ...artifact,
      detectedComponents: artifact.detectedComponents.map((component) => ({
        ...component,
        kind: "layout",
      })),
      resolved: artifact.resolved.map((resolution) => ({ ...resolution, kind: "layout" })),
    });
    assertCase(
      "design-system-instance-mislabeled-layout",
      runNode(path.join(screenScripts, "figma-gate-screen-components-internal.mjs"), [
        "--artifact",
        artifactPath,
      ]),
      "FAIL",
      "detected component kind must come from .figma/layout-map.json",
    );
    writeJson(artifactPath, artifact);
    assertCase("unified-good", runScreenPackage(artifactPath), "PASS");
    const rawIgnoredFile = `${artifactRoot}/RawIgnoredButton.tsx`;
    fs.writeFileSync(
      path.join(root, rawIgnoredFile),
      'export function RawIgnoredButton() {\n  return <button type="button">Ignored</button>;\n}\n',
    );
    writeJson(artifactPath, {
      ...artifact,
      detectedComponents: [],
      ignoredInventoryNodes: [
        {
          sourceId: "component",
          nodeId: "2:1",
          name: "Button",
          nodeType: "INSTANCE",
          componentId: "3:1",
          componentName: "Button",
          classification: "not-reusable",
          reason: "Pressure bypass attempt.",
        },
      ],
      implementationFiles: [rawIgnoredFile],
      resolved: [],
      entryComponents: [
        { componentName: "RawIgnoredButton", filePath: rawIgnoredFile, role: "screen" },
      ],
    });
    assertCase(
      "ignored-button-instance-raw-button",
      runNode(path.join(screenScripts, "figma-gate-screen-components-internal.mjs"), [
        "--artifact",
        artifactPath,
      ]),
      "FAIL",
      "known design-system component cannot be ignored",
    );
    const customInventoryPayload = structuredClone(inventory);
    delete customInventoryPayload.contentHash;
    customInventoryPayload.items[0].name = "MarketingCard";
    customInventoryPayload.items[0].componentName = "MarketingCard";
    const customInventory = {
      ...customInventoryPayload,
      contentHash: payloadHash(customInventoryPayload),
    };
    writeJson(path.join(root, inventoryPath), customInventory);
    writeJson(artifactPath, {
      ...artifact,
      inventoryEvidence: { filePath: inventoryPath, contentHash: customInventory.contentHash },
      detectedComponents: [],
      ignoredInventoryNodes: [
        {
          sourceId: "component",
          nodeId: "2:1",
          name: "MarketingCard",
          nodeType: "INSTANCE",
          componentId: "3:1",
          componentName: "MarketingCard",
          classification: "not-reusable",
          reason: "Pressure unapproved ignore.",
        },
      ],
      implementationFiles: [rawIgnoredFile],
      resolved: [],
      entryComponents: [
        { componentName: "RawIgnoredButton", filePath: rawIgnoredFile, role: "screen" },
      ],
    });
    assertCase(
      "not-reusable-reason-needs-no-preapproval",
      runNode(path.join(screenScripts, "figma-gate-screen-components-internal.mjs"), [
        "--artifact",
        artifactPath,
      ]),
      "PASS",
    );
    const rawReplacementFile = `${artifactRoot}/RawIgnoredReplacement.tsx`;
    fs.writeFileSync(
      path.join(root, rawReplacementFile),
      [
        'import { SiGithub } from "@icons-pack/react-simple-icons";',
        'import { Loader2Icon } from "lucide-react";',
        "",
        "export function RawIgnoredReplacement() {",
        "  return (",
        "    <article>",
        '      <Loader2Icon aria-label="Loading" />',
        '      <SiGithub aria-label="GitHub" />',
        "      <div>Hand-built marketing card</div>",
        "    </article>",
        "  );",
        "}",
        "",
      ].join("\n"),
    );
    const decorativeAssetFile = `${artifactRoot}/marketing-card.svg`;
    fs.writeFileSync(path.join(root, decorativeAssetFile), "<svg></svg>\n");
    const semanticIgnoreCases = [
      {
        name: "ui-icon-replacement-needs-no-preapproval",
        classification: "ui-icon",
        replacement: { kind: "lucide", importName: "Loader2Icon" },
        assets: [],
      },
      {
        name: "brand-icon-replacement-needs-no-preapproval",
        classification: "brand-icon",
        replacement: { kind: "simple-icon", importName: "SiGithub" },
        assets: [],
      },
      {
        name: "decorative-replacement-needs-no-preapproval",
        classification: "decorative",
        replacement: { kind: "asset", filePath: decorativeAssetFile },
        assets: [
          {
            figmaNode: "2:1",
            kind: "decorative",
            filePath: decorativeAssetFile,
            source: "figma-mcp",
          },
        ],
      },
    ];
    for (const semanticCase of semanticIgnoreCases) {
      writeJson(artifactPath, {
        ...artifact,
        inventoryEvidence: { filePath: inventoryPath, contentHash: customInventory.contentHash },
        detectedComponents: [],
        ignoredInventoryNodes: [
          {
            sourceId: "component",
            nodeId: "2:1",
            name: "MarketingCard",
            nodeType: "INSTANCE",
            componentId: "3:1",
            componentName: "MarketingCard",
            classification: semanticCase.classification,
            reason: "Pressure semantic-classification bypass attempt.",
            replacement: semanticCase.replacement,
          },
        ],
        implementationFiles: [rawReplacementFile],
        resolved: [],
        entryComponents: [
          {
            componentName: "RawIgnoredReplacement",
            filePath: rawReplacementFile,
            role: "screen",
          },
        ],
        assets: semanticCase.assets,
      });
      assertCase(
        semanticCase.name,
        runNode(path.join(screenScripts, "figma-gate-screen-components-internal.mjs"), [
          "--artifact",
          artifactPath,
        ]),
        "PASS",
      );
    }
    writeJson(path.join(root, inventoryPath), inventory);
    writeJson(artifactPath, {
      ...artifact,
      target: { kind: "design-system-component", componentName: "Button" },
    });
    assertCase(
      "screen-gate-rejects-component-kind",
      runNode(path.join(screenScripts, "figma-gate-screen.mjs"), ["--artifact", artifactPath]),
      "FAIL",
      "requires target.kind=screen",
    );
    writeJson(artifactPath, { ...artifact, entryComponents: [] });
    assertCase(
      "ast-rejects-unowned-local-root",
      runNode(path.join(screenScripts, "figma-gate-screen-components-internal.mjs"), [
        "--artifact",
        artifactPath,
      ]),
      "FAIL",
      "local React component lacks entryComponents/screenCompositions ownership",
    );
    writeJson(artifactPath, artifact);
    const scorePath = path.join(root, visualOutDir, "visual-score.json");
    const score = JSON.parse(fs.readFileSync(scorePath, "utf-8"));
    writeJson(scorePath, {
      ...score,
      pass: false,
      matchRatio: 0.9,
      topIssues: [{ kind: "residual", severity: "high", message: "Pressure mismatch." }],
    });
    assertCase(
      "visual-quality-blocks-handoff",
      runNode(path.join(screenScripts, "figma-gate-screen.mjs"), ["--artifact", artifactPath]),
      "FAIL",
      "visual contract component.page quality blocked",
    );
    writeJson(scorePath, score);
    writeJson(scorePath, { ...score, profile: "component/strict" });
    assertCase(
      "unified-rejects-visual-contract-drift",
      runNode(path.join(screenScripts, "figma-gate-screen.mjs"), ["--artifact", artifactPath]),
      "FAIL",
      "profile does not match contract",
    );
    console.log("\nAll unified screen pressure cases ok");
  } finally {
    fs.rmSync(absoluteArtifactRoot, { recursive: true, force: true });
    fs.rmSync(mockDir, { recursive: true, force: true });
  }
}
main();
