import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseReceipt, validateReceipt, validateTaskEnvelope } from "../src/dsh-runner.mjs";
import { listAssignments, listLeaderEvents, listManagerEvents, parseProjectEnvelope, parseTaskCompletion, parseTaskEnvelope } from "../src/matrix-client.mjs";
import { loadRuntimeConfig, resolveSharedPath } from "../src/runtime-config.mjs";
import { executeAssignment } from "../src/worker-bridge.mjs";
import { startTeamHarness } from "../src/teamharness-client.mjs";
import { acceptTask, completeProject, startProject } from "../src/leader-runtime.mjs";
import { validateProjectEnvelope } from "../src/project-contract.mjs";
import { createControllerClient } from "../src/controller-client.mjs";
import { handleManagerMessage } from "../src/manager-bridge.mjs";
import { loadManagerConfig } from "../src/manager-config.mjs";
import { confirmationFromText, createManagerPlanStore, validateManagerPlan } from "../src/manager-runtime.mjs";
import { assessDeepAgentsNeed } from "../src/complexity-gate.mjs";
import { createArtifactStore } from "../src/artifact-store.mjs";
import { createSupervisorSessionStore } from "../src/supervisor-session-store.mjs";
import { CASE_COMMAND_PREFIX, CASE_DECISION_PREFIX, parseSupervisorCommand, validateSupervisorResult } from "../src/supervisor-runtime.mjs";

const fakeTeamHarnessServer = path.resolve("tests/fixtures/fake-teamharness.mjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentteams-dsh-runtime-"));
  const shared = path.join(root, "shared");
  fs.mkdirSync(path.join(shared, "tasks", "cloud_case-02", "workspace"), { recursive: true });
  fs.writeFileSync(path.join(shared, "tasks", "cloud_case-02", "workspace", "input.json"), JSON.stringify({ evidence: [{ ref: "source-1", text: "活动延期" }] }));
  const runtimePath = path.join(root, "runtime.yaml");
  fs.writeFileSync(runtimePath, `
apiVersion: agentteams.io/v1beta1
kind: MemberRuntimeConfig
member:
  name: evidence-guard
  runtimeName: evidence-guard
  role: evidence_guard
  runtime: dsh
  matrixUserId: "@evidence-guard:matrix.test"
team:
  name: juchang-team
  leaderRuntimeName: juchang-lead
  members:
    - name: juchang-lead
      runtimeName: juchang-lead
      role: leader
      runtime: dsh
      matrixUserId: "@juchang-lead:matrix.test"
desired:
  model:
    providerId: agentteams-gateway
    model: step-test
    gatewayUrl: "http://gateway.test"
credentials:
  matrixTokenEnv: AGENTTEAMS_WORKER_MATRIX_TOKEN
  gatewayKeyEnv: AGENTTEAMS_WORKER_GATEWAY_KEY
`);
  const env = {
    AGENTTEAMS_MATRIX_URL: "http://matrix.test",
    AGENTTEAMS_SHARED_DIR: shared,
    AGENTTEAMS_WORKER_MATRIX_TOKEN: "matrix-test-token",
    AGENTTEAMS_WORKER_GATEWAY_KEY: "gateway-test-token",
    AGENTTEAMS_TEAMHARNESS_SERVER: fakeTeamHarnessServer,
    AGENTTEAMS_PYTHON_BIN: process.execPath,
  };
  return { root, shared, runtimePath, env };
}

function leaderFixture() {
  const value = fixture();
  const runtime = fs.readFileSync(value.runtimePath, "utf8")
    .replace("name: evidence-guard", "name: juchang-lead")
    .replace("runtimeName: evidence-guard", "runtimeName: juchang-lead")
    .replace("role: evidence_guard", "role: team_leader")
    .replace("@evidence-guard:matrix.test", "@juchang-lead:matrix.test");
  fs.writeFileSync(value.runtimePath, `${runtime}\njuchang:\n  roleBindings:\n    material_intake:\n      runtimeName: material-intake\n      matrixUserId: \"@material-intake:matrix.test\"\n    evidence_guard:\n      runtimeName: evidence-guard\n      matrixUserId: \"@evidence-guard:matrix.test\"\n    entity_matcher:\n      runtimeName: entity-matcher\n      matrixUserId: \"@entity-matcher:matrix.test\"\n    approval_guard:\n      runtimeName: approval-guard\n      matrixUserId: \"@approval-guard:matrix.test\"\n`);
  const projectId = "cloud_change_1";
  const inputPath = `projects/${projectId}/workspace/input.json`;
  fs.mkdirSync(path.dirname(path.join(value.shared, inputPath)), { recursive: true });
  fs.writeFileSync(path.join(value.shared, inputPath), JSON.stringify({ evidenceRefs: ["source-1"] }));
  const config = loadRuntimeConfig(value.runtimePath, value.env);
  const roles = ["material_intake", "evidence_guard", "entity_matcher", "approval_guard"];
  const workers = ["material-intake", "evidence-guard", "entity-matcher", "approval-guard"];
  const dependencies = [[], [0], [0], [1, 2]];
  const envelope = {
    schema: "juchang-agentteams-dsh-project@1",
    dispatchId: projectId,
    projectRef: "zhuantang-yixun",
    title: "Activity change review",
    roomId: "!task:matrix.test",
    inputPath,
    publicWriteAllowed: false,
    tasks: roles.map((role, index) => ({
      taskId: `${projectId}-${String(index + 1).padStart(2, "0")}`,
      role,
      assignedTo: `@${workers[index]}:matrix.test`,
      dependsOn: dependencies[index].map((candidate) => `${projectId}-${String(candidate + 1).padStart(2, "0")}`),
    })),
  };
  return { ...value, config, envelope, projectId };
}

function managerFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentteams-dsh-manager-"));
  const env = {
    AGENTTEAMS_MANAGER_NAME: "default",
    AGENTTEAMS_MANAGER_RUNTIME: "dsh",
    AGENTTEAMS_MANAGER_MATRIX_TOKEN: "manager-matrix-token",
    AGENTTEAMS_MANAGER_GATEWAY_KEY: "manager-gateway-token",
    AGENTTEAMS_MANAGER_ROOM_ID: "!manager:matrix.test",
    AGENTTEAMS_MATRIX_DOMAIN: "matrix.test",
    AGENTTEAMS_MATRIX_URL: "http://matrix.test",
    AGENTTEAMS_ADMIN_USER: "admin",
    AGENTTEAMS_AI_GATEWAY_URL: "http://gateway.test",
    AGENTTEAMS_CONTROLLER_URL: "http://controller.test",
    AGENTTEAMS_DEFAULT_MODEL: "MiniMax-M3",
    AGENTTEAMS_WORKSPACE_DIR: root,
    JUCHANG_MANAGER_STATE_DIR: path.join(root, "manager-state"),
    JUCHANG_DSH_WORKER_IMAGE: "juchang/runtime:test",
  };
  return { root, env, config: loadManagerConfig(env) };
}

test("runtime config reads AgentTeams identity and env-referenced credentials", () => {
  const value = fixture();
  const config = loadRuntimeConfig(value.runtimePath, value.env);
  assert.equal(config.role, "evidence_guard");
  assert.equal(config.matrixToken, "matrix-test-token");
  assert.equal(config.gatewayKey, "gateway-test-token");
  assert.equal(config.leaderMatrixUserId, "@juchang-lead:matrix.test");
  assert.equal(resolveSharedPath(config, "tasks/cloud_case-02/workspace", "workspace"), path.join(value.shared, "tasks", "cloud_case-02", "workspace"));
  assert.throws(() => resolveSharedPath(config, "../escape", "workspace"), /safe relative path/);
});

test("artifact store maps shared receipts to the AgentTeams MinIO plane", () => {
  const value = fixture();
  const calls = [];
  const store = createArtifactStore({ sharedRoot: value.shared }, {
    AGENTTEAMS_FS_ENDPOINT: "http://minio.test",
    AGENTTEAMS_FS_ACCESS_KEY: "access",
    AGENTTEAMS_FS_SECRET_KEY: "secret",
    AGENTTEAMS_FS_BUCKET: "agentteams-storage",
  }, { run: (args) => { calls.push(args); return { status: 0, stderr: "" }; } });
  const relative = "tasks/cloud_case-02/workspace/receipt.json";
  fs.writeFileSync(path.join(value.shared, relative), "{}\n");
  assert.equal(store.push(relative), `agentteams/agentteams-storage/juchang-dsh/shared/${relative}`);
  assert.deepEqual(calls.map((args) => args[0]), ["alias", "cp"]);
  assert.throws(() => store.push("../escape.json"), /safe relative path/);
});

test("Matrix accepts only an exact Worker mention plus a valid task envelope", () => {
  const value = fixture();
  const config = loadRuntimeConfig(value.runtimePath, value.env);
  const envelope = { schema: "juchang-agentteams-dsh-task@1", projectId: "cloud_case", taskId: "cloud_case-02", role: "evidence_guard", inputPath: "tasks/cloud_case-02/workspace/input.json", workspacePath: "tasks/cloud_case-02/workspace", publicWriteAllowed: false };
  const body = `@evidence-guard:matrix.test\nJUCHANG_DSH_TASK: ${JSON.stringify(envelope)}`;
  assert.deepEqual(parseTaskEnvelope(body), envelope);
  const assignments = listAssignments(config, { rooms: { join: { "!room:matrix.test": { timeline: { events: [{ type: "m.room.message", event_id: "$event", sender: "@leader:matrix.test", content: { body, "m.mentions": { user_ids: [config.matrixUserId] } } }] } } } } });
  assert.equal(assignments.length, 1);
  assert.deepEqual(validateTaskEnvelope(config, assignments[0].envelope), envelope);
});

test("receipt guard rejects authority drift and accepts a zero-write result", () => {
  const task = { projectId: "cloud_case", taskId: "cloud_case-02", role: "evidence_guard" };
  const receipt = { ...task, conclusion: "HUMAN_REVIEW", facts: [], conflicts: [], unknownFields: ["replacement_date"], external_write_count: 0, safetyCounters: { productionWrites: 0, publicPublishes: 0, realRefunds: 0, externalMessages: 0 } };
  assert.deepEqual(validateReceipt(receipt, task), []);
  assert.equal(parseReceipt(`\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\``).taskId, task.taskId);
  assert.match(validateReceipt({ ...receipt, external_write_count: 1 }, task).join(" "), /must be 0/);
});

test("TeamHarness stdio client verifies the required official tool surface", async () => {
  const value = fixture();
  const config = loadRuntimeConfig(value.runtimePath, value.env);
  const client = await startTeamHarness(config, { env: value.env });
  assert.deepEqual(await client.call("health", {}), { ok: true, tool: "health", status: "ok" });
  client.close();
});

test("external Worker acknowledges, runs DSH, submits, then mentions Leader", async () => {
  const value = fixture();
  const config = loadRuntimeConfig(value.runtimePath, value.env);
  const envelope = { schema: "juchang-agentteams-dsh-task@1", projectId: "cloud_case", taskId: "cloud_case-02", role: "evidence_guard", inputPath: "tasks/cloud_case-02/workspace/input.json", workspacePath: "tasks/cloud_case-02/workspace", publicWriteAllowed: false };
  const sent = [];
  const calls = [];
  const artifactCalls = [];
  const receipt = { projectId: "cloud_case", taskId: "cloud_case-02", role: "evidence_guard", conclusion: "HUMAN_REVIEW", facts: [], conflicts: [], unknownFields: ["replacement_date"], external_write_count: 0, safetyCounters: { productionWrites: 0, publicPublishes: 0, realRefunds: 0, externalMessages: 0 } };
  const result = await executeAssignment(config, { roomId: "!room:matrix.test", envelope }, {
    artifacts: {
      ensureLocal: (relative) => artifactCalls.push(["pull", relative]),
      push: (relative) => artifactCalls.push(["push", relative]),
    },
    teamHarness: {
      callTaskflow: async (_config, action, payload) => {
        calls.push({ action, payload });
        if (action === "ack_task") return { ok: true, task: { status: "in_progress" } };
        return { ok: true, task: { status: "submitted" } };
      },
    },
    runDsh: async () => { calls.push({ action: "run_dsh" }); return receipt; },
    sendText: async (_config, roomId, body, mentions) => sent.push({ roomId, body, mentions }),
  });
  assert.equal(JSON.parse(fs.readFileSync(result.receiptPath, "utf8")).taskId, envelope.taskId);
  assert.deepEqual(calls.map((item) => item.action), ["ack_task", "run_dsh", "submit_task"]);
  assert.deepEqual(artifactCalls, [
    ["pull", "tasks/cloud_case-02/workspace/input.json"],
    ["push", "tasks/cloud_case-02/workspace/receipt.json"],
  ]);
  assert.equal(calls[2].payload.status, "SUCCESS_WITH_NOTES");
  assert.deepEqual(calls[2].payload.deliverables, ["shared/tasks/cloud_case-02/workspace/receipt.json"]);
  assert.match(sent[0].body, /@juchang-lead:matrix\.test TASK_COMPLETED/);
  assert.deepEqual(sent[0].mentions, ["@juchang-lead:matrix.test"]);
});

test("DSH failure is submitted as an authoritative BLOCKED task result", async () => {
  const value = fixture();
  const config = loadRuntimeConfig(value.runtimePath, value.env);
  const envelope = { schema: "juchang-agentteams-dsh-task@1", projectId: "cloud_case", taskId: "cloud_case-02", role: "evidence_guard", inputPath: "tasks/cloud_case-02/workspace/input.json", workspacePath: "tasks/cloud_case-02/workspace", publicWriteAllowed: false };
  const calls = [];
  const sent = [];
  const result = await executeAssignment(config, { roomId: "!room:matrix.test", envelope }, {
    teamHarness: {
      callTaskflow: async (_config, action, payload) => {
        calls.push({ action, payload });
        if (action === "ack_task") return { ok: true, task: { status: "in_progress" } };
        return { ok: true, task: { status: "submitted" } };
      },
    },
    runDsh: async () => { throw new Error("model unavailable"); },
    sendText: async (_config, roomId, body, mentions) => sent.push({ roomId, body, mentions }),
  });
  assert.equal(result.blocked, true);
  assert.equal(calls[1].action, "submit_task");
  assert.equal(calls[1].payload.status, "BLOCKED");
  assert.match(sent[0].body, /TASK_COMPLETED.*BLOCKED/);
});

test("Leader project contract fixes four roles, owners, and dependency shape", () => {
  const value = leaderFixture();
  const validated = validateProjectEnvelope(value.config, value.envelope);
  assert.deepEqual(validated.tasks.map((task) => task.dependsOn.length), [0, 1, 1, 2]);
  assert.throws(() => validateProjectEnvelope(value.config, { ...value.envelope, publicWriteAllowed: true }), /deny public writes/);
  const changed = structuredClone(value.envelope);
  changed.tasks[3].dependsOn = [changed.tasks[0].taskId];
  assert.throws(() => validateProjectEnvelope(value.config, changed), /dependencies are invalid/);
});

test("DSH Team Leader creates the authoritative DAG and delegates only its first ready node", async () => {
  const value = leaderFixture();
  const calls = [];
  const plannedTasks = value.envelope.tasks.map((task) => ({ task_id: task.taskId, title: task.title || task.role, assigned_to: task.assignedTo, depends_on: task.dependsOn, status: "planned" }));
  const teamHarness = {
    callProjectflow: async (_config, action, payload) => {
      calls.push({ tool: "projectflow", action, payload });
      if (action === "create_project") return { ok: true, project: { project_id: value.projectId, status: "active", tasks: [] } };
      return { ok: true, project: { project_id: value.projectId, status: "active", tasks: plannedTasks }, readyNodes: [plannedTasks[0]] };
    },
    callTaskflow: async (_config, action, payload) => {
      calls.push({ tool: "taskflow", action, payload });
      return { ok: true, task: { task_id: payload.taskId, status: "assigned", eventId: "$assigned" }, synced: true, notification: { sent: true } };
    },
  };
  const started = await startProject(value.config, value.envelope, teamHarness);
  assert.deepEqual(started.delegated, [`${value.projectId}-01`]);
  assert.deepEqual(calls.map((call) => call.action), ["create_project", "plan_dag", "delegate_task"]);
  assert.match(calls[2].payload.spec, /^JUCHANG_DSH_TASK: /);
});

test("Leader accepts only an effective zero-write receipt, then delegates newly ready nodes", async () => {
  const value = leaderFixture();
  const task1 = `${value.projectId}-01`;
  const plannedTasks = value.envelope.tasks.map((task) => ({ task_id: task.taskId, title: task.role, assigned_to: task.assignedTo, depends_on: task.dependsOn, status: "planned" }));
  const setupHarness = {
    callProjectflow: async (_config, action) => action === "create_project"
      ? { ok: true, project: { project_id: value.projectId, status: "active", tasks: [] } }
      : { ok: true, project: { project_id: value.projectId, status: "active", tasks: plannedTasks }, readyNodes: [plannedTasks[0]] },
    callTaskflow: async (_config, _action, payload) => ({ ok: true, task: { task_id: payload.taskId, status: "assigned", eventId: "$assigned" }, synced: true, notification: { sent: true } }),
  };
  await startProject(value.config, value.envelope, setupHarness);
  const receipt = { projectId: value.projectId, taskId: task1, role: "material_intake", conclusion: "SUCCESS_WITH_NOTES", facts: [], conflicts: [], unknownFields: [], external_write_count: 0, safetyCounters: { productionWrites: 0, publicPublishes: 0, realRefunds: 0, externalMessages: 0 } };
  const receiptPath = path.join(value.shared, "tasks", task1, "workspace", "receipt.json");
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  const calls = [];
  const completedTasks = plannedTasks.map((task, index) => ({ ...task, status: index === 0 ? "completed" : "planned" }));
  const teamHarness = {
    callTaskflow: async (_config, action, payload) => {
      calls.push({ tool: "taskflow", action, payload });
      if (action === "check_task") return { ok: true, task: { project_id: value.projectId, task_id: task1, status: "submitted" }, effective: true, validationErrors: [], result: { status: "SUCCESS_WITH_NOTES", summary: "intake done", deliverables: [`shared/tasks/${task1}/workspace/receipt.json`] } };
      return { ok: true, task: { task_id: payload.taskId, status: "assigned", eventId: `$${payload.taskId}` }, synced: true, notification: { sent: true } };
    },
    callProjectflow: async (_config, action, payload) => {
      calls.push({ tool: "projectflow", action, payload });
      if (action === "accept_task_result") return { ok: true, accepted: true, nodeStatus: "completed", project: { project_id: value.projectId, status: "active", tasks: completedTasks } };
      return { ok: true, project: { project_id: value.projectId, status: "active", tasks: completedTasks }, readyNodes: [completedTasks[1], completedTasks[2]] };
    },
  };
  const accepted = await acceptTask(value.config, value.projectId, task1, teamHarness);
  assert.deepEqual(accepted.delegated, [`${value.projectId}-02`, `${value.projectId}-03`]);
  assert.deepEqual(calls.map((call) => call.action), ["check_task", "accept_task_result", "ready_nodes", "delegate_task", "delegate_task"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(value.shared, "tasks", `${value.projectId}-02`, "workspace", "input.json"), "utf8")).upstreamReceipts[0].taskId, task1);
});

test("Matrix Leader surface accepts exact project and completion events", () => {
  const value = leaderFixture();
  const projectBody = `${value.config.matrixUserId}\nJUCHANG_DSH_PROJECT: ${JSON.stringify(value.envelope)}`;
  assert.equal(parseProjectEnvelope(projectBody).dispatchId, value.projectId);
  assert.equal(parseTaskCompletion(`@juchang-lead:matrix.test TASK_COMPLETED: ${value.projectId}-01 - Result: x`).taskId, `${value.projectId}-01`);
  const events = listLeaderEvents(value.config, { rooms: { join: { "!task:matrix.test": { timeline: { events: [
    { type: "m.room.message", event_id: "$project", sender: "@admin:matrix.test", content: { body: projectBody, "m.mentions": { user_ids: [value.config.matrixUserId] } } },
    { type: "m.room.message", event_id: "$done", sender: "@material-intake:matrix.test", content: { body: `@juchang-lead:matrix.test TASK_COMPLETED: ${value.projectId}-01`, "m.mentions": { user_ids: [value.config.matrixUserId] } } },
  ] } } } } });
  assert.deepEqual(events.map((event) => event.kind), ["project", "completion"]);
});

test("Leader completes only after four audited terminal tasks and emits HUMAN_REVIEW", async () => {
  const value = leaderFixture();
  const plannedTasks = value.envelope.tasks.map((task) => ({ task_id: task.taskId, title: task.role, assigned_to: task.assignedTo, depends_on: task.dependsOn, status: "planned" }));
  const setupHarness = {
    callProjectflow: async (_config, action) => action === "create_project"
      ? { ok: true, project: { project_id: value.projectId, status: "active", tasks: [] } }
      : { ok: true, project: { project_id: value.projectId, status: "active", tasks: plannedTasks }, readyNodes: [plannedTasks[0]] },
    callTaskflow: async (_config, _action, payload) => ({ ok: true, task: { task_id: payload.taskId, status: "assigned", eventId: "$assigned" }, synced: true, notification: { sent: true } }),
  };
  await startProject(value.config, value.envelope, setupHarness);
  const projectWorkspace = path.join(value.shared, "projects", value.projectId, "workspace");
  const auditPath = path.join(projectWorkspace, "audit.json");
  const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
  for (const task of value.envelope.tasks) {
    for (const operation of ["check_task", "accept_task_result", "task_terminal_observed"]) {
      audit.events.push({ sequence: audit.events.length + 1, at: new Date().toISOString(), operation, taskId: task.taskId, success: true, ...(operation === "task_terminal_observed" ? { status: "completed" } : {}) });
    }
    const receiptPath = path.join(value.shared, "tasks", task.taskId, "workspace", "receipt.json");
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, JSON.stringify({ projectId: value.projectId, taskId: task.taskId, role: task.role, conclusion: "SUCCESS_WITH_NOTES", facts: [], conflicts: [], unknownFields: [], external_write_count: 0, safetyCounters: { productionWrites: 0, publicPublishes: 0, realRefunds: 0, externalMessages: 0 } }));
  }
  fs.writeFileSync(auditPath, JSON.stringify(audit));
  const completedTasks = plannedTasks.map((task) => ({ ...task, status: "completed" }));
  let reads = 0;
  const teamHarness = {
    callProjectflow: async (_config, action) => {
      if (action === "complete_project") return { ok: true, project: { project_id: value.projectId, status: "completed", tasks: completedTasks } };
      reads += 1;
      return { ok: true, project: { project_id: value.projectId, status: reads > 1 ? "completed" : "active", tasks: completedTasks }, readyNodes: [] };
    },
  };
  const leaderReceipt = { projectId: value.projectId, taskId: `${value.projectId}-leader`, role: "team_leader", conclusion: "HUMAN_REVIEW", facts: [], conflicts: [], unknownFields: [], external_write_count: 0, safetyCounters: { productionWrites: 0, publicPublishes: 0, realRefunds: 0, externalMessages: 0 } };
  const result = await completeProject(value.config, value.projectId, teamHarness, { runDsh: async () => leaderReceipt });
  assert.equal(result.leader.status, "READY_FOR_HUMAN_REVIEW");
  assert.deepEqual(result.counters, { productionWrites: 0, publicPublishes: 0, realRefunds: 0, externalMessages: 0 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(projectWorkspace, "result.json"), "utf8")).status, "completed");
  const projectionPath = path.join(value.root, "editor", "current.json");
  const built = spawnSync(process.execPath, [
    path.resolve("scripts/build-editor-projection.mjs"),
    "--project-workspace", projectWorkspace,
    "--output", projectionPath,
    "--model", "MiniMax-M3",
  ], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const projection = JSON.parse(fs.readFileSync(projectionPath, "utf8"));
  assert.equal(projection.runtime.agentsRunning, 5);
  assert.equal(projection.tasks[0].state, "ready_for_human_review");
});

test("DSH Manager config binds one Manager room and one exact Admin identity", () => {
  const value = managerFixture();
  assert.equal(value.config.matrixUserId, "@manager:matrix.test");
  assert.equal(value.config.adminMatrixUserId, "@admin:matrix.test");
  assert.equal(value.config.planRoot, path.join(value.root, "manager-state"));
  const events = listManagerEvents(value.config, { rooms: { join: {
    "!manager:matrix.test": { timeline: { events: [
      { type: "m.room.message", event_id: "$admin", sender: "@admin:matrix.test", content: { body: "list workers" } },
      { type: "m.room.message", event_id: "$other", sender: "@other:matrix.test", content: { body: "delete everything" } },
    ] } },
    "!other:matrix.test": { timeline: { events: [{ type: "m.room.message", event_id: "$wrong-room", sender: "@admin:matrix.test", content: { body: "create worker" } }] } },
  } } });
  assert.deepEqual(events.map((event) => event.eventId), ["$admin"]);
});

test("Manager plan fixes DSH runtime and strips arbitrary images and secret env", () => {
  const value = managerFixture();
  const plan = validateManagerPlan(value.config, {
    schema: "agentteams-dsh-manager-plan@1",
    action: "create_worker",
    resourceName: "Research-One",
    request: {
      model: "MiniMax-M3",
      image: "evil/image:latest",
      runtime: "openclaw",
      env: { JUCHANG_DSH_ROLE: "evidence_guard", AGENTTEAMS_AUTH_TOKEN: "should-not-pass" },
    },
    summary: "Create an evidence Worker",
  });
  assert.equal(plan.resourceName, "research-one");
  assert.equal(plan.request.runtime, "dsh");
  assert.equal(plan.request.image, "juchang/runtime:test");
  assert.deepEqual(plan.request.env, { JUCHANG_DSH_ROLE: "evidence_guard" });
  assert.equal(plan.status, "pending_confirmation");
});

test("Controller client never returns credential-shaped fields to Matrix", async () => {
  const value = managerFixture();
  const client = createControllerClient(value.env, async () => new Response(JSON.stringify({
    workers: [{ name: "safe", token: "hidden", spec: { env: { API_KEY: "hidden" }, model: "MiniMax-M3" } }],
  }), { status: 200 }));
  const result = await client.request("GET", "/api/v1/workers");
  assert.deepEqual(result, { workers: [{ name: "safe", spec: { model: "MiniMax-M3" } }] });
});

test("Manager mutation executes once only after exact Admin confirmation", async () => {
  const value = managerFixture();
  const sent = [];
  const requests = [];
  const store = createManagerPlanStore(value.config.planRoot);
  const controller = { request: async (method, pathname, body) => { requests.push({ method, pathname, body }); return { accepted: true }; } };
  const event = { roomId: value.config.managerRoomId, body: "Create evidence worker" };
  const prepared = await handleManagerMessage(value.config, event, {
    store,
    controller,
    plan: async () => ({ schema: "agentteams-dsh-manager-plan@1", action: "create_worker", resourceName: "evidence-one", request: { model: "MiniMax-M3", env: { JUCHANG_DSH_ROLE: "evidence_guard" } }, summary: "Create evidence worker" }),
    sendText: async (_config, roomId, body) => sent.push({ roomId, body }),
  });
  assert.equal(requests.length, 0);
  assert.match(sent[0].body, /MANAGER_PLAN_READY/);
  assert.deepEqual(confirmationFromText(`MANAGER_CONFIRM: ${prepared.plan.planId}`), { planId: prepared.plan.planId, destructiveConfirmed: false });
  await handleManagerMessage(value.config, { roomId: value.config.managerRoomId, body: `MANAGER_CONFIRM: ${prepared.plan.planId}` }, { store, controller, sendText: async () => {} });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, "/api/v1/workers");
  const repeated = await handleManagerMessage(value.config, { roomId: value.config.managerRoomId, body: `MANAGER_CONFIRM: ${prepared.plan.planId}` }, { store, controller, sendText: async () => {} });
  assert.equal(repeated.repeated, true);
  assert.equal(requests.length, 1);
});

test("destructive Manager plan requires the explicit DELETE confirmation suffix", async () => {
  const value = managerFixture();
  const store = createManagerPlanStore(value.config.planRoot);
  const plan = store.save(validateManagerPlan(value.config, { schema: "agentteams-dsh-manager-plan@1", action: "delete_team", resourceName: "old-team", request: {}, summary: "Delete old team" }));
  await assert.rejects(
    () => handleManagerMessage(value.config, { roomId: value.config.managerRoomId, body: `MANAGER_CONFIRM: ${plan.planId}` }, { store, controller: { request: async () => ({}) }, sendText: async () => {} }),
    /DELETE/,
  );
});

test("business Supervisor keeps one durable DSH session across management turns", async () => {
  const value = managerFixture();
  const supervisorStore = createSupervisorSessionStore(value.config.supervisorStateRoot, () => Date.parse("2026-08-25T12:00:00Z"));
  const sent = [];
  const observedSessions = [];
  const command = (commandId, text) => `${CASE_COMMAND_PREFIX}${JSON.stringify({
    schema: "juchang-case-command@1",
    commandId,
    threadId: "operator-thread-01",
    text,
    context: {
      roomId: "!task:matrix.test",
      taskId: "wechat-intake-123456abcdef",
      sourceUrl: "https://example.test/source",
      sourceTitle: "Activity notice",
      sourceAuthor: "Official account",
      intakeKind: "change",
      taskState: "ready_for_human_review",
      projectStatus: "completed",
      approvalState: "needs_human_review",
      resultExcerpt: "Four receipts are complete.",
      workflowNodes: [],
      safetyCounters: { productionWrites: 0, publicPublishes: 0, realRefunds: 0, externalMessages: 0 },
    },
  })}`;
  const runTurn = async (_config, thread) => {
    observedSessions.push({ sessionId: thread.sessionId, created: thread.sessionCreated });
    return { schema: "juchang-case-supervisor-turn@1", action: "status", message: "四个责任位均已完成，等待人工复核。", teamInstruction: "", approval: null };
  };
  const sendText = async (_config, roomId, body) => sent.push({ roomId, body });

  await handleManagerMessage(value.config, { roomId: value.config.managerRoomId, body: command("11111111-1111-4111-8111-111111111111", "现在做到哪了") }, { supervisorStore, runTurn, sendText });
  await handleManagerMessage(value.config, { roomId: value.config.managerRoomId, body: command("22222222-2222-4222-8222-222222222222", "解释当前结论") }, { supervisorStore, runTurn, sendText });

  assert.equal(observedSessions.length, 2);
  assert.equal(observedSessions[0].sessionId, observedSessions[1].sessionId);
  assert.deepEqual(observedSessions.map((item) => item.created), [false, true]);
  assert.equal(supervisorStore.read("operator-thread-01").turns.length, 2);
  assert.equal(sent.filter((item) => item.body.includes("JUCHANG_CASE_RESULT")).length, 2);
});

test("business Supervisor creates an approval card and resolves it once", async () => {
  const value = managerFixture();
  const supervisorStore = createSupervisorSessionStore(value.config.supervisorStateRoot);
  const sent = [];
  const commandId = "33333333-3333-4333-8333-333333333333";
  const body = `${CASE_COMMAND_PREFIX}${JSON.stringify({
    schema: "juchang-case-command@1",
    commandId,
    threadId: "operator-thread-02",
    text: "把当前任务归档",
    context: {
      roomId: "!task:matrix.test",
      taskId: "wechat-intake-123456abcdef",
      sourceUrl: "https://example.test/source",
      sourceTitle: "Activity notice",
      sourceAuthor: "Official account",
      intakeKind: "change",
      taskState: "ready_for_human_review",
      projectStatus: "completed",
      approvalState: "needs_human_review",
      resultExcerpt: "Four receipts are complete.",
      workflowNodes: [],
      safetyCounters: { productionWrites: 0, publicPublishes: 0, realRefunds: 0, externalMessages: 0 },
    },
  })}`;
  await handleManagerMessage(value.config, { roomId: value.config.managerRoomId, body }, {
    supervisorStore,
    runTurn: async () => ({
      schema: "juchang-case-supervisor-turn@1",
      action: "approval_required",
      message: "归档会改变工作队列，需要你确认。",
      teamInstruction: "",
      approval: { action: "archive", summary: "归档当前任务", reason: "四份收据已齐并等待人工处置。" },
    }),
    sendText: async (_config, roomId, text) => sent.push({ roomId, body: text }),
  });
  const approval = supervisorStore.read("operator-thread-02").approvals[0];
  assert.equal(approval.status, "pending");

  const decision = `${CASE_DECISION_PREFIX}${JSON.stringify({
    schema: "juchang-case-decision@1",
    threadId: "operator-thread-02",
    approvalId: approval.approvalId,
    decision: "approve",
    note: "确认归档",
  })}`;
  await handleManagerMessage(value.config, { roomId: value.config.managerRoomId, body: decision }, {
    supervisorStore,
    sendText: async (_config, roomId, text) => sent.push({ roomId, body: text }),
  });
  assert.equal(supervisorStore.read("operator-thread-02").approvals[0].status, "approved");
  assert.match(sent.at(-1).body, /juchang-case-approval-resolution@1/);
});

test("Supervisor result cannot invent an approval target or unsupported action", () => {
  const command = parseSupervisorCommand(`${CASE_COMMAND_PREFIX}${JSON.stringify({
    schema: "juchang-case-command@1",
    commandId: "44444444-4444-4444-8444-444444444444",
    threadId: "operator-thread-03",
    text: "delete everything",
    context: {},
  })}`);
  assert.throws(() => validateSupervisorResult({ schema: "juchang-case-supervisor-turn@1", action: "approval_required", message: "delete", approval: { action: "delete_team" } }, command), /unsupported/);
  assert.throws(() => validateSupervisorResult({ schema: "juchang-case-supervisor-turn@1", action: "approval_required", message: "archive", approval: { action: "archive" } }, command), /target is missing/);
});

test("Supervisor answers expose only exact facts from the current case context", () => {
  const command = parseSupervisorCommand(`${CASE_COMMAND_PREFIX}${JSON.stringify({
    schema: "juchang-case-command@1",
    commandId: "45454545-4545-4545-8545-454545454545",
    threadId: "operator-thread-04",
    text: "为什么冲突",
    context: { resultExcerpt: "补演日期缺失，退款状态存在冲突，等待人工复核。" },
  })}`);
  const grounded = validateSupervisorResult({
    schema: "juchang-case-supervisor-turn@1",
    action: "answer",
    message: "模型补充的猜测不得显示。",
    groundedFacts: ["退款状态存在冲突", "材料中不存在的原因"],
    teamInstruction: "",
    approval: null,
  }, command);
  assert.equal(grounded.action, "answer");
  assert.equal(grounded.message, "退款状态存在冲突");
  const ungrounded = validateSupervisorResult({
    schema: "juchang-case-supervisor-turn@1",
    action: "answer",
    message: "可能是票种差异。",
    groundedFacts: [],
    teamInstruction: "",
    approval: null,
  }, command);
  assert.equal(ungrounded.action, "clarify");
  assert.match(ungrounded.message, /材料不足/);
});

test("Supervisor patch gives Cordis Loader a fixed string plugin path", () => {
  const patch = fs.readFileSync("profiles/supervisor.patch.yml", "utf8");
  assert.match(patch, /name: \/opt\/agentteams-dsh-runtime\/dsh-plugins\/resumable-headless\.mjs/);
  assert.doesNotMatch(patch, /name:\s*!!js/);
});

test("resumable runner setup does not return the model-selection disposer", () => {
  const source = fs.readFileSync("dsh-plugins/resumable-headless.mjs", "utf8");
  assert.match(source, /const setup = \(agentCtx\) => \{\s*installModelSelection/);
  assert.doesNotMatch(source, /=>\s*installModelSelection\(/);
});

test("Leader materializes a bounded inline Supervisor input before planning the DAG", async () => {
  const value = leaderFixture();
  const envelope = { ...value.envelope, inputPath: undefined, inputPayload: { instruction: "Read only", evidenceRefs: ["official-source"] } };
  const plannedTasks = envelope.tasks.map((task, index) => ({ task_id: task.taskId, title: task.title, assigned_to: task.assignedTo, depends_on: task.dependsOn, status: index === 0 ? "ready" : "pending" }));
  const calls = [];
  const teamHarness = {
    callProjectflow: async (_config, action) => {
      calls.push(action);
      if (action === "create_project") return { ok: true, project: { project_id: value.projectId, status: "active" } };
      if (action === "plan_dag") return { ok: true, project: { project_id: value.projectId, status: "active", tasks: plannedTasks }, readyNodes: [plannedTasks[0]] };
      throw new Error(`unexpected ${action}`);
    },
    callTaskflow: async () => ({ ok: true, task: { status: "assigned", eventId: "$task" }, synced: true, notification: { sent: true } }),
  };
  await startProject(value.config, envelope, teamHarness, { artifacts: { ensureLocal() {}, push() {} } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(value.shared, `projects/${value.projectId}/workspace/input.json`), "utf8")), envelope.inputPayload);
  assert.deepEqual(calls, ["create_project", "plan_dag"]);
});

test("Deep Agents gate is evidence-role-only and deterministic", () => {
  const complexInput = { evidence: [{ ref: "source-a" }, { ref: "source-b" }, { ref: "source-c" }], complexity: { modalities: ["web", "pdf"] } };
  const evidenceDecision = assessDeepAgentsNeed({ role: "evidence_guard" }, complexInput);
  assert.equal(evidenceDecision.useDeepAgents, true);
  assert.deepEqual(evidenceDecision.reasons, ["three_or_more_sources", "mixed_modalities"]);
  assert.equal(assessDeepAgentsNeed({ role: "material_intake" }, complexInput).useDeepAgents, false);
});

test("complex Evidence Guard task invokes Deep Agents ACP before authoritative submit", async () => {
  const value = fixture();
  const config = loadRuntimeConfig(value.runtimePath, value.env);
  const inputPath = path.join(value.shared, "tasks", "cloud_case-02", "workspace", "input.json");
  fs.writeFileSync(inputPath, JSON.stringify({ evidence: [{ ref: "source-a" }, { ref: "source-b" }, { ref: "source-c" }] }));
  const envelope = { schema: "juchang-agentteams-dsh-task@1", projectId: "cloud_case", taskId: "cloud_case-02", role: "evidence_guard", inputPath: "tasks/cloud_case-02/workspace/input.json", workspacePath: "tasks/cloud_case-02/workspace", publicWriteAllowed: false };
  const calls = [];
  const teamHarness = { callTaskflow: async (_config, action) => action === "ack_task" ? { ok: true, task: { status: "in_progress" } } : { ok: true, task: { status: "submitted" } } };
  const baseReceipt = { projectId: "cloud_case", taskId: "cloud_case-02", role: "evidence_guard", conclusion: "SUCCESS_WITH_NOTES", facts: [], conflicts: [], unknownFields: [], external_write_count: 0, safetyCounters: { productionWrites: 0, publicPublishes: 0, realRefunds: 0, externalMessages: 0 } };
  const result = await executeAssignment(config, { roomId: "!room:matrix.test", envelope }, {
    teamHarness,
    runDsh: async () => { calls.push("dsh"); return baseReceipt; },
    runDeepAgents: async () => { calls.push("deepagents-acp"); return { ...baseReceipt, conclusion: "HUMAN_REVIEW", runtime: { harness: "dsh", deepAgents: "acp" } }; },
    sendText: async () => {},
  });
  assert.deepEqual(calls, ["dsh", "deepagents-acp"]);
  assert.equal(result.receipt.runtime.deepAgents, "acp");
  assert.deepEqual(result.receipt.runtime.complexityReasons, ["three_or_more_sources"]);
});

test("Deep Agents ACP failure closes the AgentTeams task as BLOCKED", async () => {
  const value = fixture();
  const config = loadRuntimeConfig(value.runtimePath, value.env);
  fs.writeFileSync(path.join(value.shared, "tasks", "cloud_case-02", "workspace", "input.json"), JSON.stringify({ complexity: { conflicts: 1 } }));
  const envelope = { schema: "juchang-agentteams-dsh-task@1", projectId: "cloud_case", taskId: "cloud_case-02", role: "evidence_guard", inputPath: "tasks/cloud_case-02/workspace/input.json", workspacePath: "tasks/cloud_case-02/workspace", publicWriteAllowed: false };
  const submitted = [];
  const result = await executeAssignment(config, { roomId: "!room:matrix.test", envelope }, {
    teamHarness: { callTaskflow: async (_config, action, payload) => { if (action === "submit_task") submitted.push(payload); return action === "ack_task" ? { ok: true, task: { status: "in_progress" } } : { ok: true, task: { status: "submitted" } }; } },
    runDsh: async () => ({ projectId: "cloud_case", taskId: "cloud_case-02", role: "evidence_guard", conclusion: "SUCCESS_WITH_NOTES", facts: [], conflicts: [], unknownFields: [], external_write_count: 0, safetyCounters: { productionWrites: 0, publicPublishes: 0, realRefunds: 0, externalMessages: 0 } }),
    runDeepAgents: async () => { throw new Error("ACP unavailable"); },
    sendText: async () => {},
  });
  assert.equal(result.blocked, true);
  assert.equal(submitted[0].status, "BLOCKED");
});
