import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRegistryEntry } from '../lib/validate/shape.mjs';
import { validateMatchedSemantic } from '../lib/validate/semantic.mjs';
import { mappingPropsResolve } from '../lib/commands/verify-source.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(SCRIPTS_DIR, 'fixtures');

function testShapeGood() {
  const entry = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, 'shape/good-entry.json'), 'utf8'),
  );
  const result = validateRegistryEntry(entry);
  assert.strictEqual(result.ok, true, result.errors.join('\n'));
  console.log('shape good entry → PASS');
}
function testShapeBad() {
  const entry = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, 'shape/bad-entry-missing-prop.json'), 'utf8'),
  );
  const result = validateRegistryEntry(entry);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.length > 0);
  console.log('shape bad entry → PASS');
}
function loadSemanticFixture(name) {
  const dir = path.join(FIXTURES_DIR, name);
  return {
    matched: JSON.parse(fs.readFileSync(path.join(dir, '_figma-props-matched.json'), 'utf8')),
    raw: JSON.parse(fs.readFileSync(path.join(dir, '_figma-props-raw.json'), 'utf8')),
    codeRaw: JSON.parse(fs.readFileSync(path.join(dir, '_code-props-raw.json'), 'utf8')),
  };
}
function testSemanticGoodMatched() {
  const { matched, raw, codeRaw } = loadSemanticFixture('good-matched');
  const problems = validateMatchedSemantic(matched, raw, codeRaw);
  assert.deepStrictEqual(problems, []);
  console.log('semantic good matched → PASS');
}
function testSemanticUnknownProp() {
  const { matched, raw, codeRaw } = loadSemanticFixture('bad-unknown-prop');
  const problems = validateMatchedSemantic(matched, raw, codeRaw);
  assert.ok(
    problems.some((p) => p.includes('missingSize') && p.includes('missing from code API')),
  );
  console.log('semantic unknown prop → PASS');
}
function testSemanticValueCoverage() {
  const { matched, raw, codeRaw } = loadSemanticFixture('bad-value-coverage');
  const problems = validateMatchedSemantic(matched, raw, codeRaw);
  assert.ok(problems.some((p) => p.includes('missing Figma values')));
  console.log('semantic value coverage → PASS');
}
function testSemanticCompositionExactCandidate() {
  const { matched, raw, codeRaw } = loadSemanticFixture('good-matched');
  matched.components[0].groups[0].mappings[0] = {
    figmaProp: 'Size',
    figmaType: 'VARIANT',
    mappingKind: 'composition',
    note: 'Pretend there is no matching code prop.',
  };
  const problems = validateMatchedSemantic(matched, raw, codeRaw);
  assert.ok(problems.some((p) => p.includes('exact code prop candidate exists')));
  console.log('semantic composition exact candidate → PASS');
}
function testSemanticBundleMissingValueProps() {
  const { matched, raw, codeRaw } = loadSemanticFixture('good-matched');
  matched.components[0].groups[0].mappings = [
    {
      figmaProp: 'Checked?',
      figmaType: 'VARIANT',
      mappingKind: 'bundle',
      props: ['checked', 'indeterminate'],
    },
  ];
  raw.components[0].propertyDefinitions = {
    'Checked?': { type: 'VARIANT', variantOptions: ['True', 'False'] },
  };
  const problems = validateMatchedSemantic(matched, raw, codeRaw);
  assert.ok(problems.some((p) => p.includes('bundle needs valueProps')));
  console.log('semantic bundle missing valueProps → PASS');
}
function testSemanticRejectsRedundantValueMap() {
  const { matched, raw, codeRaw } = loadSemanticFixture('good-matched');
  raw.components[0].propertyDefinitions.Size.variantOptions = ['SM', 'LG'];
  matched.components[0].groups[0].mappings[0].valueMap = {
    SM: 'sm',
    LG: 'lg',
  };

  const problems = validateMatchedSemantic(matched, raw, codeRaw);
  assert.ok(problems.some((problem) => problem.includes('redundant valueMap')));
  console.log('semantic redundant valueMap → PASS');
}
function testMappingPropsResolveReportsAllMissing() {
  const group = {
    name: 'btn',
    mappings: [
      { figmaProp: 'Size', mappingKind: 'direct', prop: 'size' },
      { figmaProp: 'Show prepend#1:1', mappingKind: 'composition', note: 'x' },
      { figmaProp: 'Legacy axis', mappingKind: 'unsupported', note: 'y' },
    ],
  };
  const propertyDefinitions = { Size: { type: 'VARIANT' } };
  const missing = mappingPropsResolve(group, propertyDefinitions);
  assert.deepStrictEqual(missing, ['Show prepend#1:1', 'Legacy axis']);
  console.log('mappingPropsResolve reports all missing props → PASS');
}


export const tests = [
  testShapeGood,
  testShapeBad,
  testSemanticGoodMatched,
  testSemanticUnknownProp,
  testSemanticValueCoverage,
  testSemanticCompositionExactCandidate,
  testSemanticBundleMissingValueProps,
  testSemanticRejectsRedundantValueMap,
  testMappingPropsResolveReportsAllMissing,
];
