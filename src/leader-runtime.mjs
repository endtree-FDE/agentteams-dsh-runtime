import fs from "node:fs";
import path from "node:path";

import { createArtifactStore } from "./artifact-store.mjs";
import { runDsh, validateReceipt } from "./dsh-runner.mjs";
import { taskRole, validateProjectEnvelope } from "./project-contract.mjs";
import { resolveSharedPath } from "./runtime-config.mjs";

function writeAtomic(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, filename);
}

function projectTask(project, taskId) {
  return (project?.tasks || []).find((task) => task?.task_id === taskId);
}

function requireOk(response, label) {
  if (response?.ok !== true) throw new Error(`${label} failed: ${response?.error || "unknown error"}`);
  return response;
}

function projectWorkspace(config, projectId) {
  return resolveSharedPath(config, `projects/${projectId}/workspace`, "project workspace");
}

function readProjectRequest(config, projectId) {
  return JSON.parse(fs.readFileSync(path.join(projectWorkspace(config, projectId), "request.json"), "utf8"));
}

function auditPath(config, projectId) {
  return path.join(projectWorkspace(config, projectId), "audit.json");
}

function appendAudit(config, projectId, event) {
  const filename = auditPath(config, projectId);
  const current = fs.existsSync(filename)
    ? JSON.parse(fs.readFileSync(filename, "utf8"))
    : { schema: "juchang-dsh-authority-audit@1", projectId, events: [] };
  const next = {
    ...current,
    events: [...current.events, { sequence: current.events.length + 1, at: new Date().toISOString(), ...event }],
  };
  writeAtomic(filename, next);
  return next;
}

function workerInput(config, request, task, artifacts) {
  const inputPath = `tasks/${task.taskId}/workspace/input.json`;
  const filename = resolveSharedPath(config, inputPath, "downstream inputPath");
  if (task.dependsOn.length === 0) {
    artifacts.ensureLocal(request.inputPath);
    const source = resolveSharedPath(config, request.inputPath, "project inputPath");
    writeAtomic(filename, JSON.parse(fs.readFileSync(source, "utf8")));
    artifacts.push(inputPath);
    return inputPath;
  }
  const upstreamReceipts = task.dependsOn.map((dependency) => {
    const relative = `tasks/${dependency}/workspace/receipt.json`;
    artifacts.ensureLocal(relative);
    const receiptPath = resolveSharedPath(config, relative, "dependency receipt");
    return JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  });
  writeAtomic(filename, { projectId: request.projectId, taskId: task.taskId, upstreamReceipts });
  artifacts.push(inputPath);
  return inputPath;
}

function taskSpec(config, request, task, artifacts) {
  const envelope = {
    schema: "juchang-agentteams-dsh-task@1",
    projectId: request.projectId,
    taskId: task.taskId,
    role: task.role,
    inputPath: workerInput(config, request, task, artifacts),
    workspacePath: `tasks/${task.taskId}/workspace`,
    publicWriteAllowed: false,
  };
  const envelopeLine = `JUCHANG_DSH_TASK: ${JSON.stringify(envelope)}`;
  if (envelopeLine.length > 480) throw new Error("task envelope exceeds TeamHarness notification preview boundary");
  return [
    envelopeLine,
    "",
    `# ${task.title}`,
    "Read the exact task envelope above. Use the official Taskflow lifecycle exposed by the DSH runtime.",
    `After submit_task succeeds, mention ${config.matrixUserId} with TASK_COMPLETED: ${task.taskId}.`,
    "Never approve, publish, refund, send external messages, or write production data.",
  ].join("\n");
}

async function delegateReady(config, request, projectResponse, teamHarness, artifacts) {
  const ready = projectResponse.readyNodes || [];
  const delegated = [];
  for (const node of ready) {
    const task = request.tasks.find((candidate) => candidate.taskId === node.task_id);
    if (!task) throw new Error(`ready node is outside request: ${node.task_id}`);
    const response = requireOk(await teamHarness.callTaskflow(config, "delegate_task", {
      projectId: request.projectId,
      taskId: task.taskId,
      assignedTo: task.assignedTo,
      roomId: request.roomId,
      title: task.title,
      spec: taskSpec(config, request, task, artifacts),
    }), "delegate_task");
    if (response.task?.status !== "assigned" || response.synced !== true || response.notification?.sent !== true) {
      throw new Error(`delegate_task did not prove assigned, synced, and notified: ${task.taskId}`);
    }
    delegated.push(task.taskId);
    appendAudit(config, request.projectId, { operation: "delegate_task", taskId: task.taskId, success: true, eventId: response.task.eventId });
  }
  return delegated;
}

export async function startProject(config, envelope, teamHarness, options = {}) {
  const request = validateProjectEnvelope(config, envelope);
  const artifacts = options.artifacts || createArtifactStore(config, options.env);
  const inputFilename = resolveSharedPath(config, request.inputPath, "project inputPath");
  if (request.inputPayload) {
    writeAtomic(inputFilename, request.inputPayload);
    artifacts.push(request.inputPath);
  } else {
    artifacts.ensureLocal(request.inputPath);
    artifacts.push(request.inputPath);
  }
  const workspace = projectWorkspace(config, request.projectId);
  fs.mkdirSync(workspace, { recursive: true });
  writeAtomic(path.join(workspace, "request.json"), request);
  writeAtomic(auditPath(config, request.projectId), { schema: "juchang-dsh-authority-audit@1", projectId: request.projectId, events: [] });
  const created = requireOk(await teamHarness.callProjectflow(config, "create_project", {
    projectId: request.projectId,
    title: request.title,
    source: "juchang-editor",
    requester: config.matrixUserId,
  }), "create_project");
  if (created.project?.project_id !== request.projectId || created.project?.status !== "active") throw new Error("create_project identity readback failed");
  appendAudit(config, request.projectId, { operation: "create_project", success: true });
  const planned = requireOk(await teamHarness.callProjectflow(config, "plan_dag", {
    projectId: request.projectId,
    tasks: request.tasks.map((task) => ({ taskId: task.taskId, title: task.title, assignedTo: task.assignedTo, dependsOn: task.dependsOn })),
  }), "plan_dag");
  if (planned.project?.tasks?.length !== 4) throw new Error("plan_dag did not persist four tasks");
  appendAudit(config, request.projectId, { operation: "plan_dag", success: true });
  const delegated = await delegateReady(config, request, planned, teamHarness, artifacts);
  return { request, project: planned.project, delegated };
}

export async function acceptTask(config, projectId, taskId, teamHarness, options = {}) {
  const request = readProjectRequest(config, projectId);
  const artifacts = options.artifacts || createArtifactStore(config, options.env);
  const role = taskRole(taskId, projectId);
  const checked = requireOk(await teamHarness.callTaskflow(config, "check_task", { projectId, taskId }), "check_task");
  if (checked.effective !== true || checked.task?.status !== "submitted" || checked.validationErrors?.length !== 0) {
    throw new Error(`check_task is not effective: ${taskId}`);
  }
  const expectedDeliverable = `shared/tasks/${taskId}/workspace/receipt.json`;
  if (JSON.stringify(checked.result?.deliverables) !== JSON.stringify([expectedDeliverable])) {
    throw new Error(`check_task deliverables must equal ${expectedDeliverable}`);
  }
  artifacts.ensureLocal(expectedDeliverable.slice("shared/".length));
  const receipt = JSON.parse(fs.readFileSync(resolveSharedPath(config, expectedDeliverable.slice("shared/".length), "receipt"), "utf8"));
  const receiptErrors = validateReceipt(receipt, { projectId, taskId, role });
  if (receiptErrors.length) throw new Error(`receipt validation failed: ${receiptErrors.join("; ")}`);
  appendAudit(config, projectId, { operation: "check_task", taskId, success: true, effective: true });
  const accepted = requireOk(await teamHarness.callProjectflow(config, "accept_task_result", {
    projectId,
    taskId,
    resultStatus: checked.result.status,
    summary: checked.result.summary,
    accepted: true,
    publishArtifacts: false,
  }), "accept_task_result");
  if (accepted.accepted !== true || accepted.nodeStatus !== "completed" || projectTask(accepted.project, taskId)?.status !== "completed") {
    throw new Error(`accept_task_result did not complete ${taskId}`);
  }
  appendAudit(config, projectId, { operation: "accept_task_result", taskId, success: true, status: "completed" });
  const observed = requireOk(await teamHarness.callProjectflow(config, "ready_nodes", { projectId }), "ready_nodes");
  if (projectTask(observed.project, taskId)?.status !== "completed") throw new Error(`terminal readback failed: ${taskId}`);
  appendAudit(config, projectId, { operation: "task_terminal_observed", taskId, success: true, status: "completed" });
  const delegated = await delegateReady(config, request, observed, teamHarness, artifacts);
  return { project: observed.project, delegated, completed: observed.project.tasks.every((task) => task.status === "completed") };
}

function verifyCompletionAudit(config, projectId, request) {
  const audit = JSON.parse(fs.readFileSync(auditPath(config, projectId), "utf8"));
  for (const task of request.tasks) {
    const operations = audit.events.filter((event) => event.taskId === task.taskId).map((event) => event.operation);
    const tail = operations.slice(-3);
    if (JSON.stringify(tail) !== JSON.stringify(["check_task", "accept_task_result", "task_terminal_observed"])) {
      throw new Error(`authority audit is incomplete for ${task.taskId}`);
    }
  }
  return audit;
}

export async function completeProject(config, projectId, teamHarness, options = {}) {
  const request = readProjectRequest(config, projectId);
  const artifacts = options.artifacts || createArtifactStore(config, options.env);
  verifyCompletionAudit(config, projectId, request);
  const before = requireOk(await teamHarness.callProjectflow(config, "ready_nodes", { projectId }), "pre-complete ready_nodes");
  if (before.project?.status !== "active" || before.project?.tasks?.length !== 4 || before.project.tasks.some((task) => task.status !== "completed")) {
    throw new Error("all four Project tasks must be completed before complete_project");
  }
  const workerReceipts = request.tasks.map((task) => {
    const relative = `tasks/${task.taskId}/workspace/receipt.json`;
    artifacts.ensureLocal(relative);
    return JSON.parse(fs.readFileSync(resolveSharedPath(config, relative, "worker receipt"), "utf8"));
  });
  const leaderTask = { projectId, taskId: `${projectId}-leader`, role: "team_leader" };
  const leaderReceipt = await (options.runDsh || runDsh)(
    config,
    leaderTask,
    { projectRef: request.projectRef, workerReceipts, instruction: "Summarize candidate evidence for named human review only." },
    projectWorkspace(config, projectId),
    options.env,
  );
  writeAtomic(path.join(projectWorkspace(config, projectId), "leader-receipt.json"), leaderReceipt);
  artifacts.push(`projects/${projectId}/workspace/leader-receipt.json`);
  const completed = requireOk(await teamHarness.callProjectflow(config, "complete_project", { projectId, publishArtifacts: false }), "complete_project");
  if (completed.project?.status !== "completed") throw new Error("complete_project did not return completed");
  appendAudit(config, projectId, { operation: "complete_project", success: true, status: "completed" });
  const observed = requireOk(await teamHarness.callProjectflow(config, "ready_nodes", { projectId }), "project terminal readback");
  if (observed.project?.status !== "completed" || observed.project.tasks?.some((task) => task.status !== "completed")) {
    throw new Error("project terminal readback failed");
  }
  appendAudit(config, projectId, { operation: "project_terminal_observed", success: true, status: "completed" });
  const counters = workerReceipts.reduce((sum, receipt) => {
    for (const key of Object.keys(sum)) sum[key] += receipt.safetyCounters[key];
    return sum;
  }, { productionWrites: 0, publicPublishes: 0, realRefunds: 0, externalMessages: 0 });
  if (Object.values(counters).some((value) => value !== 0)) throw new Error("aggregate safety counters must remain zero");
  const result = {
    schema: "juchang-agentteams-dsh-result@1",
    projectId,
    projectRef: request.projectRef,
    status: "completed",
    workers: request.tasks.map((task, index) => ({ taskId: task.taskId, role: task.role, status: "completed", receipt: `shared/tasks/${task.taskId}/workspace/receipt.json`, conclusion: workerReceipts[index].conclusion })),
    leader: { status: "READY_FOR_HUMAN_REVIEW", receipt: `shared/projects/${projectId}/workspace/leader-receipt.json` },
    counters,
    completedAt: new Date().toISOString(),
  };
  writeAtomic(path.join(projectWorkspace(config, projectId), "result.json"), result);
  artifacts.push(`projects/${projectId}/workspace/result.json`);
  artifacts.push(`projects/${projectId}/workspace/audit.json`);
  return result;
}
