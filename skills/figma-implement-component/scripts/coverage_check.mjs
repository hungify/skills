#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import { VISITOR_KEYS } from "@babel/types";
import { loadJson, parseArgs } from "./_shared.mjs";

// @babel/parser only parses (plus @babel/types' VISITOR_KEYS for a generic
// tree walk below); it never evaluates the file, which matters here since
// testids/harness files are agent-authored content this script must not
// trust. Chosen over the full `typescript` package specifically because it's
// parser-only — bundled+minified it's roughly 10x smaller (~550KB vs ~3.4MB)
// since it doesn't carry a type-checker/emitter/language-service. See
// scripts/sync-figloom.mjs: this is the one script in the skill that needs
// bundling because of this dependency.

function parseModule(filePath, text, { jsx }) {
  try {
    return parse(text, {
      sourceFilename: filePath,
      sourceType: "module",
      plugins: jsx ? ["typescript", "jsx"] : ["typescript"],
    });
  } catch (e) {
    throw new Error(e.message);
  }
}

// Generic depth-first child visitor, driven by @babel/types' VISITOR_KEYS
// (a type -> child-property-names map) instead of a hand-maintained list —
// mirrors what a full @babel/traverse would do, without the extra weight.
function forEachChild(node, visit) {
  if (!node || typeof node.type !== "string") return;
  for (const key of VISITOR_KEYS[node.type] || []) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
    } else if (value) {
      visit(value);
    }
  }
}

// Returns the first descendant (or `node` itself) for which `matcher`
// returns a truthy value, depth-first — used to search a subtree for a
// structural pattern without caring about its exact position.
function findMatch(node, matcher) {
  const result = matcher(node);
  if (result) return result;
  let found;
  forEachChild(node, (child) => {
    if (!found) found = findMatch(child, matcher);
  });
  return found;
}

function isConstTypeReference(node) {
  return (
    Boolean(node) &&
    node.type === "TSTypeReference" &&
    node.typeName?.type === "Identifier" &&
    node.typeName.name === "const"
  );
}

function propertyKeyName(prop) {
  if (prop.computed) return null;
  if (prop.key.type === "Identifier") return prop.key.name;
  if (prop.key.type === "StringLiteral") return prop.key.value;
  return null;
}

// Mirrors the narrow grammar the skill's convention allows: nested object
// literals with identifier/string keys, bottoming out in string literals.
// Anything else (arrays, numbers, template literals, spreads, computed
// keys, method shorthand, function calls...) is rejected.
function objectLiteralToValue(expr) {
  if (expr.type === "ObjectExpression") {
    const obj = Object.create(null);
    for (const prop of expr.properties) {
      if (prop.type !== "ObjectProperty" || prop.shorthand) {
        throw new Error('Only plain "key: value" properties are accepted (no shorthand, spread, methods, or computed keys)');
      }
      const key = propertyKeyName(prop);
      if (key === null) throw new Error("Object keys must be an identifier or a string literal");
      obj[key] = objectLiteralToValue(prop.value);
    }
    return obj;
  }
  if (expr.type === "StringLiteral") return expr.value;
  throw new Error("Only object literals and string literals are accepted");
}

function parseTestidsModule(raw, filePath) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const ast = parseModule(filePath, text, { jsx: false });
  const body = ast.program.body;

  if (body.length !== 1) {
    throw new Error("Expected exactly one statement: the exported testids constant");
  }
  const [stmt] = body;
  if (
    stmt.type !== "ExportNamedDeclaration" ||
    stmt.declaration?.type !== "VariableDeclaration" ||
    stmt.declaration.kind !== "const" ||
    stmt.declaration.declarations.length !== 1
  ) {
    throw new Error('Expected "export const <NAME> = { ... };"');
  }
  const [decl] = stmt.declaration.declarations;
  if (decl.id.type !== "Identifier") throw new Error("Expected a simple identifier as the constant name");
  if (!decl.init) throw new Error("Expected an initializer (the testids object)");

  let valueExpr = decl.init;
  if (valueExpr.type === "TSAsExpression" && isConstTypeReference(valueExpr.typeAnnotation)) {
    valueExpr = valueExpr.expression;
  }
  const parsed = objectLiteralToValue(valueExpr);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected the initializer to be an object literal");
  }

  for (const [prop, values] of Object.entries(parsed)) {
    if (values === null || typeof values !== "object" || Array.isArray(values)) {
      throw new Error(`testids.${prop} must be an object`);
    }
    for (const [value, testid] of Object.entries(values)) {
      if (typeof testid !== "string") {
        throw new Error(`testids.${prop}.${value} must be a string`);
      }
    }
  }
  return { exportName: decl.id.name, values: parsed };
}

function loadTestids(p) {
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    console.error(`Could not read file: ${p}\n${e.message}`);
    process.exit(1);
  }
  if (p.endsWith(".json")) {
    try {
      return { exportName: null, values: JSON.parse(raw) };
    } catch (e) {
      console.error(`Invalid JSON: ${p}\n${e.message}`);
      process.exit(1);
    }
  }

  try {
    return parseTestidsModule(raw, p);
  } catch (e) {
    console.error(
      `Could not parse testids file '${p}'. Expected the exact convention ` +
        `"export const X_TESTIDS = { ... } as const;" (step 5b). Details: ${e.message}`
    );
    process.exit(1);
  }
}

function isDataTestidAttr(node) {
  return node.type === "JSXAttribute" && node.name?.type === "JSXIdentifier" && node.name.name === "data-testid";
}

function isDataTestidBoundTo(node, testidVar) {
  return (
    isDataTestidAttr(node) &&
    node.value?.type === "JSXExpressionContainer" &&
    node.value.expression?.type === "Identifier" &&
    node.value.expression.name === testidVar
  );
}

// Matches `Object.entries(<sourceLocalName>).<methodName>(([_, x]) => body)`,
// returning the callback's second destructured param name and body.
function matchEntriesCallback(node, sourceLocalName, methodName) {
  if (node.type !== "CallExpression") return undefined;
  if (
    node.callee.type !== "MemberExpression" ||
    node.callee.computed ||
    node.callee.property.type !== "Identifier" ||
    node.callee.property.name !== methodName
  ) {
    return undefined;
  }
  const entriesCall = node.callee.object;
  if (
    entriesCall.type !== "CallExpression" ||
    entriesCall.callee.type !== "MemberExpression" ||
    entriesCall.callee.computed ||
    entriesCall.callee.object.type !== "Identifier" ||
    entriesCall.callee.object.name !== "Object" ||
    entriesCall.callee.property.type !== "Identifier" ||
    entriesCall.callee.property.name !== "entries" ||
    entriesCall.arguments.length !== 1 ||
    entriesCall.arguments[0].type !== "Identifier" ||
    entriesCall.arguments[0].name !== sourceLocalName
  ) {
    return undefined;
  }
  if (node.arguments.length !== 1) return undefined;
  const callback = node.arguments[0];
  if (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression") return undefined;
  if (callback.params.length !== 1) return undefined;
  const param = callback.params[0];
  if (param.type !== "ArrayPattern" || param.elements.length < 2) return undefined;
  const second = param.elements[1];
  if (!second || second.type !== "Identifier") return undefined;
  return { varName: second.name, body: callback.body };
}

// Structurally confirms `returnExpr` contains the required nested-iteration
// pattern: Object.entries(TESTIDS).flatMap(([_, group]) =>
// Object.entries(group).map(([_, testid]) => ... data-testid={testid} ...)).
// Walks the whole subtree (not a fixed shape) so formatting/wrapping
// doesn't matter, only the structural chain does.
function rendersEveryTestid(returnExpr, localName) {
  const outer = findMatch(returnExpr, (n) => matchEntriesCallback(n, localName, "flatMap"));
  if (!outer) return false;
  const inner = findMatch(outer.body, (n) => matchEntriesCallback(n, outer.varName, "map"));
  if (!inner) return false;
  return Boolean(findMatch(inner.body, (n) => (isDataTestidBoundTo(n, inner.varName) ? n : undefined)));
}

function collectReturnExpressions(node, out) {
  if (node.type === "ReturnStatement" && node.argument) out.push(node.argument);
  forEachChild(node, (child) => collectReturnExpressions(child, out));
}

// Finds the local name the harness imports the testids module under.
// Named-export case: the harness must import the literal exportName (an
// aliased `import { X as Y }` won't resolve to a usable local name here,
// matching the fact that the render pattern below has to reference the
// same identifier the constant file exports). Default-export case (JSON
// testids): any default import from the expected module.
// Strips the extension a harness import may legally carry (".ts"/".js" are
// valid specifiers under NodeNext ESM / allowImportingTsExtensions, and a
// default-exported testids module may be plain JSON) so
// `./button-showcase.testids`, `./button-showcase.testids.ts` and
// `./button-showcase.testids.json` all compare equal once resolved.
function stripModuleExtension(specifier) {
  return specifier.replace(/\.(?:ts|tsx|js|jsx|mjs|json)$/, "");
}

// Strips a trailing "//..." or "/*...*/" comment from tsconfig/jsconfig JSON
// (both allow comments — JSONC — despite the .json extension), leaving
// string literals untouched, then removes trailing commas so JSON.parse
// doesn't choke on either.
function parseJsonc(text) {
  const withoutComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/.*$|\/\*[\s\S]*?\*\//gm, (m, str) => str ?? "");
  return JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, "$1"));
}

// Walks upward from `startDir` looking for the nearest tsconfig.json /
// jsconfig.json that declares compilerOptions.paths, so alias imports
// (`@/foo`) can be resolved to a real file path alongside relative ones.
// Returns null if none is found or the one found can't be parsed — callers
// then simply can't resolve alias specifiers, which surfaces as the normal
// "harness has not proven it renders every testid" error rather than a crash.
function loadTsconfigAliases(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = path.join(dir, name);
      if (!existsSync(candidate)) continue;
      try {
        const json = parseJsonc(readFileSync(candidate, "utf8"));
        const paths = json.compilerOptions?.paths;
        if (paths && typeof paths === "object") {
          const baseDir = path.resolve(dir, json.compilerOptions.baseUrl || ".");
          return { baseDir, paths };
        }
      } catch {
        // Malformed tsconfig: keep walking rather than aborting the whole check.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Resolves an import specifier (`@/components/button.testids`) against
// tsconfig `paths` entries (`{"@/*": ["./src/*"]}`), returning an absolute
// path with no extension, or null if no pattern matches (bare package
// specifiers like "react" fall through here and are correctly ignored).
function resolveAliasSpecifier(specifier, aliasConfig) {
  if (!aliasConfig) return null;
  let best = null;
  for (const [pattern, targets] of Object.entries(aliasConfig.paths)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;
    const target = targets[0];
    if (pattern.endsWith("/*") && target.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      if (!specifier.startsWith(prefix)) continue;
      if (best && best.prefixLen >= prefix.length) continue;
      const rest = specifier.slice(prefix.length);
      best = { prefixLen: prefix.length, resolved: path.resolve(aliasConfig.baseDir, target.slice(0, -1), rest) };
    } else if (pattern === specifier) {
      if (best && best.prefixLen >= pattern.length) continue;
      best = { prefixLen: pattern.length, resolved: path.resolve(aliasConfig.baseDir, target) };
    }
  }
  return best ? best.resolved : null;
}

// Resolves a harness import specifier to an absolute, extension-stripped
// path — via relative resolution ("./x") or a tsconfig alias ("@/x") — so it
// can be compared against the testids file's own resolved path regardless of
// which convention the repo's lint rules force the harness to use.
function resolveImportTarget(harnessDir, specifier, aliasConfig) {
  const bare = stripModuleExtension(specifier);
  if (bare.startsWith(".")) return path.resolve(harnessDir, bare);
  return resolveAliasSpecifier(bare, aliasConfig);
}

function findImportedLocalName(programBody, harnessDir, testidsTarget, exportName, aliasConfig) {
  for (const stmt of programBody) {
    if (stmt.type !== "ImportDeclaration" || stmt.source?.type !== "StringLiteral") continue;
    const target = resolveImportTarget(harnessDir, stmt.source.value, aliasConfig);
    if (target !== testidsTarget) continue;
    if (exportName) {
      const hasExport = stmt.specifiers.some(
        (spec) => spec.type === "ImportSpecifier" && (spec.imported.name ?? spec.imported.value) === exportName,
      );
      if (hasExport) return exportName;
    } else {
      const defaultSpec = stmt.specifiers.find((spec) => spec.type === "ImportDefaultSpecifier");
      if (defaultSpec) return defaultSpec.local.name;
    }
  }
  return null;
}

function verifyHarness(filePath, testidsPath, exportName, expectedTestids) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    console.error(`Could not read harness file: ${filePath}\n${e.message}`);
    process.exit(1);
  }

  let ast;
  try {
    ast = parseModule(filePath, raw, { jsx: true });
  } catch (e) {
    throw new Error(`Harness '${filePath}' failed to parse: ${e.message}`);
  }

  if (!findMatch(ast.program, (n) => (isDataTestidAttr(n) ? n : undefined))) {
    throw new Error(`Harness '${filePath}' does not render any data-testid.`);
  }

  const harnessDir = path.dirname(path.resolve(filePath));
  const testidsTarget = stripModuleExtension(path.resolve(testidsPath));
  const aliasConfig = loadTsconfigAliases(harnessDir);
  const localName = findImportedLocalName(ast.program.body, harnessDir, testidsTarget, exportName, aliasConfig);

  const returnExprs = [];
  collectReturnExpressions(ast.program, returnExprs);
  const testidsRendered =
    Boolean(localName) &&
    expectedTestids.length > 0 &&
    returnExprs.some((expr) => rendersEveryTestid(expr, localName));

  if (!testidsRendered) {
    throw new Error(
      `Harness '${filePath}' has not proven it renders every ${exportName ?? "CONSTANT"}: ` +
        `it must import the correct testids module and iterate Object.entries(${exportName ?? "CONSTANT"}) ` +
        `via .flatMap(([_, group]) => Object.entries(group).map(([_, testid]) => ...)) ` +
        `passing each testid into data-testid={testid} (see step 5b — do not hardcode testid strings in the harness).`,
    );
  }
  return true;
}

function supportsCodeValue(codeProp, codeValue) {
  if (codeProp.type === "boolean") return typeof codeValue === "boolean";
  return Array.isArray(codeProp.values) && codeProp.values.includes(String(codeValue));
}

function identityCodeValue(codeProp, option) {
  const normalized = option.toLowerCase();
  if (codeProp.type === "boolean" && (normalized === "true" || normalized === "false")) {
    return normalized === "true";
  }
  // A declared code value that isn't all-lowercase (e.g. "primaryDark") would
  // never match a purely-lowercased identity, forcing an unnecessary explicit
  // valueMap for what's otherwise a direct match. Match case-insensitively
  // against the declared values first, and keep their exact casing.
  if (Array.isArray(codeProp.values)) {
    const declared = codeProp.values.find((value) => value.toLowerCase() === normalized);
    if (declared !== undefined) return declared;
  }
  return normalized;
}

function optionsForIdentity(figmaOptions, identity) {
  if (!figmaOptions || figmaOptions.schemaVersion !== 1 || !Array.isArray(figmaOptions.groups)) {
    return { error: "figma-options must follow schemaVersion 1 with groups[]" };
  }
  if (!identity || !identity.componentPath || !identity.groupName || !identity.propName) {
    return { error: "dedup output is missing a structured canonicalIdentity" };
  }
  const matches = figmaOptions.groups.filter(
    (group) =>
      group?.componentPath === identity.componentPath &&
      group?.groupName === identity.groupName &&
      group?.propName === identity.propName &&
      (group?.figmaNodeId ?? null) === (identity.figmaNodeId ?? null),
  );
  if (matches.length !== 1) {
    return {
      error:
        `expected exactly 1 figma-options group for ` +
        `${identity.componentPath}/${identity.groupName}/${identity.propName}; got ${matches.length}`,
    };
  }
  const options = matches[0].options;
  if (!Array.isArray(options) || options.length === 0 || !options.every((v) => typeof v === "string" && v.length > 0)) {
    return { error: "options must be a non-empty string[]" };
  }
  return { options };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  for (const req of ["registry", "dedup", "testids", "harness", "component"]) {
    if (!a[req]) {
      console.error(
        "Missing --" + req + ". Usage: --registry <f> --dedup <f> --testids <f> --harness <f> --component <name> [--figma-options <f>]"
      );
      process.exit(2);
    }
  }

  const registry = loadJson(a.registry);
  const dedupData = loadJson(a.dedup);
  const testidsModule = loadTestids(a.testids);
  const testids = testidsModule.values;
  const figmaOptions = a["figma-options"] ? loadJson(a["figma-options"]) : {};
  const component = a.component;

  const visualGaps = [];
  const notes = [];
  const expectedTestids = [];
  const expectedCases = [];

  for (const [prop, info] of Object.entries(dedupData.props || {})) {
    const codeProp = registry.codePropsMap?.[prop];
    if (!codeProp) {
      visualGaps.push(
        `${prop}: canonical binding (node ${info.canonicalFigmaNodeId}) has no ` +
          `matching codePropsMap.${prop} — the component may not expose this prop yet.`
      );
      continue;
    }

    let codeValuesToCheck = [];

    if (info.canonicalValueMap) {
      for (const [figmaVal, codeVal] of Object.entries(info.canonicalValueMap)) {
        if (!supportsCodeValue(codeProp, codeVal)) {
          visualGaps.push(
            `${prop}.${codeVal}: valueMap declares Figma "${figmaVal}" -> code "${codeVal}" ` +
              `but codePropsMap.${prop}.values does not have this value.`
          );
          continue;
        }
        codeValuesToCheck.push(String(codeVal));
      }
    } else {
      const resolvedOptions = optionsForIdentity(figmaOptions, info.canonicalIdentity);
      const rawOptions = resolvedOptions.options;
      if (rawOptions) {
        for (const opt of rawOptions) {
          const codeValue = identityCodeValue(codeProp, opt);
          const identity = String(codeValue);
          if (!supportsCodeValue(codeProp, codeValue)) {
            visualGaps.push(
              `${prop}.${identity}: present in Figma (node ${info.canonicalFigmaNodeId}, option ` +
                `"${opt}") but code has no matching value in codePropsMap.${prop}.values ` +
                `— add the prop or confirm this is legacy.`
            );
            continue;
          }
          codeValuesToCheck.push(identity);
        }
      } else {
        const reason = a["figma-options"]
          ? resolvedOptions.error
          : `missing --figma-options for an identity-mapping prop`;
        visualGaps.push(`${prop}: ${reason}; Figma->code could not be verified.`);
        notes.push(`${prop}: add the original Figma options before generating the gate artifact.`);
      }
    }

    for (const codeVal of codeValuesToCheck) {
      const expected = `${component}-${prop}-${codeVal}`;
      const actual = testids?.[prop]?.[codeVal];
      if (!actual) {
        visualGaps.push(
          `${prop}.${codeVal}: no data-testid in the constant file ` +
            `(expected testids.${prop}.${codeVal} = "${expected}").`
        );
      } else if (actual !== expected) {
        visualGaps.push(
          `${prop}.${codeVal}: testid "${actual}" does not follow the ` +
            `"{component}-{prop}-{value}" convention (expected "${expected}").`
        );
      }
      if (actual === expected) {
        if (!expectedTestids.includes(actual)) {
          expectedTestids.push(actual);
          expectedCases.push({
            testid: actual,
            identity: info.canonicalIdentity,
          });
        }
      }
    }
  }

  let harnessVerified = false;
  if (visualGaps.length === 0) {
    try {
      harnessVerified = verifyHarness(
        a.harness,
        a.testids,
        testidsModule.exportName,
        [...new Set(expectedTestids)],
      );
    } catch (e) {
      visualGaps.push(e.message);
    }
  }

  const result = {
    direction: "figma-to-code",
    visualGaps,
    needsHumanReview: dedupData.needsHumanReview || [],
    notes,
    expectedTestids,
    expectedCases,
    harnessVerified,
    inputs: {
      registryPath: a.registry,
      dedupPath: a.dedup,
      testidsFilePath: a.testids,
      harnessFilePath: a.harness,
    },
  };

  console.log(JSON.stringify(result, null, 2));
  if (visualGaps.length > 0) {
    console.error(`\n${visualGaps.length} visualGap(s) found — see the visualGaps field in the JSON output.`);
    process.exitCode = 1;
  }
}

main();
