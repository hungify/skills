import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as z from "zod/v4";

import { capture } from "./capture.ts";
import { compare } from "./compare/index.ts";
import { checkDoneGate } from "./done-gate.ts";
import { fetchGold } from "./fetch-gold.ts";
import { clearNodeMetaCache } from "./figma-api.ts";
import { loadAncestorEnv } from "./load-env.ts";
import { resolveArtifactPath } from "./paths.ts";
import { run } from "./run.ts";
import { AppError } from "./types.ts";
import {
  profileSchema,
  runTypeSchema,
  viewportSchema,
  expectSizeSchema,
  goldRefSchema,
  scopeSchema,
  runOptionsSchema,
  verificationContractSchema,
  viewportContractSchema,
} from "./mcp-schemas.ts";

loadAncestorEnv();

const SERVER_NAME = "figma-fidelity";
const SERVER_VERSION = "0.2.0";
const DEBUG_TOOLS_ENV = "FIGMA_FIDELITY_DEBUG_TOOLS";
const PROJECT_ROOT_ENV = "FIGMA_FIDELITY_PROJECT_ROOT";

export interface FidelityMcpServerOptions {
  includeDebugTools?: boolean;
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function jsonError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof AppError ? err.code : "UNKNOWN";
  const payload = { ok: false, error: code, message };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function debugToolsEnabled(): boolean {
  return process.env[DEBUG_TOOLS_ENV] === "1";
}

function resolveProjectRoot(projectRoot?: string): string {
  return path.resolve(projectRoot ?? process.env[PROJECT_ROOT_ENV] ?? process.cwd());
}

function resolveToolPath(input: string, projectRoot?: string): string {
  return resolveArtifactPath(input, resolveProjectRoot(projectRoot));
}

function toolAnnotations(options: {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
}) {
  return {
    readOnlyHint: options.readOnly ?? false,
    destructiveHint: options.destructive ?? false,
    idempotentHint: options.idempotent ?? false,
    openWorldHint: options.openWorld ?? false,
  };
}

export function createFidelityMcpServer(options: FidelityMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const includeDebugTools = options.includeDebugTools ?? debugToolsEnabled();

  if (includeDebugTools) server.registerTool(
    "fidelity_fetch_gold",
    {
      description:
        "Fetch Figma gold PNG via Images API + write figma-gold.meta.json. Requires FIGMA_ACCESS_TOKEN in env.",
      annotations: toolAnnotations({ destructive: true, openWorld: true }),
      inputSchema: {
        fileKey: z.string().min(1).describe("Figma file key"),
        nodeId: z.string().min(1).describe('Figma node id, e.g. "153:5181"'),
        outPath: z.string().min(1).describe("Output path for figma-gold.png (absolute)"),
        scale: z.number().positive().optional().describe("Render scale (default 1)"),
        canvasFill: z
          .string()
          .optional()
          .describe("Solid hex (#fff/#ffffff) to composite onto before write"),
      },
    },
    async (args) => {
      try {
        const outPath = resolveToolPath(args.outPath);
        return jsonResult(
          await fetchGold({
            fileKey: args.fileKey,
            nodeId: args.nodeId,
            outPath,
            scale: args.scale,
            canvasFill: args.canvasFill,
          }),
        );
      } catch (err) {
        return jsonError(err);
      }
    },
  );

  if (includeDebugTools) {
    server.registerTool(
      "fidelity_cache_clear",
      {
        description: "Clear Figma API response cache (spec gate, staleness).",
        annotations: toolAnnotations({ idempotent: true }),
        inputSchema: {},
      },
      async () => {
        clearNodeMetaCache();
        return jsonResult({ ok: true, message: "Cache cleared." });
      },
    );

    server.registerTool(
      "fidelity_capture",
      {
        description: "Debug-only hardened Playwright capture. Prefer fidelity_run for verification.",
        annotations: toolAnnotations({ destructive: true, openWorld: true }),
        inputSchema: {
          url: z.string().describe("Rendered app URL"),
          outPath: z.string().min(1).describe("Output actual.png path (absolute)"),
          viewportWidth: z.number().int().positive(),
          viewportHeight: z.number().int().positive(),
          selector: z
            .string()
            .optional()
            .describe("CSS selector — must resolve to exactly 1 element"),
          samples: z.number().int().positive().optional(),
        },
      },
      async (args) => {
        try {
          const outPath = resolveArtifactPath(args.outPath);
          return jsonResult(
            await capture({
              url: args.url,
              outPath,
              viewportSize: { width: args.viewportWidth, height: args.viewportHeight },
              selector: args.selector,
              samples: args.samples,
            }),
          );
        } catch (err) {
          return jsonError(err);
        }
      },
    );

    server.registerTool(
      "fidelity_compare",
      {
        description: "Debug-only compare of existing gold and actual PNGs. Does not capture.",
        annotations: toolAnnotations({ destructive: true }),
        inputSchema: {
          goldPath: z.string().min(1).describe("Absolute path to figma-gold.png"),
          actualPath: z.string().min(1).describe("Absolute path to actual.png"),
          outDir: z.string().min(1).describe("Artifact directory (absolute)"),
          profile: profileSchema.optional().describe("Default component/strict"),
          expectSize: expectSizeSchema.optional(),
        },
      },
      async (args) => {
        try {
          const goldPath = resolveArtifactPath(args.goldPath);
          const actualPath = resolveArtifactPath(args.actualPath);
          const outDir = resolveArtifactPath(args.outDir);
          return jsonResult(
            compare(goldPath, actualPath, outDir, {
              profile: args.profile ?? "component/strict",
              expectSize: args.expectSize,
            }),
          );
        } catch (err) {
          return jsonError(err);
        }
      },
    );
  }

  server.registerTool(
    "fidelity_verify",
    {
      title: "Verify Figma fidelity",
      description:
        "Preferred agent workflow. For 1-8 exact visual contracts, fetch fresh Figma gold, capture stable final UI, compare, and write hash-bound evidence. Returns every contract result, including partial failures.",
      annotations: toolAnnotations({ destructive: true, openWorld: true }),
      inputSchema: {
        projectRoot: z
          .string()
          .optional()
          .describe("Project root for relative outDir paths; defaults to FIGMA_FIDELITY_PROJECT_ROOT or server cwd"),
        url: z.string().url().describe("Rendered app URL shared by contracts"),
        contracts: z.array(verificationContractSchema).min(1).max(8),
      },
    },
    async (args, extra) => {
      const results: Array<Record<string, unknown>> = [];
      const projectRoot = resolveProjectRoot(args.projectRoot);
      const progressToken = extra._meta?.progressToken;
      for (let index = 0; index < args.contracts.length; index += 1) {
        if (extra.signal.aborted) {
          results.push({ ok: false, error: "CANCELLED", message: "Request cancelled." });
          break;
        }
        const contract = args.contracts[index]!;
        const outDir = resolveToolPath(contract.outDir, projectRoot);
        const goldPath = path.join(outDir, "figma-gold.png");
        try {
          if (progressToken != null) {
            await extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: index,
                total: args.contracts.length,
                message: `${contract.id}:fetch_gold`,
              },
            });
          }
          const gold = await fetchGold({
            fileKey: contract.fileKey,
            nodeId: contract.nodeId,
            outPath: goldPath,
            scale: contract.scale,
            canvasFill: contract.canvasFill,
          });
          if (!gold.fetched) {
            results.push({
              id: contract.id,
              ok: false,
              error: "GOLD_FETCH_FAILED",
              message: gold.message,
              gold,
            });
            continue;
          }
          const selector =
            contract.scope.kind === "region" ? contract.scope.selector : undefined;
          const pageReason =
            contract.scope.kind === "page" ? contract.scope.pageReason : undefined;
          const expectSize =
            contract.scope.kind === "region" ? contract.scope.expectSize : undefined;
          const result = await run({
            url: args.url,
            viewport: contract.viewport.name,
            viewportSize: {
              width: contract.viewport.width,
              height: contract.viewport.height,
            },
            goldPath,
            outDir,
            nodeId: contract.nodeId,
            selector,
            profile:
              contract.scope.kind === "region"
                ? (contract.profile ?? "component/strict")
                : "page",
            pageReason,
            runType: "final",
            expectSize,
            stabilitySamples: contract.stabilitySamples ?? 3,
            timeoutMs: contract.timeoutMs,
            hideDevtoolsChrome: contract.hideDevtoolsChrome,
          });
          results.push({ id: contract.id, ok: result.ok, gold, result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({ id: contract.id, ok: false, error: "VERIFY_FAILED", message });
        }
      }
      if (progressToken != null) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: results.length,
            total: args.contracts.length,
            message: extra.signal.aborted ? "cancelled" : "complete",
          },
        });
      }
      const allPassed = results.every(
        (entry) => entry.ok === true && (entry.result as { pass?: boolean } | undefined)?.pass === true,
      );
      return jsonResult({
        ok: results.every((entry) => entry.ok === true),
        allPassed,
        projectRoot,
        count: results.length,
        results,
      });
    },
  );

  if (includeDebugTools) server.registerTool(
    "fidelity_run",
    {
      description:
        "Fresh fidelity contract. Captures, compares, and scores a viewport against its Figma gold reference.",
      annotations: toolAnnotations({ destructive: true, openWorld: true }),
      inputSchema: {
        url: z.string().describe("Rendered app URL"),
        viewport: viewportSchema,
        gold: goldRefSchema,
        outDir: z.string().min(1).describe("Absolute path to artifact directory"),
        scope: scopeSchema.optional(),
        options: runOptionsSchema.optional(),
      },
    },
    async (args, extra) => {
      try {
        const outDir = resolveArtifactPath(args.outDir);
        const goldPath = resolveArtifactPath(args.gold.path);

        async function sendProgress(progress: number, message: string) {
          const progressToken = extra._meta?.progressToken;
          if (progressToken == null) return;
          try {
            await extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress, message },
            });
          } catch {
            /* client may not support progress */
          }
        }

        await sendProgress(0.1, "browser_launch");

        const result = await run({
          url: args.url,
          viewport: args.viewport.name,
          viewportSize: { width: args.viewport.width, height: args.viewport.height },
          goldPath,
          outDir,
          nodeId: args.gold.nodeId,
          selector: args.scope?.selector,
          profile: args.options?.profile,
          runType: args.options?.runType,
          expectSize: args.scope?.expectSize,
          stabilitySamples: args.options?.stabilitySamples,
          hideDevtoolsChrome: args.options?.hideDevtoolsChrome,
        });

        await sendProgress(1.0, "artifacts_written");

        return jsonResult(result);
      } catch (err) {
        return jsonError(err);
      }
    },
  );

  server.registerTool(
    "fidelity_status",
    {
      description: "Server status and configuration information.",
      annotations: toolAnnotations({ readOnly: true, idempotent: true }),
      inputSchema: {},
    },
    async () => {
      return jsonResult({
        ok: true,
        tokenConfigured: !!process.env.FIGMA_ACCESS_TOKEN,
        serverVersion: SERVER_VERSION,
        profiles: ["page", "component/strict", "component/dev"],
        cwd: process.cwd(),
        projectRoot: resolveProjectRoot(),
      });
    },
  );

  server.registerTool(
    "fidelity_done_gate",
    {
      description:
        "Artifact completion gate. Every viewport declares exact contract; checks score, gold, and artifact freshness.",
      annotations: toolAnnotations({ readOnly: true, idempotent: true }),
      inputSchema: {
        viewports: z.array(viewportContractSchema).min(1).max(50),
        maxScoreAgeMs: z.number().positive().optional(),
        maxGoldAgeMs: z.number().positive().optional(),
        cwd: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return jsonResult(
          checkDoneGate({
            viewports: args.viewports,
            maxScoreAgeMs: args.maxScoreAgeMs,
            maxGoldAgeMs: args.maxGoldAgeMs,
            cwd: args.cwd,
          }),
        );
      } catch (err) {
        return jsonError(err);
      }
    },
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createFidelityMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function startMcpServerHttp(
  port = 3100,
  host = "127.0.0.1",
): Promise<void> {
  const server = createFidelityMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("MCP HTTP request error:", err);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal Server Error");
      }
    }
  });

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      console.error(`MCP HTTP server listening on http://${host}:${port}/`);
      resolve();
    });
  });
}

const isMain =
  process.argv[1] != null &&
  (process.argv[1].endsWith("/mcp.ts") || process.argv[1].endsWith("/mcp.js"));

if (isMain) {
  startMcpServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
