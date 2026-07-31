function stripFigmaPropId(figmaProp) {
  return String(figmaProp).replace(/#\d+:\d+$/, '');
}

function bindingPath({ componentPath, groupName, figmaProp }) {
  return `${componentPath} > ${groupName} > ${stripFigmaPropId(figmaProp)}`;
}
export { stripFigmaPropId, bindingPath };
