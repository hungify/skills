// Figma auto-names each variant member of a component set "Prop1=Value1, Prop2=Value2, ...".
// componentPropertyDefinitions lives on the COMPONENT_SET parent only — a COMPONENT matching
// this pattern with 0 properties is almost always a variant member fetched by mistake.
const VARIANT_MEMBER_NAME_PATTERN = /^([^,=]+=[^,=]+)(,\s*[^,=]+=[^,=]+)*$/;

function looksLikeVariantMemberName(name) {
  return VARIANT_MEMBER_NAME_PATTERN.test(name.trim());
}

function collectComponents(node, acc) {
  if (!node) return;
  const nodeType = node.type;
  if (nodeType === 'COMPONENT' || nodeType === 'COMPONENT_SET') {
    acc.push({
      name: node.name,
      figmaNodeId: node.id,
      type: nodeType,
      propertyDefinitions: node.componentPropertyDefinitions ?? {},
    });
    return;
  }
  for (const child of node.children || []) {
    collectComponents(child, acc);
  }
}
export { collectComponents, looksLikeVariantMemberName };
