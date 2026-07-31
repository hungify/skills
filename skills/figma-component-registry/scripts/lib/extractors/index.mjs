import * as reactTypescript from './react-typescript.mjs';
import * as vue from './vue.mjs';

const FRAMEWORK_TO_EXTRACTOR = {
  react: reactTypescript,
  vue,
};

async function loadExtractor(framework) {
  const mod = FRAMEWORK_TO_EXTRACTOR[framework];
  if (!mod) throw new Error(`Unknown framework "${framework}"`);
  if (typeof mod.extractComponents !== 'function') {
    throw new Error(`${framework} extractor must export extractComponents(absPath)`);
  }
  if (!Array.isArray(mod.fileExtensions) || mod.fileExtensions.length === 0) {
    throw new Error(`${framework} extractor must export non-empty fileExtensions`);
  }
  return mod;
}

export { loadExtractor, FRAMEWORK_TO_EXTRACTOR };
