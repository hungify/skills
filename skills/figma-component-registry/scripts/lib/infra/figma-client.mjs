function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchFileNodes({
  token,
  fileKey,
  nodeIds,
  fetchImpl = globalThis.fetch,
  chunkSize = 50,
  maxRetries = 3,
  retryDelayMs = 200,
}) {
  if (!token) throw new Error('Missing FIGMA_ACCESS_TOKEN');
  const merged = { nodes: {} };
  for (const part of chunk(nodeIds, chunkSize)) {
    const url = `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${part
      .map(encodeURIComponent)
      .join(',')}`;
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetchImpl(url, { headers: { 'X-Figma-Token': token } });
      if (res.ok) {
        const data = await res.json();
        Object.assign(merged.nodes, data.nodes || {});
        lastErr = null;
        break;
      }
      lastErr = new Error(`Figma REST ${res.status}: ${res.statusText}`);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === maxRetries) throw lastErr;
      await sleep(retryDelayMs * 2 ** attempt);
    }
    if (lastErr) throw lastErr;
  }
  return merged;
}
export { fetchFileNodes, chunk };
