import * as fs from "node:fs";

import { parse } from "@babel/parser";

const primitiveRawTags = {
  Button: ["button"],
  Input: ["input"],
  TextField: ["input"],
  Textarea: ["textarea"],
  TextareaField: ["textarea"],
  Select: ["select"],
  SelectField: ["select"],
  Checkbox: ["input"],
  RadioGroup: ["input"],
  RadioGroupItem: ["input"],
  Switch: ["button"],
};

const semanticRoleComponents = {
  Button: ["button"],
  Switch: ["switch"],
  Checkbox: ["checkbox"],
  RadioGroupItem: ["radio"],
};

const alwaysAllowedAttributes = new Set([
  "className",
  "children",
  "key",
  "ref",
  "id",
  "style",
  "slot",
  "asChild",
  "render",
  "nativeButton",
]);

const ignoredTraversalKeys = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "comments",
  "errors",
  "tokens",
]);

function lineOf(node) {
  return node.loc?.start.line ?? 1;
}

function jsxTagNameText(name) {
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") {
    return `${jsxTagNameText(name.object)}.${jsxTagNameText(name.property)}`;
  }
  if (name.type === "JSXNamespacedName") {
    return `${name.namespace.name}:${name.name.name}`;
  }
  return "";
}

function literalAttributeValue(attribute) {
  if (!attribute.value) return void 0;
  if (attribute.value.type === "StringLiteral") return attribute.value.value;
  if (attribute.value.type !== "JSXExpressionContainer") return void 0;
  const expression = attribute.value.expression;
  if (expression.type === "StringLiteral") return expression.value;
  if (expression.type === "BooleanLiteral") return String(expression.value);
  return void 0;
}

function collectJsxAttributes(attributes) {
  return attributes.flatMap((attribute) => {
    if (attribute.type !== "JSXAttribute" || attribute.name.type !== "JSXIdentifier") return [];
    return [
      {
        name: attribute.name.name,
        value: literalAttributeValue(attribute),
        line: lineOf(attribute),
      },
    ];
  });
}

function jsxRoleValue(attributes) {
  const role = attributes.find(
    (attribute) =>
      attribute.type === "JSXAttribute" &&
      attribute.name.type === "JSXIdentifier" &&
      attribute.name.name === "role",
  );
  return role ? literalAttributeValue(role) : void 0;
}

function forEachChild(node, callback) {
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (ignoredTraversalKeys.has(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === "string") callback(child);
      }
    } else if (value && typeof value.type === "string") {
      callback(value);
    }
  }
}

function containsJsx(node) {
  if (!node) return false;
  if (
    node.type === "JSXElement" ||
    node.type === "JSXFragment" ||
    node.type === "JSXOpeningElement"
  ) {
    return true;
  }
  let found = false;
  forEachChild(node, (child) => {
    if (!found && containsJsx(child)) found = true;
  });
  return found;
}

function addImportBindings(program, imports) {
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const source = statement.source.value;
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportDefaultSpecifier") {
        imports.set(specifier.local.name, { imported: "default", source });
      } else if (specifier.type === "ImportNamespaceSpecifier") {
        imports.set(specifier.local.name, { imported: "*", source });
      } else if (specifier.type === "ImportSpecifier") {
        const imported =
          specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : specifier.imported.value;
        imports.set(specifier.local.name, { imported, source });
      }
    }
  }
}

function isReactCreateElement(node, imports) {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "React" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "createElement"
  ) {
    return true;
  }
  if (callee.type !== "Identifier") return false;
  const binding = imports.get(callee.name);
  return binding?.source === "react" && binding.imported === "createElement";
}

function analyzeFile(filePath) {
  const source = fs.readFileSync(filePath, "utf-8");
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });
  const imports = new Map();
  const componentNames = new Set();
  const componentUsages = [];
  const rawPrimitiveUsages = [];
  const localRoots = new Set();

  addImportBindings(ast.program, imports);

  function visit(node) {
    if (
      node.type === "FunctionDeclaration" &&
      node.id?.type === "Identifier" &&
      /^[A-Z]/.test(node.id.name) &&
      containsJsx(node.body)
    ) {
      localRoots.add(node.id.name);
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      /^[A-Z]/.test(node.id.name) &&
      node.init &&
      containsJsx(node.init)
    ) {
      localRoots.add(node.id.name);
    }

    if (node.type === "JSXOpeningElement") {
      const name = jsxTagNameText(node.name);
      const line = lineOf(node);
      if (/^[a-z]/.test(name)) {
        rawPrimitiveUsages.push({ name, kind: "jsx", line });
        const role = jsxRoleValue(node.attributes);
        if (role) rawPrimitiveUsages.push({ name: role, kind: "role", line });
      } else {
        componentNames.add(name);
        componentUsages.push({
          name,
          line,
          attributes: collectJsxAttributes(node.attributes),
          spreadLines: node.attributes
            .filter((attribute) => attribute.type === "JSXSpreadAttribute")
            .map(lineOf),
        });
      }
    }

    if (isReactCreateElement(node, imports)) {
      const [firstArgument] = node.arguments;
      if (firstArgument?.type === "StringLiteral") {
        rawPrimitiveUsages.push({
          name: firstArgument.value,
          kind: "createElement",
          line: lineOf(node),
        });
      }
      if (firstArgument?.type === "Identifier") componentNames.add(firstArgument.name);
    }

    forEachChild(node, visit);
  }

  visit(ast.program);
  return {
    imports,
    componentNames,
    componentUsages,
    rawPrimitiveUsages,
    localRoots: Array.from(localRoots),
  };
}

const reactAdapter = {
  id: "react",
  fileExtensions: [".tsx", ".jsx"],
  analyzeFile,
  isAllowedComponentAttribute(attributeName) {
    return (
      alwaysAllowedAttributes.has(attributeName) ||
      attributeName.startsWith("data-") ||
      attributeName.startsWith("aria-") ||
      (attributeName.startsWith("on") && attributeName.length > 2)
    );
  },
  isKnownPrimitive(componentName) {
    return Boolean(primitiveRawTags[componentName] || semanticRoleComponents[componentName]);
  },
  isRawPrimitiveUsage(usage, componentName) {
    return [
      ...(primitiveRawTags[componentName] ?? []),
      ...(semanticRoleComponents[componentName] ?? []),
    ].includes(usage.name);
  },
  formatRawPrimitiveUsage(usage) {
    if (usage.kind === "role") return `role="${usage.name}" at line ${usage.line}`;
    if (usage.kind === "createElement") {
      return `React.createElement("${usage.name}") at line ${usage.line}`;
    }
    return `<${usage.name}> at line ${usage.line}`;
  },
  replacementImportSource(classification) {
    return classification === "ui-icon" ? "lucide-react" : "@icons-pack/react-simple-icons";
  },
};

export { reactAdapter };
