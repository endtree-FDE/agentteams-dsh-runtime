function collectRefs(value, refs = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => collectRefs(item, refs));
  else if (value && typeof value === "object") {
    if (typeof value.ref === "string" && value.ref.trim()) refs.add(value.ref.trim().split("#", 1)[0]);
    Object.values(value).forEach((item) => collectRefs(item, refs));
  }
  return refs;
}

export function assessDeepAgentsNeed(task, input) {
  if (task.role !== "evidence_guard") return Object.freeze({ useDeepAgents: false, reasons: [] });
  const complexity = input?.complexity && typeof input.complexity === "object" ? input.complexity : {};
  const sourceCount = Math.max(Number(complexity.independentSources) || 0, collectRefs(input).size);
  const modalities = new Set(Array.isArray(complexity.modalities) ? complexity.modalities.filter(Boolean) : []);
  const conflictCount = Math.max(Number(complexity.conflicts) || 0, Array.isArray(input?.conflicts) ? input.conflicts.length : 0);
  const branchCount = Number(complexity.branches) || 0;
  const reasons = [
    ...(sourceCount >= 3 ? ["three_or_more_sources"] : []),
    ...(modalities.size >= 2 ? ["mixed_modalities"] : []),
    ...(conflictCount > 0 ? ["evidence_conflict"] : []),
    ...(branchCount >= 2 ? ["parallel_research_branches"] : []),
    ...(complexity.resumeRequired === true ? ["resume_required"] : []),
  ];
  return Object.freeze({ useDeepAgents: reasons.length > 0, reasons, sourceCount });
}

export function evidenceRefs(value) {
  const refs = new Set();
  const visit = (item) => {
    if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") {
      if (typeof item.ref === "string" && item.ref.trim()) refs.add(item.ref.trim());
      Object.values(item).forEach(visit);
    }
  };
  visit(value);
  return refs;
}
