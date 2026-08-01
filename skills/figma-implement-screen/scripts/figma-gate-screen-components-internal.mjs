#!/usr/bin/env node
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { getFrameworkAdapter } from "./adapters/index.mjs";
import {
  aliasBarrelSources,
  DEFAULT_SCREEN_CONFIG,
  loadScreenConfig,
  matchesScreensGlob,
  normalizeImportPath,
} from "./screen-config.mjs";
const LAYOUT_MAP_FILE = ".figma/layout-map.json";
const SOURCE_NODE_ID = /^\d+:\d+$/;
const FIGMA_NODE_ID = /^(?:I\d+:\d+(?:;\d+:\d+)+|\d+:\d+)$/;
const REPO_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+/;
const OUTPUT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTRACT_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const requestedNodeSchema = z
  .object({
    id: z.string().regex(OUTPUT_ID, "expected lowercase kebab-case source id"),
    nodeId: z.string().regex(SOURCE_NODE_ID, "expected Figma source node id like 1:2"),
  })
  .strict();
const detectedComponentSchema = z
  .object({
    sourceId: z.string().regex(OUTPUT_ID, "expected lowercase kebab-case source id"),
    nodeId: z.string().regex(FIGMA_NODE_ID, "expected Figma node id like 1:2"),
    name: z.string().min(1),
    kind: z.enum(["design-system", "layout"]),
  })
  .strict();
const evidenceSchema = z
  .object({
    filePath: z
      .string()
      .regex(REPO_RELATIVE_PATH, "expected repo-relative path")
      .startsWith(".figma/artifacts/"),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const visualVerificationSchema = z
  .object({
    artifactPath: z
      .string()
      .regex(REPO_RELATIVE_PATH, "expected repo-relative path")
      .startsWith(".figma/artifacts/visual-verifications/"),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const ignoredInventoryIdentity = {
  sourceId: z.string().regex(OUTPUT_ID, "expected lowercase kebab-case source id"),
  nodeId: z.string().regex(FIGMA_NODE_ID, "expected Figma node id like 1:2"),
  name: z.string().min(1),
  nodeType: z.enum(["INSTANCE", "COMPONENT", "COMPONENT_SET"]),
  componentId: z.string().nullable(),
  componentName: z.string().nullable(),
  reason: z.string().min(1),
};
const lucideReplacementSchema = z
  .object({
    kind: z.literal("lucide"),
    importName: z.string().regex(/^[A-Z][A-Za-z0-9]*Icon$/),
  })
  .strict();
const simpleIconReplacementSchema = z
  .object({
    kind: z.literal("simple-icon"),
    importName: z.string().regex(/^Si[A-Z][A-Za-z0-9]*$/),
  })
  .strict();
const assetReplacementSchema = z
  .object({
    kind: z.literal("asset"),
    filePath: z.string().regex(REPO_RELATIVE_PATH),
  })
  .strict();
const ignoredInventoryNodeSchema = z.discriminatedUnion("classification", [
  z
    .object({
      ...ignoredInventoryIdentity,
      classification: z.literal("ui-icon"),
      replacement: lucideReplacementSchema,
    })
    .strict(),
  z
    .object({
      ...ignoredInventoryIdentity,
      classification: z.literal("brand-icon"),
      replacement: simpleIconReplacementSchema,
    })
    .strict(),
  z
    .object({
      ...ignoredInventoryIdentity,
      classification: z.literal("decorative"),
      replacement: assetReplacementSchema,
    })
    .strict(),
  z
    .object({
      ...ignoredInventoryIdentity,
      classification: z.literal("not-reusable"),
    })
    .strict(),
]);
const ownedComponentSchema = z
  .object({
    componentName: z.string().min(1),
    filePath: z.string().regex(REPO_RELATIVE_PATH, "expected repo-relative path"),
    role: z.enum(["screen", "route", "layout", "showcase"]),
  })
  .strict();
const designSystemResolutionSchema = z
  .object({
    kind: z.literal("design-system"),
    figmaNodes: z.array(z.string().regex(FIGMA_NODE_ID)).min(1),
    codeComponent: z.string().min(1),
    importPath: z.string().min(1),
    decision: z.literal("reuse"),
    registryEntry: z
      .object({
        filePath: z
          .string()
          .regex(/^registry\/(?:[^/]+\/)+[^/]+\.json$/, "expected registry/<area>/<ExportName>.json"),
        contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();
const layoutResolutionSchema = z
  .object({
    kind: z.literal("layout"),
    figmaNodes: z.array(z.string().regex(FIGMA_NODE_ID)).min(1),
    codeComponent: z.string().min(1),
    importPath: z.string().min(1),
    decision: z.literal("reuse"),
  })
  .strict();
const viewportSchema = z
  .object({
    name: z.enum(["mobile", "desktop"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
const visualContractBase = {
  id: z.string().regex(CONTRACT_ID, "expected lowercase dot-separated contract id"),
  sourceId: z.string().regex(OUTPUT_ID, "expected lowercase kebab-case source id"),
  sourceNodeId: z.string().regex(FIGMA_NODE_ID, "expected Figma node id like 1:2"),
  goldNodeId: z.string().regex(FIGMA_NODE_ID, "expected Figma node id like 1:2"),
  role: z.enum(["primary", "supplemental"]),
  viewport: viewportSchema,
  outDir: z
    .string()
    .regex(REPO_RELATIVE_PATH, "expected repo-relative path")
    .startsWith(".figma/artifacts/"),
};
const regionVisualContractSchema = z
  .object({
    ...visualContractBase,
    scope: z.literal("region"),
    region: z.string().regex(OUTPUT_ID, "expected lowercase kebab-case region id"),
    profile: z.literal("component/strict"),
    selector: z.string().min(1),
    expectSize: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
const pageVisualContractSchema = z
  .object({
    ...visualContractBase,
    scope: z.literal("page"),
    profile: z.literal("page"),
    pageReason: z.string().min(1),
  })
  .strict();
const componentResolutionArtifactSchema = z
  .object({
    schemaVersion: z.literal(3),
    name: z.string().min(1),
    target: z.object({ kind: z.literal("screen"), route: z.string().startsWith("/") }).strict(),
    source: z
      .object({
        fileKey: z.string().min(1),
        nodes: z.array(requestedNodeSchema).min(1),
      })
      .strict(),
    inventoryEvidence: evidenceSchema.optional(),
    detectedComponents: z.array(detectedComponentSchema),
    ignoredInventoryNodes: z.array(ignoredInventoryNodeSchema).optional(),
    implementationFiles: z
      .array(z.string().regex(REPO_RELATIVE_PATH, "expected repo-relative path"))
      .min(1),
    resolved: z.array(
      z.discriminatedUnion("kind", [designSystemResolutionSchema, layoutResolutionSchema]),
    ),
    unresolved: z.array(
      z
        .object({
          figmaNode: z.string().regex(FIGMA_NODE_ID, "expected detected Figma node id"),
          reason: z.string().min(1),
        })
        .strict(),
    ),
    screenCompositions: z.array(
      z
        .object({
          componentName: z.string().min(1),
          filePath: z.string().regex(REPO_RELATIVE_PATH, "expected repo-relative path"),
          reason: z.string().min(1),
        })
        .strict(),
    ),
    entryComponents: z.array(ownedComponentSchema).optional(),
    assets: z.array(
      z
        .object({
          figmaNode: z.string().min(1),
          kind: z.enum(["photo", "illustration", "logo", "decorative"]),
          filePath: z.string().regex(REPO_RELATIVE_PATH, "expected repo-relative path"),
          source: z.literal("figma-mcp"),
        })
        .strict(),
    ),
    visualContracts: z.array(
      z.discriminatedUnion("scope", [regionVisualContractSchema, pageVisualContractSchema]),
    ),
    visualVerification: visualVerificationSchema.optional(),
  })
  .strict();
const inventoryFileSchema = z
  .object({
    schemaVersion: z.literal(2),
    generator: z.literal("figma-inventory-fetch@2"),
    fileKey: z.string().min(1),
    sourceNodes: z.array(requestedNodeSchema).min(1),
    version: z.string().nullable(),
    lastModified: z.string().nullable(),
    visibleOnly: z.literal(true),
    nodeTree: z.array(
      z
        .object({
          sourceId: z.string().regex(OUTPUT_ID),
          nodeId: z.string().regex(FIGMA_NODE_ID),
          parentNodeId: z.string().regex(FIGMA_NODE_ID).nullable(),
          name: z.string().min(1),
          nodeType: z.string().min(1),
          bounds: z
            .object({
              x: z.number(),
              y: z.number(),
              width: z.number().positive(),
              height: z.number().positive(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    items: z.array(
      z
        .object({
          sourceId: z.string().regex(OUTPUT_ID),
          nodeId: z.string().regex(FIGMA_NODE_ID),
          name: z.string().min(1),
          nodeType: z.enum(["INSTANCE", "COMPONENT", "COMPONENT_SET"]),
          componentId: z.string().nullable(),
          componentName: z.string().nullable(),
        })
        .strict(),
    ),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const layoutMapSchema = z
  .object({
    schemaVersion: z.literal(1),
    mappings: z.array(
      z
        .object({
          fileKey: z.string().min(1),
          componentId: z.string().min(1),
          componentName: z.string().min(1),
          codeComponent: z.string().min(1),
          importPath: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
function layoutMapDuplicateIdentities(layoutMap) {
  const seen = /* @__PURE__ */ new Set();
  const duplicates = /* @__PURE__ */ new Set();
  for (const mapping of layoutMap.mappings) {
    const identity = `${mapping.fileKey}::${mapping.componentId}`;
    if (seen.has(identity)) duplicates.add(identity);
    seen.add(identity);
  }
  return [...duplicates].sort();
}
function parseArgs() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const parsed = {};
  const unknown = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--artifact") {
      parsed.artifact = args[i + 1];
      i += 1;
      continue;
    }
    unknown.push(arg);
  }
  if (unknown.length > 0) {
    fail([
      `unknown argument(s): ${unknown.join(", ")}; contract owns files and all required checks`,
    ]);
  }
  return parsed;
}
function fail(reasons) {
  console.error("FAIL");
  for (const reason of reasons) {
    console.error(`- ${reason}`);
  }
  process.exit(1);
}
function readArtifact(artifactPath) {
  if (!fs.existsSync(artifactPath)) {
    fail([`component resolution artifact missing: ${artifactPath}`]);
  }
  let rawArtifact;
  try {
    rawArtifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
  } catch {
    fail([`component resolution artifact is not valid JSON: ${artifactPath}`]);
  }
  const parsed = componentResolutionArtifactSchema.safeParse(rawArtifact);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `component-resolution ${location}: ${issue.message}`;
    });
    fail(issues);
  }
  return parsed.data;
}
function importedLocalNames(analysis, resolution, config) {
  const allowed = aliasBarrelSources(resolution.importPath, config);
  const locals = /* @__PURE__ */ new Set();
  for (const [localName, binding] of analysis.imports) {
    if (!allowed.has(binding.source)) continue;
    if (binding.imported === resolution.codeComponent || binding.imported === "default") {
      locals.add(localName);
    }
    if (binding.imported === "*") {
      locals.add(`${localName}.${resolution.codeComponent}`);
    }
  }
  return locals;
}
function usesResolution(analysis, resolution, config) {
  for (const localName of importedLocalNames(analysis, resolution, config)) {
    if (analysis.componentNames.has(localName)) return true;
  }
  return false;
}
function stripFigmaPropId(name) {
  return name.replace(/#\d+:\d+$/, "").trim();
}
function codePropsForBinding(binding) {
  if (binding.mappingKind === "direct") return [binding.prop];
  if (binding.mappingKind === "bundle") return binding.props;
  return [];
}
function indexRegistryEntry(registryEntry) {
  const figmaNames = /* @__PURE__ */ new Map();
  const mappedCodeProps = /* @__PURE__ */ new Set();
  const bindingsByCodeProp = /* @__PURE__ */ new Map();
  for (const binding of registryEntry.figmaBindings) {
    const codeProps = codePropsForBinding(binding);
    const indexed = { binding, codeProps };
    figmaNames.set(stripFigmaPropId(binding.propName), indexed);
    figmaNames.set(binding.propName, indexed);
    for (const prop of codeProps) {
      mappedCodeProps.add(prop);
      const current = bindingsByCodeProp.get(prop) ?? [];
      current.push(binding);
      bindingsByCodeProp.set(prop, current);
    }
  }
  return { figmaNames, mappedCodeProps, bindingsByCodeProp };
}
function figmaValueKeysForCodeProp(bindings) {
  const keys = /* @__PURE__ */ new Set();
  for (const binding of bindings) {
    for (const key of Object.keys(binding.valueMap ?? binding.valueProps ?? {})) keys.add(key);
  }
  return keys;
}
function codeValuesForCodeProp(bindings, prop) {
  const values = /* @__PURE__ */ new Set();
  for (const binding of bindings) {
    if (binding.mappingKind === "direct") {
      for (const value of Object.values(binding.valueMap ?? {})) {
        if (value !== null && value !== void 0) values.add(String(value));
      }
    }
    if (binding.mappingKind === "bundle") {
      for (const assignment of Object.values(binding.valueProps ?? {})) {
        const value = assignment?.[prop];
        if (value !== null && value !== void 0) values.add(String(value));
      }
    }
  }
  return values;
}
function readRegistryEntry(resolution, reasons) {
  const registryPath = resolution.registryEntry.filePath;
  let registryEntry;
  try {
    registryEntry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
  } catch {
    reasons.push(`registry entry unreadable JSON for ${resolution.codeComponent} (${registryPath})`);
    return null;
  }
  if (
    registryEntry.schemaVersion !== 3 ||
    registryEntry.component?.exportName !== resolution.codeComponent ||
    typeof registryEntry.component?.filePath !== "string" ||
    !registryEntry.codePropsMap ||
    !Array.isArray(registryEntry.figmaBindings)
  ) {
    reasons.push(`registry entry schema/identity invalid for ${resolution.codeComponent} (${registryPath})`);
    return null;
  }
  const actualHash = contentHash(registryEntry);
  if (actualHash !== resolution.registryEntry.contentHash) {
    reasons.push(
      `registry entry contentHash mismatch for ${resolution.codeComponent}: artifact=${resolution.registryEntry.contentHash} actual=${actualHash}`,
    );
    return null;
  }
  return registryEntry;
}
function checkRegistryUsage(file, analysis, resolution, adapter, config, reasons) {
  if (resolution.kind !== "design-system") return;
  const registryEntry = readRegistryEntry(resolution, reasons);
  if (!registryEntry) return;
  const index = indexRegistryEntry(registryEntry);
  const locals = importedLocalNames(analysis, resolution, config);
  for (const usage of analysis.componentUsages) {
    if (!locals.has(usage.name)) continue;
    if (usage.spreadLines.length > 0) {
      reasons.push(
        `unresolved JSX spread props on mapped component in ${file}:${usage.spreadLines.join(",")}; pass explicit validated props to <${usage.name}>`,
      );
    }
    for (const attr of usage.attributes) {
      if (adapter.isAllowedComponentAttribute(attr.name)) continue;
      const figmaHit = index.figmaNames.get(attr.name);
      if (figmaHit && !figmaHit.codeProps.includes(attr.name)) {
        reasons.push(
          `figma prop name used as JSX attr in ${file}:${attr.line}; <${usage.name} ${attr.name}=...> should use mapped code prop(s) "${figmaHit.codeProps.join(", ")}" from ${resolution.registryEntry.filePath}`,
        );
        continue;
      }
      if (attr.value !== void 0 && index.mappedCodeProps.has(attr.name)) {
        const bindings = index.bindingsByCodeProp.get(attr.name) ?? [];
        const figmaValues = figmaValueKeysForCodeProp(bindings);
        if (figmaValues.has(attr.value)) {
          const codeValues = [...codeValuesForCodeProp(bindings, attr.name)];
          const hint =
            codeValues.length > 0
              ? ` (expected code value like ${codeValues.slice(0, 3).join("/")})`
              : "";
          reasons.push(
            `figma variant value used on mapped prop in ${file}:${attr.line}; <${usage.name} ${attr.name}="${attr.value}"> looks like Figma value, not code value${hint}`,
          );
        }
      }
    }
  }
}
function isDesignSystemResolution(resolution) {
  return resolution.kind === "design-system";
}
function expectedImportPath(targetFile, config) {
  return normalizeImportPath(targetFile.replace(/\.[cm]?[jt]sx?$/, ""), config);
}
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function contentHash(value) {
  return `sha256:${crypto.createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}
function validateInventoryEvidence(artifact, isKnownPrimitive, reasons) {
  const evidence = artifact.inventoryEvidence;
  if (!evidence) return null;
  if (!fs.existsSync(evidence.filePath)) {
    reasons.push(`inventory evidence missing: ${evidence.filePath}`);
    return null;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(evidence.filePath, "utf-8"));
  } catch {
    reasons.push(`inventory evidence unreadable JSON: ${evidence.filePath}`);
    return null;
  }
  const parsed = inventoryFileSchema.safeParse(raw);
  if (!parsed.success) {
    reasons.push(`inventory evidence invalid: ${evidence.filePath}`);
    return null;
  }
  const inventory = parsed.data;
  const { contentHash: declaredHash, ...payload } = inventory;
  const actualHash = contentHash(payload);
  if (declaredHash !== actualHash || evidence.contentHash !== actualHash) {
    reasons.push(
      `inventory contentHash mismatch: artifact=${evidence.contentHash} file=${declaredHash} actual=${actualHash}`,
    );
  }
  if (inventory.fileKey !== artifact.source.fileKey) {
    reasons.push(
      `inventory fileKey mismatch: inventory=${inventory.fileKey} artifact=${artifact.source.fileKey}`,
    );
  }
  const expectedSources = artifact.source.nodes.map((node) => `${node.id}:${node.nodeId}`).sort();
  const inventorySources = inventory.sourceNodes.map((node) => `${node.id}:${node.nodeId}`).sort();
  if (JSON.stringify(expectedSources) !== JSON.stringify(inventorySources)) {
    reasons.push("inventory sourceNodes do not match component-resolution source.nodes");
  }
  const inventoryItems = new Map(inventory.items.map((item) => [item.nodeId, item]));
  const classified = /* @__PURE__ */ new Set();
  for (const detected of artifact.detectedComponents) {
    const item = inventoryItems.get(detected.nodeId);
    if (!item) {
      reasons.push(`detected component absent from inventory evidence: ${detected.nodeId}`);
      continue;
    }
    if (item.sourceId !== detected.sourceId || item.name !== detected.name) {
      reasons.push(
        `detected component identity mismatch for ${detected.nodeId}: inventory=${item.sourceId}/${item.name} artifact=${detected.sourceId}/${detected.name}`,
      );
    }
    classified.add(detected.nodeId);
  }
  for (const ignored of artifact.ignoredInventoryNodes ?? []) {
    const item = inventoryItems.get(ignored.nodeId);
    if (!item) {
      reasons.push(`ignored component absent from inventory evidence: ${ignored.nodeId}`);
      continue;
    }
    if (item.sourceId !== ignored.sourceId || item.name !== ignored.name) {
      reasons.push(
        `ignored component identity mismatch for ${ignored.nodeId}: inventory=${item.sourceId}/${item.name} artifact=${ignored.sourceId}/${ignored.name}`,
      );
    }
    if (
      item.nodeType !== ignored.nodeType ||
      item.componentId !== ignored.componentId ||
      item.componentName !== ignored.componentName
    ) {
      reasons.push(
        `ignored component raw identity mismatch for ${ignored.nodeId}: inventory=${item.nodeType}/${item.componentId}/${item.componentName} artifact=${ignored.nodeType}/${ignored.componentId}/${ignored.componentName}`,
      );
    }
    const canonicalName = item.componentName ?? item.name;
    if (isKnownPrimitive(canonicalName)) {
      reasons.push(
        `known design-system component cannot be ignored: ${ignored.nodeId} (${canonicalName})`,
      );
    }
    if (ignored.classification === "decorative") {
      const asset = artifact.assets.find(
        (entry) =>
          entry.figmaNode === ignored.nodeId && entry.filePath === ignored.replacement.filePath,
      );
      if (!asset) {
        reasons.push(
          `decorative ignored node requires matching asset evidence: ${ignored.nodeId}/${ignored.replacement.filePath}`,
        );
      }
    }
    if (classified.has(ignored.nodeId)) {
      reasons.push(`inventory node classified more than once: ${ignored.nodeId}`);
    }
    classified.add(ignored.nodeId);
  }
  for (const item of inventory.items) {
    if (!classified.has(item.nodeId)) {
      reasons.push(
        `inventory node lacks detected/ignored classification: ${item.nodeId} (${item.name})`,
      );
    }
  }
  const treeKeys = /* @__PURE__ */ new Set();
  for (const node of inventory.nodeTree) {
    const key = `${node.sourceId}:${node.nodeId}`;
    if (treeKeys.has(key)) reasons.push(`inventory nodeTree duplicates node: ${key}`);
    treeKeys.add(key);
  }
  for (const node of inventory.nodeTree) {
    if (node.parentNodeId && !treeKeys.has(`${node.sourceId}:${node.parentNodeId}`)) {
      reasons.push(
        `inventory nodeTree parent missing: ${node.sourceId}:${node.nodeId} -> ${node.parentNodeId}`,
      );
    }
  }
  return inventory;
}
function isInventoryDescendant(inventory, sourceId, nodeId, ancestorNodeId) {
  const parents = new Map(
    inventory.nodeTree
      .filter((node) => node.sourceId === sourceId)
      .map((node) => [node.nodeId, node.parentNodeId]),
  );
  const visited = /* @__PURE__ */ new Set();
  let current = parents.get(nodeId);
  while (current && !visited.has(current)) {
    if (current === ancestorNodeId) return true;
    visited.add(current);
    current = parents.get(current);
  }
  return false;
}
function validateArtifactContract(artifact, isKnownPrimitive, reasons) {
  const inventory = validateInventoryEvidence(artifact, isKnownPrimitive, reasons);
  let layoutMap = null;
  try {
    layoutMap = layoutMapSchema.parse(JSON.parse(fs.readFileSync(LAYOUT_MAP_FILE, "utf-8")));
    const duplicates = layoutMapDuplicateIdentities(layoutMap);
    if (duplicates.length > 0) {
      reasons.push(`layout registry has duplicate Figma identities: ${duplicates.join(", ")}`);
      layoutMap = null;
    }
  } catch {
    reasons.push(`layout registry missing or invalid: ${LAYOUT_MAP_FILE}`);
  }
  const requestedSources = /* @__PURE__ */ new Map();
  const requestedNodeIds = /* @__PURE__ */ new Set();
  for (const node of artifact.source.nodes) {
    if (requestedSources.has(node.id)) {
      reasons.push(`duplicate source id: ${node.id}`);
    }
    if (requestedNodeIds.has(node.nodeId)) {
      reasons.push(`duplicate source nodeId: ${node.nodeId}`);
    }
    requestedSources.set(node.id, node.nodeId);
    requestedNodeIds.add(node.nodeId);
  }
  const detectedComponents = /* @__PURE__ */ new Map();
  for (const detected of artifact.detectedComponents) {
    if (!requestedSources.has(detected.sourceId)) {
      reasons.push(
        `detected component ${detected.nodeId} references unknown sourceId: ${detected.sourceId}`,
      );
    }
    if (detectedComponents.has(detected.nodeId)) {
      reasons.push(`duplicate detected component nodeId: ${detected.nodeId}`);
    }
    detectedComponents.set(detected.nodeId, detected);
    const item = inventory?.items.find((candidate) => candidate.nodeId === detected.nodeId);
    if (item && layoutMap) {
      const registered = layoutMap.mappings.some(
        (mapping) =>
          mapping.fileKey === artifact.source.fileKey &&
          mapping.componentId === item.componentId &&
          mapping.componentName === item.componentName,
      );
      const expectedKind = registered ? "layout" : "design-system";
      if (detected.kind !== expectedKind) {
        reasons.push(
          `detected component kind must come from ${LAYOUT_MAP_FILE}: ${detected.nodeId} expected=${expectedKind} actual=${detected.kind}`,
        );
      }
    }
  }
  const ignoredInventoryNodes = /* @__PURE__ */ new Set();
  for (const ignored of artifact.ignoredInventoryNodes ?? []) {
    if (!requestedSources.has(ignored.sourceId)) {
      reasons.push(
        `ignored inventory node ${ignored.nodeId} references unknown sourceId: ${ignored.sourceId}`,
      );
    }
    if (detectedComponents.has(ignored.nodeId)) {
      reasons.push(`inventory node appears in both detected and ignored: ${ignored.nodeId}`);
    }
    if (ignoredInventoryNodes.has(ignored.nodeId)) {
      reasons.push(`duplicate ignored inventory node: ${ignored.nodeId}`);
    }
    ignoredInventoryNodes.add(ignored.nodeId);
  }
  const implementationFiles = /* @__PURE__ */ new Set();
  for (const file of artifact.implementationFiles) {
    if (implementationFiles.has(file)) reasons.push(`duplicate implementation file: ${file}`);
    implementationFiles.add(file);
    if (!fs.existsSync(file)) reasons.push(`implementation file missing: ${file}`);
  }
  const resolvedComponents = /* @__PURE__ */ new Set();
  const resolvedFigmaNodes = /* @__PURE__ */ new Set();
  for (const resolution of artifact.resolved) {
    if (resolvedComponents.has(resolution.codeComponent)) {
      reasons.push(`duplicate resolved code component: ${resolution.codeComponent}`);
    }
    resolvedComponents.add(resolution.codeComponent);
    if (resolution.kind === "layout" && inventory && layoutMap) {
      for (const figmaNode of resolution.figmaNodes) {
        const item = inventory.items.find((candidate) => candidate.nodeId === figmaNode);
        const registered = layoutMap.mappings.some(
          (mapping) =>
            mapping.fileKey === artifact.source.fileKey &&
            mapping.componentId === item?.componentId &&
            mapping.componentName === item?.componentName &&
            mapping.codeComponent === resolution.codeComponent &&
            mapping.importPath === resolution.importPath,
        );
        if (!registered) {
          reasons.push(
            `layout resolution lacks exact ${LAYOUT_MAP_FILE} mapping: ${figmaNode} -> ${resolution.codeComponent}`,
          );
        }
      }
    }
    for (const figmaNode of resolution.figmaNodes) {
      const detected = detectedComponents.get(figmaNode);
      if (!detected) {
        reasons.push(
          `resolved Figma node missing from detectedComponents: ${figmaNode} (${resolution.codeComponent})`,
        );
      } else if (detected.kind !== resolution.kind) {
        reasons.push(
          `resolved Figma node kind mismatch: ${figmaNode} inventory=${detected.kind} resolution=${resolution.kind}`,
        );
      }
      if (resolvedFigmaNodes.has(figmaNode)) {
        reasons.push(`Figma node resolved more than once: ${figmaNode}`);
      }
      resolvedFigmaNodes.add(figmaNode);
    }
  }
  const unresolvedFigmaNodes = /* @__PURE__ */ new Set();
  for (const unresolved of artifact.unresolved) {
    if (!detectedComponents.has(unresolved.figmaNode)) {
      reasons.push(
        `unresolved Figma node missing from detectedComponents: ${unresolved.figmaNode}`,
      );
    }
    if (resolvedFigmaNodes.has(unresolved.figmaNode)) {
      reasons.push(`Figma node appears in both resolved and unresolved: ${unresolved.figmaNode}`);
    }
    if (unresolvedFigmaNodes.has(unresolved.figmaNode)) {
      reasons.push(`duplicate unresolved Figma node: ${unresolved.figmaNode}`);
    }
    unresolvedFigmaNodes.add(unresolved.figmaNode);
  }
  for (const detected of detectedComponents.values()) {
    if (!resolvedFigmaNodes.has(detected.nodeId) && !unresolvedFigmaNodes.has(detected.nodeId)) {
      reasons.push(
        `detected component lacks resolved/unresolved coverage: ${detected.nodeId} (${detected.name})`,
      );
    }
  }
  for (const composition of artifact.screenCompositions) {
    if (!implementationFiles.has(composition.filePath)) {
      reasons.push(
        `screen composition file must be listed in implementationFiles: ${composition.filePath}`,
      );
    }
    if (!fs.existsSync(composition.filePath)) {
      reasons.push(`screen composition file missing: ${composition.filePath}`);
    }
  }
  for (const entry of artifact.entryComponents ?? []) {
    if (!implementationFiles.has(entry.filePath)) {
      reasons.push(`entry component file must be listed in implementationFiles: ${entry.filePath}`);
    }
    if (!fs.existsSync(entry.filePath)) {
      reasons.push(`entry component file missing: ${entry.filePath}`);
    }
  }
  for (const asset of artifact.assets) {
    if (!fs.existsSync(asset.filePath)) reasons.push(`asset file missing: ${asset.filePath}`);
  }
  if (artifact.visualContracts.length === 0) {
    reasons.push("screen target requires at least one visualContract");
    return;
  }
  const contractIds = /* @__PURE__ */ new Set();
  const outDirs = /* @__PURE__ */ new Set();
  const primaryCountBySourceId = /* @__PURE__ */ new Map();
  for (const contract of artifact.visualContracts) {
    if (contractIds.has(contract.id)) {
      reasons.push(`duplicate visual contract id: ${contract.id}`);
    }
    contractIds.add(contract.id);
    if (outDirs.has(contract.outDir)) {
      reasons.push(`duplicate visual contract outDir: ${contract.outDir}`);
    }
    outDirs.add(contract.outDir);
    const expectedContractId =
      contract.scope === "page"
        ? `${contract.sourceId}.page`
        : `${contract.sourceId}.region.${contract.region}`;
    if (contract.id !== expectedContractId) {
      reasons.push(
        `visual contract id must be "${expectedContractId}" for its source/scope: ${contract.id}`,
      );
    }
    const expectedOutDirSuffix =
      contract.scope === "page"
        ? `${contract.sourceId}/page`
        : `${contract.sourceId}/regions/${contract.region}`;
    if (!path.posix.normalize(contract.outDir).endsWith(`/${expectedOutDirSuffix}`)) {
      reasons.push(
        `visual contract outDir must end with "${expectedOutDirSuffix}": ${contract.outDir}`,
      );
    }
    const requestedNodeId = requestedSources.get(contract.sourceId);
    if (!requestedNodeId) {
      reasons.push(
        `visual contract ${contract.id} references unknown sourceId: ${contract.sourceId}`,
      );
    } else if (requestedNodeId !== contract.sourceNodeId) {
      reasons.push(
        `visual contract ${contract.id} sourceNodeId ${contract.sourceNodeId} does not match source ${contract.sourceId} node ${requestedNodeId}`,
      );
    }
    if (contract.role === "primary") {
      primaryCountBySourceId.set(
        contract.sourceId,
        (primaryCountBySourceId.get(contract.sourceId) ?? 0) + 1,
      );
    }
    if (contract.role === "supplemental" && contract.scope !== "page") {
      reasons.push(`supplemental visual contract must use scope=page: ${contract.id}`);
    }
    if (contract.scope === "page" && contract.goldNodeId !== contract.sourceNodeId) {
      reasons.push(`page visual contract goldNodeId must equal sourceNodeId: ${contract.id}`);
    }
    if (
      contract.scope === "region" &&
      inventory &&
      !isInventoryDescendant(
        inventory,
        contract.sourceId,
        contract.goldNodeId,
        contract.sourceNodeId,
      )
    ) {
      reasons.push(
        `region visual contract goldNodeId must be a visible descendant of sourceNodeId: ${contract.id}`,
      );
    }
  }
  for (const sourceId of requestedSources.keys()) {
    const count = primaryCountBySourceId.get(sourceId) ?? 0;
    if (count !== 1) {
      reasons.push(
        `source ${sourceId} requires exactly one primary visualContract; found ${count}`,
      );
    }
  }
}
function main() {
  const args = parseArgs();
  if (!args.artifact) {
    fail([
      "internal usage: figma-gate-screen-components-internal.mjs --artifact <screen-implementation.json>",
    ]);
  }
  const artifactPath = path.resolve(args.artifact);
  const artifact = readArtifact(artifactPath);
  const reasons = [];
  let config;
  try {
    config = loadScreenConfig();
  } catch (error) {
    fail([error instanceof Error ? error.message : String(error)]);
  }
  let adapter;
  try {
    adapter = getFrameworkAdapter(config.framework);
  } catch (error) {
    fail([error instanceof Error ? error.message : String(error)]);
  }
  const frameworkName = adapter.id === "react" ? "React" : adapter.id;
  validateArtifactContract(artifact, adapter.isKnownPrimitive, reasons);
  if (artifact.unresolved.length > 0) {
    reasons.push(
      `unresolved node(s): ${artifact.unresolved.map((entry) => `${entry.figmaNode} (${entry.reason})`).join(", ")}`,
    );
  }
  for (const resolution of artifact.resolved) {
    if (!isDesignSystemResolution(resolution)) continue;
    const registryEntry = readRegistryEntry(resolution, reasons);
    if (!registryEntry) continue;
    const expected = expectedImportPath(registryEntry.component.filePath, config);
    if (normalizeImportPath(resolution.importPath, config) !== expected) {
      reasons.push(
        `importPath mismatch for ${resolution.codeComponent}; artifact=${resolution.importPath}, registry component=${expected}`,
      );
    }
  }
  const files = artifact.implementationFiles.filter((file) =>
    adapter.fileExtensions.includes(path.extname(file)),
  );
  const ownershipKey = (filePath, componentName) =>
    `${filePath.replace(/\\/g, "/")}#${componentName}`;
  const approvedCustom = new Set(
    artifact.screenCompositions.map((entry) => ownershipKey(entry.filePath, entry.componentName)),
  );
  const approvedEntries = new Set(
    (artifact.entryComponents ?? []).map((entry) =>
      ownershipKey(entry.filePath, entry.componentName),
    ),
  );
  const seenOwnedComponents = /* @__PURE__ */ new Set();
  const resolvedComponents = new Set(artifact.resolved.map((entry) => entry.codeComponent));
  const seenResolvedUsage = /* @__PURE__ */ new Set();
  const seenIgnoredReplacement = /* @__PURE__ */ new Set();
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const analysis = adapter.analyzeFile(file);
    const normalizedFile = file.replace(/\\/g, "/");
    for (const ignored of artifact.ignoredInventoryNodes ?? []) {
      if (ignored.classification !== "ui-icon" && ignored.classification !== "brand-icon") continue;
      const expectedSource = adapter.replacementImportSource(ignored.classification);
      for (const [localName, binding] of analysis.imports) {
        if (
          binding.source === expectedSource &&
          binding.imported === ignored.replacement.importName &&
          analysis.componentNames.has(localName)
        ) {
          seenIgnoredReplacement.add(ignored.nodeId);
        }
      }
    }
    for (const componentName of analysis.localRoots) {
      const key = ownershipKey(normalizedFile, componentName);
      if (approvedCustom.has(key) || approvedEntries.has(key)) {
        seenOwnedComponents.add(key);
        continue;
      }
      if (artifact.entryComponents) {
        reasons.push(
          `local ${frameworkName} component lacks entryComponents/screenCompositions ownership: ${componentName} in ${file}`,
        );
      } else if (
        (matchesScreensGlob(normalizedFile, config) ||
          (config.screensGlob === DEFAULT_SCREEN_CONFIG.screensGlob &&
            normalizedFile.includes("src/features/"))) &&
        normalizedFile.includes("/components/") &&
        !resolvedComponents.has(componentName)
      ) {
        reasons.push(`custom component not approved: ${componentName} in ${file}`);
      }
    }
    if (artifact.entryComponents) {
      for (const approved of [...approvedCustom, ...approvedEntries]) {
        if (approved.startsWith(`${normalizedFile}#`) && !seenOwnedComponents.has(approved)) {
          const componentName = approved.slice(approved.lastIndexOf("#") + 1);
          reasons.push(
            `declared ownership component not found as local ${frameworkName} component: ${componentName} in ${file}`,
          );
        }
      }
    }
    for (const resolution of artifact.resolved) {
      if (usesResolution(analysis, resolution, config)) {
        seenResolvedUsage.add(resolution.codeComponent);
        if (isDesignSystemResolution(resolution)) {
          checkRegistryUsage(file, analysis, resolution, adapter, config, reasons);
        }
      }
      if (!isDesignSystemResolution(resolution)) continue;
      const matchingRaw = analysis.rawPrimitiveUsages.filter((usage) =>
        adapter.isRawPrimitiveUsage(usage, resolution.codeComponent),
      );
      if (matchingRaw.length > 0) {
        reasons.push(
          `raw primitive markup in ${file}; ${matchingRaw.map(adapter.formatRawPrimitiveUsage).join(", ")}; resolved ${resolution.figmaNodes.join("/")} must use ${resolution.codeComponent} from ${resolution.importPath} (decision=${resolution.decision})`,
        );
      }
    }
  }
  for (const resolution of artifact.resolved) {
    if (!seenResolvedUsage.has(resolution.codeComponent)) {
      reasons.push(
        `resolved component not used in implementationFiles: ${resolution.codeComponent}`,
      );
    }
  }
  for (const ignored of artifact.ignoredInventoryNodes ?? []) {
    if (
      (ignored.classification === "ui-icon" || ignored.classification === "brand-icon") &&
      !seenIgnoredReplacement.has(ignored.nodeId)
    ) {
      reasons.push(
        `ignored ${ignored.classification} replacement not used in implementationFiles: ${ignored.nodeId}/${ignored.replacement.importName}`,
      );
    }
  }
  if (reasons.length > 0) {
    fail(reasons);
  }
  console.log("PASS");
  console.log(`artifact: ${path.relative(process.cwd(), artifactPath)}`);
  console.log(`name: ${artifact.name}`);
  console.log(`resolved: ${artifact.resolved.length}`);
  console.log(`implementation-files: ${artifact.implementationFiles.length}`);
  console.log(`${config.framework}-files-scanned: ${files.length}`);
  console.log(`visual-contracts: ${artifact.visualContracts.length}`);
  console.log(`adapter: ${adapter.id}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
export { layoutMapDuplicateIdentities };
