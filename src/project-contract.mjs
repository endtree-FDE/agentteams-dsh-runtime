const roleOrder = Object.freeze(["material_intake", "evidence_guard", "entity_matcher", "approval_guard"]);
const dependencyIndexes = Object.freeze([[], [0], [0], [1, 2]]);

function safeId(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) throw new Error(`${label} is missing or unsafe`);
  return text;
}

export function validateProjectEnvelope(config, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("project envelope must be an object");
  if (value.schema !== "juchang-agentteams-dsh-project@1") throw new Error("unsupported project envelope");
  if (config.agentRole !== "leader") throw new Error("project envelope requires Team Leader runtime");
  if (value.publicWriteAllowed !== false) throw new Error("project must deny public writes");
  const projectId = safeId(value.dispatchId, "dispatchId");
  if (!/^![^:\s]+:.+$/.test(value.roomId || "")) throw new Error("roomId must be a Matrix room id");
  if (!Array.isArray(value.tasks) || value.tasks.length !== roleOrder.length) throw new Error("project requires exactly four tasks");
  const tasks = value.tasks.map((task, index) => {
    const taskId = `${projectId}-${String(index + 1).padStart(2, "0")}`;
    const role = roleOrder[index];
    if (task?.taskId !== taskId) throw new Error(`task ${index + 1} must use ${taskId}`);
    if (task?.role !== role) throw new Error(`task ${index + 1} role must be ${role}`);
    const binding = config.roleBindings?.[role];
    if (!binding) throw new Error(`runtime role binding is missing: ${role}`);
    if (task.assignedTo !== binding.matrixUserId) throw new Error(`task ${index + 1} assignedTo is not the configured Worker`);
    const expectedDependencies = dependencyIndexes[index].map((dependencyIndex) => `${projectId}-${String(dependencyIndex + 1).padStart(2, "0")}`);
    if (JSON.stringify(task.dependsOn || []) !== JSON.stringify(expectedDependencies)) {
      throw new Error(`task ${index + 1} dependencies are invalid`);
    }
    return Object.freeze({
      taskId,
      role,
      title: typeof task.title === "string" && task.title.trim() ? task.title.trim() : `${role} review`,
      assignedTo: binding.matrixUserId,
      dependsOn: expectedDependencies,
    });
  });
  return Object.freeze({
    schema: value.schema,
    projectId,
    projectRef: safeId(value.projectRef, "projectRef"),
    title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : projectId,
    sourceUrl: typeof value.sourceUrl === "string" ? value.sourceUrl.trim() : "",
    sourceAuthor: typeof value.sourceAuthor === "string" ? value.sourceAuthor.trim() : "",
    sourceHash: typeof value.sourceHash === "string" ? value.sourceHash.trim() : "",
    intakeKind: ["new_event", "change", "retrospective", "ambiguous"].includes(value.intakeKind) ? value.intakeKind : "ambiguous",
    roomId: value.roomId,
    inputPath: String(value.inputPath || ""),
    publicWriteAllowed: false,
    tasks,
  });
}

export function taskRole(taskId, projectId) {
  const index = roleOrder.findIndex((_role, candidate) => taskId === `${projectId}-${String(candidate + 1).padStart(2, "0")}`);
  if (index < 0) throw new Error("taskId is outside the four-role project");
  return roleOrder[index];
}

export { dependencyIndexes, roleOrder };
