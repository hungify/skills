import { fetchFileNodes } from '../infra/figma-client.mjs';
import { writeJsonAtomic, ensureDir } from '../infra/fs-atomic.mjs';
import { collectComponents, looksLikeVariantMemberName } from '../domain/figma-collect.mjs';
import {
  cachePaths,
  isolatedCacheDir,
  getFigmaToken,
  nowIso,
} from '../paths.mjs';

async function cmdFetch(args) {
  const token = getFigmaToken();
  if (!token) {
    console.error('❌ Missing FIGMA_ACCESS_TOKEN in .env');
    process.exit(1);
  }
  if (!args['file-key'] || !args['node-ids']) {
    console.error('❌ Need --file-key and --node-ids');
    process.exit(1);
  }

  const paths = cachePaths(isolatedCacheDir(args, 'fetch'));
  const nodeIds = String(args['node-ids'])
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const data = await fetchFileNodes({
    token,
    fileKey: args['file-key'],
    nodeIds,
  });

  const components = [];
  for (const entry of Object.values(data.nodes || {})) {
    if (entry && entry.document) {
      collectComponents(entry.document, components);
    }
  }

  if (components.length === 0) {
    console.warn('⚠️  No COMPONENT/COMPONENT_SET found in given node(s)');
  }

  ensureDir(paths.cacheDir);
  writeJsonAtomic(paths.raw, {
    fileKey: args['file-key'],
    fetchedAt: nowIso(),
    components,
  });

  const verbose = args.verbose === true || args.verbose === 'true';

  console.log(`✅ Fetch ${components.length} → ${paths.raw}`);
  let variantWarnings = 0;
  let staticCount = 0;
  for (const c of components) {
    const propCount = Object.keys(c.propertyDefinitions).length;
    let suffix = '';

    if (propCount === 0 && c.type === 'COMPONENT' && looksLikeVariantMemberName(c.name)) {
      suffix =
        ' ⚠️  name looks like a variant member (Prop=Value, ...) — fetch its COMPONENT_SET parent instead, do not mark structural';
      variantWarnings++;
    } else if (propCount === 0) {
      suffix = ' (static — use mappingKind: static)';
      staticCount++;
    }
    console.log(`   - ${c.name} (${c.figmaNodeId}) ${propCount} props${suffix}`);
  }

  if (verbose) {
    console.error(
      `   [verbose] requested node-ids: ${nodeIds.length}, components collected: ${components.length}, variant-member warnings: ${variantWarnings}, static (0-prop) components: ${staticCount}`,
    );
  }
}
export { cmdFetch };
