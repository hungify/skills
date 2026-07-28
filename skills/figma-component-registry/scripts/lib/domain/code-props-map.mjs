function bindingCodePropNames(figmaBindings) {
  const names = [];
  const seen = new Set();
  for (const binding of figmaBindings ?? []) {
    const candidates =
      binding.mappingKind === 'direct'
        ? [binding.prop]
        : binding.mappingKind === 'bundle'
          ? binding.props
          : [];
    for (const name of candidates ?? []) {
      if (typeof name !== 'string' || name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function toCodePropsMap(props, figmaBindings) {
  const out = {};
  for (const name of bindingCodePropNames(figmaBindings)) {
    const def = props?.[name];
    if (!def) {
      throw new Error(`figma binding references missing code prop "${name}"`);
    }
    const values = def.values?.map(String);
    if (values?.length) {
      out[name] = { type: 'enum', values };
    } else if (def.type === 'boolean' || def.type === 'Boolean') {
      out[name] = { type: 'boolean' };
    } else {
      out[name] = { type: String(def.type ?? 'unknown') };
    }
  }
  return out;
}
export { bindingCodePropNames, toCodePropsMap };
