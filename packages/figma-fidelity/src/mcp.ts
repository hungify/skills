import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as fs from "node:fs";
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
  viewportContractSchema,
} from "./mcp-schemas.ts";

loadAncestorEnv();

const SERVER_NAME = "figma-fidelity";
const SERVER_VERSION = "0.2.0";
const DEBUG_TOOLS_ENV = "FIGMA_FIDELITY_DEBUG_TOOLS";

export interface FidelityMcpServerOptions {
  includeDebugTools?: boolean;
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function jsonError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof AppError ? err.code : "UNKNOWN";
  return {
    isError: true as const,
    content: [
      { type: "text" as const, text: JSON.stringify({ ok: false, error: code, message }, null, 2) },
    ],
  };
}

function debugToolsEnabled(): boolean {
  return process.env[DEBUG_TOOLS_ENV] === "1";
}

export function createFidelityMcpServer(options: FidelityMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const includeDebugTools = options.includeDebugTools ?? debugToolsEnabled();

  server.registerTool(
    "fidelity_fetch_gold",
    {
      description:
        "Fetch Figma gold PNG via Images API + write figma-gold.meta.json. Requires FIGMA_ACCESS_TOKEN in env.",
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
        const outPath = resolveArtifactPath(args.outPath);
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
    "fidelity_run",
    {
      description:
        "Fresh fidelity contract. Captures, compares, and scores a viewport against its Figma gold reference.",
      inputSchema: {
        url: z.string().describe("Rendered app URL"),
        viewport: viewportSchema,
        gold: goldRefSchema,
        outDir: z.string().min(1).describe("Absolute path to artifact directory"),
        scope: scopeSchema.optional(),
        options: runOptionsSchema.optional(),
      },
    },
    async (args) => {
      try {
        const outDir = resolveArtifactPath(args.outDir);
        const goldPath = resolveArtifactPath(args.gold.path);

        async function sendProgress(progress: number, message: string) {
          const meta = (args as Record<string, unknown>)._meta as
            | Record<string, unknown>
            | undefined;
          const progressToken = meta?.progressToken as string | undefined;
          if (!progressToken) return;
          try {
            await server.server.notification({
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
    "fidelity_batch_run",
    {
      description:
        "Run multiple fidelity contracts sequentially. Max 20 items to avoid browser memory issues.",
      inputSchema: {
        items: z
          .array(
            z.object({
              url: z.string(),
              viewport: viewportSchema,
              gold: goldRefSchema,
              outDir: z.string(),
              scope: scopeSchema.optional(),
              options: runOptionsSchema.optional(),
            }),
          )
          .min(1)
          .max(20),
      },
    },
    async (args) => {
      try {
        const results = [];
        for (const item of args.items) {
          const outDir = resolveArtifactPath(item.outDir);
          const goldPath = resolveArtifactPath(item.gold.path);
          const result = await run({
            url: item.url,
            viewport: item.viewport.name,
            viewportSize: { width: item.viewport.width, height: item.viewport.height },
            goldPath,
            outDir,
            nodeId: item.gold.nodeId,
            selector: item.scope?.selector,
            profile: item.options?.profile,
            runType: item.options?.runType,
            expectSize: item.scope?.expectSize,
            stabilitySamples: item.options?.stabilitySamples,
            hideDevtoolsChrome: item.options?.hideDevtoolsChrome,
          });
          results.push(result);
        }
        return jsonResult({ ok: true, count: results.length, results });
      } catch (err) {
        return jsonError(err);
      }
    },
  );

  server.registerTool(
    "fidelity_status",
    {
      description: "Server status and configuration information.",
      inputSchema: {},
    },
    async () => {
      return jsonResult({
        ok: true,
        tokenConfigured: !!process.env.FIGMA_ACCESS_TOKEN,
        serverVersion: SERVER_VERSION,
        profiles: ["page", "component/strict", "component/dev"],
        cwd: process.cwd(),
      });
    },
  );

  server.registerTool(
    "fidelity_prune",
    {
      description:
        "Remove stale artifact files (visual-score.json, actual.png, diff.png) older than N days from contract output directories.",
      inputSchema: {
        outDir: z.string().min(1).describe("Parent directory containing viewport artifact dirs"),
        olderThanDays: z.number().positive().default(14),
        dryRun: z
          .boolean()
          .optional()
          .describe("If true, list files without deleting"),
      },
    },
    async (args) => {
      try {
        const threshold = Date.now() - args.olderThanDays * 24 * 60 * 60 * 1000;
        const pruned: string[] = [];
        const outDir = resolveArtifactPath(args.outDir);
        const entries = fs.readdirSync(outDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          for (const name of ["visual-score.json", "actual.png", "diff.png"]) {
            const filePath = path.join(outDir, entry.name, name);
            try {
              const stat = fs.statSync(filePath);
              if (stat.mtimeMs < threshold) {
                pruned.push(filePath);
                if (!args.dryRun) fs.unlinkSync(filePath);
              }
            } catch {
              /* file doesn't exist */
            }
          }
        }
        return jsonResult({
          ok: true,
          pruned,
          dryRun: args.dryRun ?? false,
          olderThanDays: args.olderThanDays,
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  );

  server.registerTool(
    "fidelity_done_gate",
    {
      description:
        "Artifact completion gate. Every viewport declares exact contract; checks score, gold, and artifact freshness.",
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
            cwd: args.cwd,
          }),
        );
      } catch (err) {
        return jsonError(err);
      }
    },
  );

  // MCP Resources
  server.resource(
    "gold",
    new ResourceTemplate("figma-fidelity://gold/{viewport}", { list: undefined }),
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          text: `Gold reference image for viewport "${variables.viewport}". Use fidelity_fetch_gold to fetch, then fidelity_run to compare against it.`,
        },
      ],
    }),
  );

  server.resource(
    "diff",
    new ResourceTemplate("figma-fidelity://diff/{viewport}", { list: undefined }),
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          text: `Diff image for viewport "${variables.viewport}". Generated by fidelity_run after comparing the captured screenshot to the gold reference.`,
        },
      ],
    }),
  );

  server.resource(
    "score",
    new ResourceTemplate("figma-fidelity://score/{viewport}", { list: undefined }),
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          text: `Visual score for viewport "${variables.viewport}". Run fidelity_done_gate to verify all contract requirements are met.`,
        },
      ],
    }),
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createFidelityMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function startMcpServerHttp(port = 3100): Promise<void> {
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
    httpServer.listen(port, () => {
      console.error(`MCP HTTP server listening on http://localhost:${port}/`);
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
