#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function readJson(filename, label) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error(`${label} is unreadable: ${error.message}`);
  }
}

const projectWorkspace = path.resolve(argument("--project-workspace"));
const outputPath = path.resolve(argument("--output"));
const model = argument("--model") || "MiniMax-M3";
const request = readJson(path.join(projectWorkspace, "request.json"), "request.json");
const result = readJson(path.join(projectWorkspace, "result.json"), "result.json");
const audit = readJson(path.join(projectWorkspace, "audit.json"), "audit.json");
if (request.schema !== "juchang-agentteams-dsh-project@1" || result.schema !== "juchang-agentteams-dsh-result@1") {
  throw new Error("project contracts are unsupported");
}
if (request.projectId !== result.projectId || result.status !== "completed" || result.leader?.status !== "READY_FOR_HUMAN_REVIEW") {
  throw new Error("project identity or terminal state is invalid");
}
if (result.workers?.length !== 4 || result.workers.some((worker) => worker.status !== "completed")) {
  throw new Error("four completed Worker results are required");
}
const operations = audit.events?.map((event) => event.operation) || [];
if (!operations.includes("complete_project") || operations.at(-1) !== "project_terminal_observed") {
  throw new Error("project terminal audit is incomplete");
}
const completedAt = result.completedAt;
const projection = {
  schema: "juchang-dsh-workbench-projection@1",
  generatedAt: new Date().toISOString(),
  source: {
    environment: "cloudstudio",
    readOnly: true,
    runtimeVersion: "0.4.0",
    deepAgentsVersion: "optional",
    acpVersion: "optional",
  },
  runtime: {
    connected: true,
    agentsRunning: 5,
    agentsExpected: 5,
    protocolStatus: "verified",
    modelStatus: "ready",
    modelProvider: "agentteams-gateway",
    model,
  },
  tasks: [{
    roomId: request.roomId,
    lastActivity: Date.parse(completedAt),
    taskId: request.projectId,
    sourceUrl: request.sourceUrl || "",
    sourceTitle: request.title,
    sourceAuthor: request.sourceAuthor || "来源待核",
    sourceHash: request.sourceHash || request.projectId,
    intakeKind: request.intakeKind === "ambiguous" ? "unknown" : request.intakeKind,
    state: "ready_for_human_review",
    projectStatus: "completed",
    approvalState: "HUMAN_REVIEW",
    resultCount: 5,
    resultExcerpt: "四份材料核对已完成，等待人工决定。",
    workflowStatus: "verified",
    workflowIssues: [],
    workflowNodes: result.workers.map((worker) => ({
      id: worker.taskId,
      role: worker.role.replaceAll("_", "-"),
      status: worker.conclusion,
      dependsOn: request.tasks.find((task) => task.taskId === worker.taskId)?.dependsOn || [],
      resultPresent: true,
      completedAt,
    })),
  }],
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const temporary = `${outputPath}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
fs.renameSync(temporary, outputPath);
process.stdout.write(`${JSON.stringify({ marker: "JUCHANG_DSH_EDITOR_PROJECTION_READY", projectId: request.projectId, outputPath })}\n`);
