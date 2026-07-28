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
  hideSelectors: z
    .array(z.string())
    .optional()
    .describe("CSS selectors to hide before capture"),
});

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
