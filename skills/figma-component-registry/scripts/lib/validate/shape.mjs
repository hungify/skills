import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import fs from 'node:fs';
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });
const registrySchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../schemas/registry-entry.schema.json'), 'utf8'),
);
const matchedSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../schemas/matched.schema.json'), 'utf8'),
);
const validateRegistry = ajv.compile(registrySchema);
const validateMatchedAjv = ajv.compile(matchedSchema);

function formatErrors(errors) {
  return (errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

function validateRegistryEntry(entry) {
  const ok = validateRegistry(entry);
  return { ok, errors: ok ? [] : formatErrors(validateRegistry.errors) };
}

function validateMatched(matched) {
  const ok = validateMatchedAjv(matched);
  return { ok, errors: ok ? [] : formatErrors(validateMatchedAjv.errors) };
}
export { validateRegistryEntry, validateMatched };
