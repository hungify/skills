const FRAMEWORK_INTERNAL_PROPS = new Set(['key', 'ref']);

function isAccessibilityPassthroughProp(name) {
  return /^aria-/.test(name);
}

function isFunctionLikeType(type) {
  const text = String(type ?? '');
  return (
    text.includes('=>') ||
    /(?:Function|Handler|Callback|Listener)\b/.test(text)
  );
}

function isConfirmedEventProp(name, prop, eventNames = new Set()) {
  if (eventNames.has(name)) return true;
  return /^on[A-Z:]/.test(name) && isFunctionLikeType(prop?.type);
}

function classifyMappingProp(name, prop, options = {}) {
  const rawProp = options.rawProps?.[name] ?? prop;
  if (rawProp?.global === true || options.globalPropNames?.has(name)) {
    return { classification: 'excluded', reason: 'framework-global' };
  }
  if (FRAMEWORK_INTERNAL_PROPS.has(name)) {
    return { classification: 'excluded', reason: 'framework-internal' };
  }
  if (options.excludeAccessibilityPassthrough && isAccessibilityPassthroughProp(name)) {
    return { classification: 'excluded', reason: 'accessibility-passthrough' };
  }
  if (isConfirmedEventProp(name, rawProp, options.eventNames)) {
    return { classification: 'excluded', reason: 'confirmed-event-callback' };
  }
  return { classification: 'candidate' };
}

function projectMappingCandidateProps(props, options = {}) {
  return Object.fromEntries(
    Object.entries(props ?? {}).filter(
      ([name, prop]) =>
        classifyMappingProp(name, prop, options).classification !== 'excluded',
    ),
  );
}

export {
  FRAMEWORK_INTERNAL_PROPS,
  classifyMappingProp,
  isAccessibilityPassthroughProp,
  isConfirmedEventProp,
  isFunctionLikeType,
  projectMappingCandidateProps,
};
