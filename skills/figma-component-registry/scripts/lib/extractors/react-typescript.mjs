import fs from 'node:fs';
import path from 'node:path';
import reactDocgen from 'react-docgen-typescript';
import ts from 'typescript';
import { projectMappingCandidateProps } from '../domain/prop-policy.mjs';

const docgenParser = reactDocgen.withDefaultConfig({
  savePropValueAsString: true,
  shouldExtractLiteralValuesFromEnum: true,
  shouldRemoveUndefinedFromOptional: true,
});
const fileExtensions = ['.tsx'];

function nodeName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return node.getText().replace(/^['"]|['"]$/g, '');
}

function hasExportModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function hasDefaultModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
}

function literalValues(typeNode) {
  if (!typeNode) return [];
  const nodes = ts.isUnionTypeNode(typeNode) ? typeNode.types : [typeNode];
  return nodes.flatMap((node) => {
    if (ts.isLiteralTypeNode(node)) {
      if (ts.isStringLiteral(node.literal) || ts.isNumericLiteral(node.literal)) {
        return [node.literal.text];
      }
      if (node.literal.kind === ts.SyntaxKind.TrueKeyword) return [true];
      if (node.literal.kind === ts.SyntaxKind.FalseKeyword) return [false];
    }
    return [];
  });
}

function typeKeyValues(typeNode) {
  return literalValues(typeNode).map(String);
}

function collectPropsFromTypeNode(
  typeNode,
  sourceFile,
  props,
  typeDeclarations,
  visited = new Set(),
) {
  if (!typeNode) return;
  if (ts.isTypeLiteralNode(typeNode)) {
    for (const member of typeNode.members) {
      if (!ts.isPropertySignature(member)) continue;
      const name = nodeName(member.name);
      if (!name) continue;
      const values = literalValues(member.type);
      props[name] = {
        source: 'local-type',
        type: member.type?.getText(sourceFile) ?? 'unknown',
        required: !member.questionToken,
        ...(values.length > 0 ? { values } : {}),
      };
    }
    return;
  }
  if (ts.isIntersectionTypeNode(typeNode) || ts.isUnionTypeNode(typeNode)) {
    for (const child of typeNode.types) {
      collectPropsFromTypeNode(child, sourceFile, props, typeDeclarations, visited);
    }
    return;
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText(sourceFile);
    if ((typeName === 'Pick' || typeName === 'Omit') && typeNode.typeArguments?.length === 2) {
      const inherited = {};
      collectPropsFromTypeNode(
        typeNode.typeArguments[0],
        sourceFile,
        inherited,
        typeDeclarations,
        visited,
      );
      const keys = new Set(typeKeyValues(typeNode.typeArguments[1]));
      if (typeName === 'Pick') {
        for (const key of keys) {
          props[key] = inherited[key] ?? {
            source: 'external-type-ref',
            type: 'unknown',
            required: false,
          };
        }
      } else {
        for (const [key, value] of Object.entries(inherited)) {
          if (!keys.has(key)) props[key] = value;
        }
      }
      return;
    }
    if (!ts.isIdentifier(typeNode.typeName) || visited.has(typeName)) return;
    const declaration = typeDeclarations.get(typeName);
    if (!declaration) return;
    visited.add(typeName);
    if (ts.isTypeAliasDeclaration(declaration)) {
      collectPropsFromTypeNode(declaration.type, sourceFile, props, typeDeclarations, visited);
    } else if (ts.isInterfaceDeclaration(declaration)) {
      for (const heritage of declaration.heritageClauses ?? []) {
        for (const inheritedType of heritage.types) {
          collectPropsFromTypeNode(inheritedType, sourceFile, props, typeDeclarations, visited);
        }
      }
      collectPropsFromTypeNode(
        ts.factory.createTypeLiteralNode(declaration.members),
        sourceFile,
        props,
        typeDeclarations,
        visited,
      );
    }
  }
}

function objectProperty(objectNode, name) {
  if (!objectNode || !ts.isObjectLiteralExpression(objectNode)) return null;
  return (
    objectNode.properties.find(
      (property) => ts.isPropertyAssignment(property) && nodeName(property.name) === name,
    ) ?? null
  );
}

function extractCvaVariants(sourceFile) {
  const variantsByName = new Map();
  sourceFile.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = declaration.initializer;
      if (
        !ts.isCallExpression(initializer) ||
        initializer.expression.getText(sourceFile) !== 'cva'
      ) {
        continue;
      }
      const config = initializer.arguments[1];
      const variantsProperty = objectProperty(config, 'variants');
      if (!variantsProperty || !ts.isObjectLiteralExpression(variantsProperty.initializer))
        continue;
      const props = {};
      for (const variant of variantsProperty.initializer.properties) {
        if (!ts.isPropertyAssignment(variant)) continue;
        const name = nodeName(variant.name);
        if (!name || !ts.isObjectLiteralExpression(variant.initializer)) continue;
        const values = variant.initializer.properties
          .map((property) => nodeName(property.name))
          .filter(Boolean);
        props[name] = { source: 'cva', type: 'variant', values };
      }
      variantsByName.set(declaration.name.text, props);
    }
  });
  return variantsByName;
}

function normalizeDeclarationPath(fileName) {
  if (!fileName) return null;
  const normalized = fileName.replace(/\\/g, '/');
  if (path.isAbsolute(normalized))
    return path.relative(process.cwd(), normalized).replace(/\\/g, '/');
  const cwdName = path.basename(process.cwd());
  return normalized.startsWith(`${cwdName}/`) ? normalized.slice(cwdName.length + 1) : normalized;
}

function docgenValues(type) {
  if (!Array.isArray(type?.value)) return [];
  return type.value
    .map((entry) => entry?.value)
    .filter((value) => typeof value === 'string')
    .map((value) => value.replace(/^['"]|['"]$/g, ''));
}

function mergeResolvedProps(components, filePath) {
  let docs = [];
  try {
    docs = docgenParser.parse(filePath);
  } catch (error) {
    console.warn(
      `WARN: docgen skipped ${filePath}: ${error instanceof Error ? error.message : error}`,
    );
    return;
  }
  for (const doc of docs) {
    const component = components[doc.displayName];
    if (!component) continue;
    for (const [propName, prop] of Object.entries(doc.props ?? {})) {
      if (component.props[propName]?.source !== 'external-type-ref') continue;
      const declarationPath = normalizeDeclarationPath(
        prop.declarations?.[0]?.fileName ?? prop.parent?.fileName,
      );
      const values = docgenValues(prop.type);
      component.props[propName] = {
        source: declarationPath?.includes('node_modules/') ? 'external-type' : 'resolved-type',
        type: prop.type?.raw ?? prop.type?.name ?? 'unknown',
        required: prop.required,
        ...(values.length > 0 ? { values } : {}),
        ...(declarationPath ? { declarationPath } : {}),
      };
    }
    for (const [propName, prop] of Object.entries(doc.props ?? {})) {
      if (component.props[propName]) continue;
      const declarationPath = normalizeDeclarationPath(
        prop.declarations?.[0]?.fileName ?? prop.parent?.fileName,
      );
      const values = docgenValues(prop.type);
      component.props[propName] = {
        source: declarationPath?.includes('node_modules/') ? 'external-type' : 'resolved-type',
        type: prop.type?.raw ?? prop.type?.name ?? 'unknown',
        required: prop.required,
        ...(values.length > 0 ? { values } : {}),
        ...(declarationPath ? { declarationPath } : {}),
      };
    }
  }
}

function collectDestructuredProps(parameter, props) {
  if (!parameter || !ts.isObjectBindingPattern(parameter.name)) return;
  for (const element of parameter.name.elements) {
    if (element.dotDotDotToken) continue;
    const name = nodeName(element.propertyName ?? element.name);
    if (!name || props[name]) continue;
    props[name] = { source: 'source-read', type: 'unknown', required: false };
  }
}

function findArrowOrFunctionByName(sourceFile, name) {
  let found = null;
  sourceFile.forEachChild((node) => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === name &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          found = decl.initializer;
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === name) {
      found = node;
    }
  });
  return found;
}

function toRegistryProp(prop) {
  const values = Array.isArray(prop.values)
    ? prop.values.map(String).filter((value) => value.length > 0)
    : [];
  if (values.length > 0 || prop.source === 'cva') {
    return { type: 'enum', values };
  }

  const rawType = String(prop.type ?? '').toLowerCase();
  if (rawType === 'boolean' || rawType.includes('boolean')) return { type: 'boolean' };
  if (rawType === 'string' || rawType.includes('string')) return { type: 'string' };
  if (rawType === 'number' || rawType.includes('number')) return { type: 'number' };
  if (
    rawType.includes('reactnode') ||
    rawType.includes('reactelement') ||
    rawType.includes('jsx.element') ||
    rawType === 'node'
  ) {
    return { type: 'node' };
  }
  if (rawType.includes('[]') || rawType.startsWith('array')) return { type: 'array' };
  return { type: 'unknown' };
}

function toRegistryProps(rawProps) {
  const props = {};
  for (const [name, raw] of Object.entries(rawProps ?? {})) {
    props[name] = toRegistryProp(raw);
  }
  return props;
}

function extractComponentsFromSource(source, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const exportedNames = new Set();
  const exportTypes = new Map();
  const typeDeclarations = new Map();
  const valueDeclarations = new Map();

  sourceFile.forEachChild((node) => {
    if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) {
      typeDeclarations.set(node.name.text, node);
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      valueDeclarations.set(node.name.text, node);
      if (hasExportModifier(node)) {
        exportedNames.add(node.name.text);
        exportTypes.set(node.name.text, hasDefaultModifier(node) ? 'default' : 'named');
      }
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        valueDeclarations.set(declaration.name.text, declaration);
        if (hasExportModifier(node)) {
          exportedNames.add(declaration.name.text);
          exportTypes.set(declaration.name.text, hasDefaultModifier(node) ? 'default' : 'named');
        }
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        const exportName = element.name.text;
        exportedNames.add(exportName);
        exportTypes.set(exportName, 'named');
      }
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      if (ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        exportedNames.add(name);
        exportTypes.set(name, 'default');
      } else if (
        ts.isFunctionExpression(node.expression) ||
        ts.isArrowFunction(node.expression)
      ) {
        exportedNames.add('default');
        exportTypes.set('default', 'default');
      }
    }
  });

  const cvaVariants = extractCvaVariants(sourceFile);
  const components = {};
  for (const componentName of exportedNames) {
    if (!/^[A-Z]/.test(componentName)) continue;
    const props = {};
    const propsDeclaration = typeDeclarations.get(`${componentName}Props`);
    let typeNode = null;
    if (propsDeclaration && ts.isTypeAliasDeclaration(propsDeclaration)) {
      typeNode = propsDeclaration.type;
      collectPropsFromTypeNode(typeNode, sourceFile, props, typeDeclarations);
    } else if (propsDeclaration && ts.isInterfaceDeclaration(propsDeclaration)) {
      for (const heritage of propsDeclaration.heritageClauses ?? []) {
        for (const inheritedType of heritage.types) {
          collectPropsFromTypeNode(inheritedType, sourceFile, props, typeDeclarations);
        }
      }
      collectPropsFromTypeNode(
        ts.factory.createTypeLiteralNode(propsDeclaration.members),
        sourceFile,
        props,
        typeDeclarations,
      );
    } else {
      const declaration = valueDeclarations.get(componentName);
      if (declaration && ts.isFunctionDeclaration(declaration)) {
        typeNode = declaration.parameters[0]?.type ?? null;
        collectDestructuredProps(declaration.parameters[0], props);
      } else if (declaration && ts.isVariableDeclaration(declaration)) {
        const initializer = declaration.initializer;
        if (
          initializer &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          typeNode = initializer.parameters[0]?.type ?? null;
          collectDestructuredProps(initializer.parameters[0], props);
        }
      } else {
        const resolved = findArrowOrFunctionByName(sourceFile, componentName);
        if (resolved) {
          typeNode = resolved.parameters[0]?.type ?? null;
          collectDestructuredProps(resolved.parameters[0], props);
        }
      }
      collectPropsFromTypeNode(typeNode, sourceFile, props, typeDeclarations);
    }

    const valueDeclaration = valueDeclarations.get(componentName);
    if (valueDeclaration && ts.isFunctionDeclaration(valueDeclaration)) {
      collectDestructuredProps(valueDeclaration.parameters[0], props);
    } else if (valueDeclaration && ts.isVariableDeclaration(valueDeclaration)) {
      const initializer = valueDeclaration.initializer;
      if (
        initializer &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
      ) {
        collectDestructuredProps(initializer.parameters[0], props);
      }
    } else {
      const resolved = findArrowOrFunctionByName(sourceFile, componentName);
      if (resolved) {
        collectDestructuredProps(resolved.parameters[0], props);
      }
    }

    const typeText = typeNode?.getText(sourceFile) ?? '';
    for (const [variantName, variantProps] of cvaVariants) {
      if (!typeText.includes(`typeof ${variantName}`)) continue;
      for (const [propName, prop] of Object.entries(variantProps)) {
        props[propName] = { ...(props[propName] ?? {}), ...prop };
      }
    }

    components[componentName] = {
      exportType: exportTypes.get(componentName) ?? 'named',
      props,
    };
  }
  mergeResolvedProps(components, filePath);
  return components;
}

function extractComponents(absPath) {
  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }
  const source = fs.readFileSync(absPath, 'utf8');
  const raw = extractComponentsFromSource(source, absPath);
  const components = {};
  for (const [exportName, entry] of Object.entries(raw)) {
    const ownedPropNames = Object.entries(entry.props)
      .filter(
        ([, prop]) =>
          prop.source !== 'external-type' && prop.source !== 'external-type-ref',
      )
      .map(([name]) => name);
    const props = projectMappingCandidateProps(
      toRegistryProps(entry.props),
      { rawProps: entry.props },
    );
    components[exportName] = {
      exportType: entry.exportType,
      props,
      ownedPropNames: ownedPropNames.filter((name) => props[name]),
    };
  }
  return components;
}
export { extractComponents, extractComponentsFromSource, fileExtensions, toRegistryProps };
