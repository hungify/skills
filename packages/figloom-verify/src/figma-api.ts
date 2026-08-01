/**
 * Minimal Figma REST metadata access shared by staleness + spec-gate.
 * Token is header-only, never logged/persisted (see "Token handling").
 */
export interface NodeMetadata {
  lastModified: string | null;
  absoluteBoundingBox: { width: number; height: number } | null;
}

type NodeMetaOutcome = NodeMetadata | { error: string };

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const NODE_META_CACHE = new Map<string, CacheEntry<NodeMetaOutcome>>();
const CACHE_TTL_MS = 60_000;

export function clearNodeMetaCache(): void {
  NODE_META_CACHE.clear();
}

function cacheKey(fileKey: string, nodeId: string): string {
  return `${fileKey}:${nodeId}`;
}

export async function getNodeMetadata(
  fileKey: string,
  nodeId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NodeMetaOutcome> {
  const key = cacheKey(fileKey, nodeId);
  const cached = NODE_META_CACHE.get(key);
  if (fetchImpl === fetch && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const res = await fetchImpl(
      `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}&depth=1`,
      { headers: { "X-Figma-Token": token } },
    );
    if (!res.ok) {
      return { error: `Figma metadata call returned HTTP ${res.status}.` };
    }
    const json = (await res.json()) as {
      lastModified?: string;
      nodes?: Record<
        string,
        { document?: { absoluteBoundingBox?: { width: number; height: number } } } | null
      >;
    };
    const node = json.nodes?.[nodeId];
    if (!node) {
      return { error: `Figma metadata call returned no node for "${nodeId}".` };
    }
    const result: NodeMetaOutcome = {
      lastModified: json.lastModified ?? null,
      absoluteBoundingBox: node.document?.absoluteBoundingBox ?? null,
    };
    if (fetchImpl === fetch) {
      NODE_META_CACHE.set(key, { data: result, fetchedAt: Date.now() });
    }
    return result;
  } catch {
    return { error: "network error during Figma metadata call." };
  }
}
