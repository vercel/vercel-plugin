// hooks/src/routing-decision-causality.mts
function sortUnknown(value) {
  if (Array.isArray(value)) {
    return value.map(sortUnknown);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const input = value;
  const output = {};
  for (const key of Object.keys(input).sort()) {
    output[key] = sortUnknown(input[key]);
  }
  return output;
}
function causeKey(cause) {
  return [cause.skill, cause.stage, cause.code, cause.message].join("\0");
}
function edgeKey(edge) {
  return [edge.fromSkill, edge.toSkill, String(edge.relation), edge.code].join(
    "\0"
  );
}
function createDecisionCausality() {
  return { causes: [], edges: [] };
}
function addCause(store, cause) {
  store.causes.push({
    ...cause,
    detail: sortUnknown(cause.detail)
  });
  store.causes.sort(
    (left, right) => causeKey(left).localeCompare(causeKey(right))
  );
}
function addEdge(store, edge) {
  store.edges.push({
    ...edge,
    detail: sortUnknown(edge.detail)
  });
  store.edges.sort(
    (left, right) => edgeKey(left).localeCompare(edgeKey(right))
  );
}
function causesForSkill(store, skill) {
  return store.causes.filter((cause) => cause.skill === skill);
}
export {
  addCause,
  addEdge,
  causesForSkill,
  createDecisionCausality
};
