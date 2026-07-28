#!/usr/bin/env node
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
const SOURCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NODE_ID = /^\d+:\d+$/;
function fail(message) {
  console.error(`FAIL
- ${message}`);
  process.exit(1);
}
function parseArgs() {
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  const parsed = { sources: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--file-key" && value) parsed.fileKey = argv[++index];
    else if (arg === "--out" && value) parsed.out = argv[++index];
    else if (arg === "--input-response" && value) parsed.inputResponse = argv[++index];
    else if (arg === "--source" && value) {
      index += 1;
      const separator = value.indexOf("=");
      if (separator <= 0) fail(`invalid --source "${value}"; expected source-id=1:2`);
      parsed.sources.push({
        id: value.slice(0, separator),
        nodeId: value.slice(separator + 1).replace(/-/g, ":"),
      });
    } else fail(`unknown or incomplete argument: ${arg}`);
  }
  if (!parsed.fileKey || !parsed.out || parsed.sources.length === 0) {
    fail("usage: figma-inventory --file-key <key> --source <id=1:2>... --out <path>");
  }
  for (const source of parsed.sources) {
    if (!SOURCE_ID.test(source.id)) fail(`invalid source id: ${source.id}`);
    if (!NODE_ID.test(source.nodeId)) fail(`invalid source nodeId: ${source.nodeId}`);
  }
  if (new Set(parsed.sources.map((source) => source.id)).size !== parsed.sources.length) {
    fail("duplicate source id");
  }
  if (new Set(parsed.sources.map((source) => source.nodeId)).size !== parsed.sources.length) {
    fail("duplicate source nodeId");
  }
  return parsed;
}
function loadEnvValue(key) {
  if (process.env[key]) return process.env[key];
  for (const file of [".env.local", ".env"]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0 || trimmed.slice(0, separator).trim() !== key) continue;
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value;
    }
  }
  return void 0;
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
async function fetchResponse(args) {
  if (args.inputResponse) {
    return JSON.parse(fs.readFileSync(args.inputResponse, "utf-8"));
  }
  const token = loadEnvValue("FIGMA_ACCESS_TOKEN");
  if (!token) fail("FIGMA_ACCESS_TOKEN missing from environment/.env.local/.env");
  const params = new URLSearchParams({
    ids: args.sources.map((source) => source.nodeId).join(","),
  });
  const response = await fetch(
    `https://api.figma.com/v1/files/${encodeURIComponent(args.fileKey)}/nodes?${params}`,
    { headers: { "X-Figma-Token": token } },
  );
  if (!response.ok) fail(`Figma REST returned HTTP ${response.status}`);
  return await response.json();
}
function collectVisibleInstances(node, sourceId, components, items, nodeTree, parentNodeId = null) {
  if (node.visible === false) return;
  const currentNodeId = node.id ?? parentNodeId;
  if (node.id) {
    nodeTree.push({
      sourceId,
      nodeId: node.id,
      parentNodeId,
      name: node.name ?? "Unnamed",
      nodeType: node.type ?? "UNKNOWN",
      bounds: node.absoluteBoundingBox ?? null,
    });
  }
  if (
    node.id &&
    node.name &&
    (node.type === "INSTANCE" || node.type === "COMPONENT" || node.type === "COMPONENT_SET")
  ) {
    const componentId = node.componentId ?? null;
    items.push({
      sourceId,
      nodeId: node.id,
      name: node.name,
      nodeType: node.type,
      componentId,
      componentName: componentId ? (components.get(componentId)?.name ?? null) : null,
    });
  }
  for (const child of node.children ?? []) {
    collectVisibleInstances(child, sourceId, components, items, nodeTree, currentNodeId);
  }
}
async function main() {
  const args = parseArgs();
  const response = await fetchResponse(args);
  const items = [];
  const nodeTree = [];
  const seen = /* @__PURE__ */ new Map();
  for (const source of args.sources) {
    const entry = response.nodes?.[source.nodeId];
    if (!entry?.document) fail(`Figma response missing source node ${source.id}=${source.nodeId}`);
    const components = new Map(Object.entries(entry.components ?? {}));
    const sourceItems = [];
    collectVisibleInstances(entry.document, source.id, components, sourceItems, nodeTree);
    for (const item of sourceItems) {
      const previousSource = seen.get(item.nodeId);
      if (previousSource && previousSource !== source.id) {
        fail(
          `overlapping source nodes contain component ${item.nodeId}; sources ${previousSource}/${source.id}`,
        );
      }
      seen.set(item.nodeId, source.id);
      items.push(item);
    }
  }
  items.sort((a, b) =>
    `${a.sourceId}:${a.nodeId}:${a.name}`.localeCompare(`${b.sourceId}:${b.nodeId}:${b.name}`),
  );
  nodeTree.sort((a, b) => `${a.sourceId}:${a.nodeId}`.localeCompare(`${b.sourceId}:${b.nodeId}`));
  const payload = {
    schemaVersion: 2,
    generator: "figma-inventory-fetch@2",
    fileKey: args.fileKey,
    sourceNodes: [...args.sources].sort((a, b) => a.id.localeCompare(b.id)),
    version: response.version ?? null,
    lastModified: response.lastModified ?? null,
    visibleOnly: true,
    nodeTree,
    items,
  };
  const inventory = { ...payload, contentHash: contentHash(payload) };
  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    `${JSON.stringify(inventory, null, 2)}
`,
  );
  console.log("PASS");
  console.log(`inventory: ${path.relative(process.cwd(), outPath)}`);
  console.log(`items: ${items.length}`);
  console.log(`content-hash: ${inventory.contentHash}`);
}
main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
