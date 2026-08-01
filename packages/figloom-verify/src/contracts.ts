import * as z from "zod/v4";

const FIGMA_NODE_ID = /^(?:I\d+:\d+(?:;\d+:\d+)+|\d+:\d+)$/;
const VISUAL_ARTIFACT_DIR = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))\.figma\/artifacts\/visual-verifications\/.+/;

export const profileSchema = z.enum(["page", "component/strict", "component/dev"]);

export const runTypeSchema = z.enum(["dev", "final"]);

export const viewportSchema = z
  .object({
    name: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

export const expectSizeSchema = z
  .object({
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict();

const pageScopeSchema = z
  .object({
    kind: z.literal("page"),
    pageReason: z.string().trim().min(1),
  })
  .strict();

const regionScopeSchema = z
  .object({
    kind: z.literal("region"),
    selector: z.string().trim().min(1),
    expectSize: expectSizeSchema,
  })
  .strict();

export const verificationContractSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
    fileKey: z.string().min(1),
    nodeId: z.string().regex(FIGMA_NODE_ID),
    viewport: viewportSchema,
    outDir: z.string().regex(VISUAL_ARTIFACT_DIR),
    scope: z.discriminatedUnion("kind", [pageScopeSchema, regionScopeSchema]),
    profile: z.enum(["component/strict", "component/dev"]).optional(),
    scale: z.number().positive().optional(),
    canvasFill: z.string().regex(/^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/).optional(),
    stabilitySamples: z.number().int().min(2).max(5).optional(),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
    hideDevtoolsChrome: z.boolean().optional(),
  })
  .strict()
  .superRefine((contract, context) => {
    if (contract.scope.kind === "page" && contract.profile != null) {
      context.addIssue({
        code: "custom",
        path: ["profile"],
        message: "page contract must not set component profile",
      });
    }
  });

export const verificationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    url: z.string().url(),
    contracts: z.array(verificationContractSchema).min(1).max(8),
  })
  .strict()
  .superRefine((request, context) => {
    const ids = new Set<string>();
    request.contracts.forEach((contract, index) => {
      if (ids.has(contract.id)) {
        context.addIssue({
          code: "custom",
          path: ["contracts", index, "id"],
          message: `duplicate contract id: ${contract.id}`,
        });
      }
      ids.add(contract.id);
    });
  });

const verificationResultSchema = z
  .object({
    id: z.string().min(1),
    ok: z.boolean(),
    pass: z.boolean(),
    error: z.string().optional(),
    message: z.string().optional(),
    outDir: z.string().min(1),
  })
  .strict();

export const verificationArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("figloom.visual-verification"),
    createdAt: z.string().datetime(),
    projectRoot: z.string().min(1),
    request: verificationRequestSchema,
    ok: z.boolean(),
    allPassed: z.boolean(),
    results: z.array(verificationResultSchema).min(1).max(8),
  })
  .strict()
  .superRefine((artifact, context) => {
    const requestIds = new Set(artifact.request.contracts.map((contract) => contract.id));
    const resultIds = new Set<string>();
    artifact.results.forEach((result, index) => {
      if (!requestIds.has(result.id)) {
        context.addIssue({
          code: "custom",
          path: ["results", index, "id"],
          message: `result has no matching contract: ${result.id}`,
        });
      }
      if (resultIds.has(result.id)) {
        context.addIssue({
          code: "custom",
          path: ["results", index, "id"],
          message: `duplicate result id: ${result.id}`,
        });
      }
      resultIds.add(result.id);
    });
    if (resultIds.size !== requestIds.size) {
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "results must cover every request contract exactly once",
      });
    }
    const expectedOk = artifact.results.every((result) => result.ok);
    const expectedAllPassed = artifact.results.every((result) => result.ok && result.pass);
    if (artifact.ok !== expectedOk) {
      context.addIssue({
        code: "custom",
        path: ["ok"],
        message: "ok must equal the aggregate result status",
      });
    }
    if (artifact.allPassed !== expectedAllPassed) {
      context.addIssue({
        code: "custom",
        path: ["allPassed"],
        message: "allPassed must equal the aggregate visual verdict",
      });
    }
  });

export type VerificationContract = z.infer<typeof verificationContractSchema>;
export type VerificationRequest = z.infer<typeof verificationRequestSchema>;
export type VerificationArtifact = z.infer<typeof verificationArtifactSchema>;
