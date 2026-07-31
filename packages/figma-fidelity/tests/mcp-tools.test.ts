import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createFidelityMcpServer } from "../src/mcp.ts";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function listTools(includeDebugTools: boolean) {
  const server = createFidelityMcpServer({ includeDebugTools });
  const client = new Client({ name: "figma-fidelity-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });

  return (await client.listTools()).tools;
}

async function listToolNames(includeDebugTools: boolean): Promise<string[]> {
  return (await listTools(includeDebugTools)).map((tool) => tool.name).sort();
}

describe("MCP tool disclosure", () => {
  it("exposes only primary workflow tools by default", async () => {
    await expect(listToolNames(false)).resolves.toEqual([
      "fidelity_done_gate",
      "fidelity_status",
      "fidelity_verify",
    ]);
  });

  it("adds low-level capture, compare, and cache tools only in debug mode", async () => {
    await expect(listToolNames(true)).resolves.toEqual([
      "fidelity_cache_clear",
      "fidelity_capture",
      "fidelity_compare",
      "fidelity_done_gate",
      "fidelity_fetch_gold",
      "fidelity_run",
      "fidelity_status",
      "fidelity_verify",
    ]);
  });

  it("describes agent-facing risk and bounded batch contract", async () => {
    const tools = await listTools(false);
    const verify = tools.find((tool) => tool.name === "fidelity_verify");
    const done = tools.find((tool) => tool.name === "fidelity_done_gate");
    expect(verify?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(done?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(
      (verify?.inputSchema.properties?.contracts as { maxItems?: number } | undefined)?.maxItems,
    ).toBe(8);
  });
});
