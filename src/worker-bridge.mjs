import fs from "node:fs";
import path from "node:path";

import { createArtifactStore } from "./artifact-store.mjs";
import { assessDeepAgentsNeed } from "./complexity-gate.mjs";
import { runDeepAgentsAcp } from "./deepagents-acp.mjs";
import { runDsh, validateReceipt, validateTaskEnvelope } from "./dsh-runner.mjs";
import { listAssignments, sendMatrixText, syncMatrix } from "./matrix-client.mjs";
import { resolveSharedPath } from "./runtime-config.mjs";
import { startTeamHarness } from "./teamharness-client.mjs";

function writeAtomic(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(`${filename}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(`${filename}.tmp`, filename);
}

export async function executeAssignment(config, assignment, options = {}) {
  const task = validateTaskEnvelope(config, assignment.envelope);
  const teamHarness = options.teamHarness;
  if (!teamHarness) throw new Error("TeamHarness client is required");
  const acknowledged = await teamHarness.callTaskflow(config, "ack_task", { taskId: task.taskId });
  if (acknowledged.ok !== true || acknowledged.task?.status !== "in_progress") {
    throw new Error(`TeamHarness ack_task failed: ${acknowledged.error || "task did not enter in_progress"}`);
  }
  const artifacts = options.artifacts || createArtifactStore(config, options.env);
  artifacts.ensureLocal(task.inputPath);
  const inputPath = resolveSharedPath(config, task.inputPath, "inputPath");
  const workspace = resolveSharedPath(config, task.workspacePath, "workspacePath");
  if (!fs.statSync(inputPath).isFile()) throw new Error("inputPath must be a file");
  fs.mkdirSync(workspace, { recursive: true });
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  let receipt;
  try {
    receipt = await (options.runDsh || runDsh)(config, task, input, workspace, options.env);
    const complexity = (options.assessDeepAgents || assessDeepAgentsNeed)(task, input);
    if (complexity.useDeepAgents && options.deepAgentsEnabled !== false) {
      receipt = await (options.runDeepAgents || runDeepAgentsAcp)(config, task, input, receipt, workspace, options.env);
      const deepErrors = validateReceipt(receipt, task);
      if (deepErrors.length) throw new Error(`Deep Agents receipt invalid: ${deepErrors.join("; ")}`);
      receipt.runtime = { ...receipt.runtime, complexityReasons: complexity.reasons };
    }
  } catch (error) {
    const summary = `DSH execution blocked: ${String(error.message || error).replace(/[\r\n]+/g, " ").slice(0, 240)}`;
    const submitted = await teamHarness.callTaskflow(config, "submit_task", {
      taskId: task.taskId,
      status: "BLOCKED",
      summary,
      deliverables: [],
    });
    if (submitted.ok !== true) throw new Error(`TeamHarness BLOCKED submission failed: ${submitted.error || "unknown error"}`);
    await (options.sendText || sendMatrixText)(
      config,
      assignment.roomId,
      `${config.leaderMatrixUserId} TASK_COMPLETED: ${task.taskId} - BLOCKED: ${summary}`,
      [config.leaderMatrixUserId],
    );
    return { task, blocked: true, summary };
  }
  const receiptPath = path.join(workspace, "receipt.json");
  writeAtomic(receiptPath, receipt);
  const relativeReceipt = path.relative(config.sharedRoot, receiptPath).replaceAll("\\", "/");
  artifacts.push(relativeReceipt);
  const deliverable = `shared/${relativeReceipt}`;
  const status = receipt.conclusion === "BLOCKED" ? "BLOCKED" : "SUCCESS_WITH_NOTES";
  const summary = `${task.role} produced a zero-write DSH receipt for Leader review (${receipt.conclusion}).`;
  const submitted = await teamHarness.callTaskflow(config, "submit_task", {
    taskId: task.taskId,
    status,
    summary,
    deliverables: [deliverable],
  });
  if (submitted.ok !== true || submitted.task?.status !== "submitted") {
    throw new Error(`TeamHarness submit_task failed: ${submitted.error || "task did not enter submitted"}`);
  }
  await (options.sendText || sendMatrixText)(
    config,
    assignment.roomId,
    `${config.leaderMatrixUserId} TASK_COMPLETED: ${task.taskId} - Result: ${deliverable}`,
    [config.leaderMatrixUserId],
  );
  return { task, receiptPath, receipt, submitted };
}

export async function runWorkerLoop(config, options = {}) {
  let since = "";
  const seen = new Set();
  const ownsTeamHarness = !options.teamHarness;
  const teamHarness = options.teamHarness || await (options.startTeamHarness || startTeamHarness)(config);
  try {
    while (!options.signal?.aborted) {
      const response = await (options.sync || syncMatrix)(config, since, 30_000);
      since = response.next_batch || since;
      for (const assignment of listAssignments(config, response)) {
        if (!assignment.eventId || seen.has(assignment.eventId)) continue;
        seen.add(assignment.eventId);
        try {
          await executeAssignment(config, assignment, { ...options, teamHarness });
        } catch (error) {
          await (options.sendText || sendMatrixText)(
            config,
            assignment.roomId,
            `JUCHANG_DSH_TASK_RESULT: BLOCKED\nerror: ${String(error.message || error).replace(/[\r\n]+/g, " ").slice(0, 240)}`,
          );
        }
      }
    }
  } finally {
    if (ownsTeamHarness) teamHarness.close();
  }
}
