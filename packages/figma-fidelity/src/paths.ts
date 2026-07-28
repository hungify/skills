import * as path from "node:path";

export function resolveArtifactPath(input: string, cwd?: string): string {
  if (!input) return input;
  if (path.isAbsolute(input)) return path.normalize(input);
  if (cwd) return path.resolve(cwd, input);
  throw new Error(`Use absolute paths for MCP tools: ${input}`);
}
