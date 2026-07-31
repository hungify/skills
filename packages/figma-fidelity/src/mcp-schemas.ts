import * as z from "zod/v4";

export const profileSchema = z.enum(["page", "component/strict", "component/dev"]);

export const runTypeSchema = z.enum(["dev", "final"]);

export const viewportSchema = z.object({
  name: z.string().min(1).describe("Viewport name, e.g. 'desktop' | 'mobile'"),
  width: z.number().int().positive().describe("Viewport width in CSS pixels"),
  height: z.number().int().positive().describe("Viewport height in CSS pixels"),
});

export const expectSizeSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
});

export const goldRefSchema = z.object({
  path: z.string().min(1).describe("Absolute path to figma-gold.png"),
  fileKey: z.string().min(1),
  nodeId: z.string().min(1).describe("Figma node ID, e.g. '153:5181'"),
});

export const scopeSchema = z.object({
  selector: z.string().optional().describe("CSS selector matching exactly 1 element"),
  expectSize: expectSizeSchema.optional(),
});

export const runOptionsSchema = z.object({
  profile: profileSchema.optional().describe("Default: component/strict"),
  runType: runTypeSchema.optional(),
  stabilitySamples: z.number().int().positive().optional(),
  hideDevtoolsChrome: z.boolean().optional(),
});

const pageScopeSchema = z
  .object({
    kind: z.literal("page"),
    pageReason: z.string().min(1),
  })
  .strict();

const regionScopeSchema = z
  .object({
    kind: z.literal("region"),
    selector: z.string().min(1),
    expectSize: expectSizeSchema,
  })
  .strict();

export const verificationContractSchema = z
  .object({
    id: z.string().min(1),
    fileKey: z.string().min(1),
    nodeId: z.string().min(1),
    viewport: viewportSchema,
    outDir: z.string().min(1).describe("Project-relative or absolute artifact directory"),
    scope: z.discriminatedUnion("kind", [pageScopeSchema, regionScopeSchema]),
    profile: z.enum(["component/strict", "component/dev"]).optional(),
    scale: z.number().positive().optional(),
    canvasFill: z.string().regex(/^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/).optional(),
    stabilitySamples: z.number().int().min(2).max(5).optional(),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
    hideDevtoolsChrome: z.boolean().optional(),
  })
  .strict();

export const viewportContractSchema = z
  .object({
    viewport: z.string().min(1),
    outDir: z.string().min(1).describe("Absolute path to artifact directory"),
    fileKey: z.string().min(1),
    nodeId: z.string().min(1),
    profile: profileSchema,
    selector: z.string().optional(),
    expectSize: expectSizeSchema.optional(),
    pageReason: z.string().optional(),
  })
  .strict();
