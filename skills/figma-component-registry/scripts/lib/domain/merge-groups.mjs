// Union by figmaNodeId: a group re-synced this cycle replaces its old entry in place;
// groups the current cycle never touched are carried forward instead of being dropped.
function mergeGroups(existingGroups, newGroups) {
  const newById = new Map(newGroups.map((group) => [group.figmaNodeId, group]));
  const merged = existingGroups.map((group) => newById.get(group.figmaNodeId) ?? group);
  const existingIds = new Set(existingGroups.map((group) => group.figmaNodeId));

  return [...merged, ...newGroups.filter((group) => !existingIds.has(group.figmaNodeId))];
}
export { mergeGroups };
