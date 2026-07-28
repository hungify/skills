const FRAMEWORK_TO_EXTRACTOR = {
  react: './react-typescript.mjs',
  vue: './vue.mjs',
};

async function loadExtractor(framework) {
  const file = FRAMEWORK_TO_EXTRACTOR[framework];
  if (!file) throw new Error(`Unknown framework "${framework}"`);
  const mod = await import(new URL(file, import.meta.url).href);
  if (typeof mod.extractComponents !== 'function') {
    throw new Error(`${file} must export extractComponents(absPath)`);
  }
  if (!Array.isArray(mod.fileExtensions) || mod.fileExtensions.length === 0) {
    throw new Error(`${file} must export non-empty fileExtensions`);
  }
  return mod;
}

export { loadExtractor, FRAMEWORK_TO_EXTRACTOR };
