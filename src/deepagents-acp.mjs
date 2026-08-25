import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

import { evidenceRefs } from "./complexity-gate.mjs";

function parseObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Deep Agents ACP returned no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

function filterEvidenceItems(items, allowedRefs) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    const refs = item?.evidenceRefs;
    return item && typeof item === "object" && Array.isArray(refs) && refs.length > 0 && refs.every((ref) => allowedRefs.has(ref));
  });
}

export async function runDeepAgentsAcp(config, task, input, candidateReceipt, workspace, env = process.env) {
  const server = env.JUCHANG_DEEPAGENTS_ACP_SERVER?.trim() || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "acp", "juchang_acp.py");
  if (!fs.existsSync(server)) throw new Error("Deep Agents ACP server is missing");
  const innerHome = path.join(workspace, ".dsh-deepagents");
  fs.mkdirSync(innerHome, { recursive: true });
  const child = spawn(env.JUCHANG_DEEPAGENTS_PYTHON?.trim() || "python3", [server], {
    cwd: workspace,
    env: {
      ...env,
      AGENTTEAMS_AI_GATEWAY_URL: config.gatewayUrl,
      AGENTTEAMS_WORKER_GATEWAY_KEY: config.gatewayKey,
      JUCHANG_DSH_MODEL: config.model,
      JUCHANG_DSH_NODE: env.JUCHANG_DSH_NODE?.trim() || process.execPath,
      JUCHANG_DSH_BIN: env.JUCHANG_DSH_BIN,
      JUCHANG_DSH_MODEL_PATCH: env.JUCHANG_DSH_PATCH?.trim() || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "profiles", "worker.patch.yml"),
      JUCHANG_DSH_INNER_HOME: innerHome,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let assistantText = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
  const connection = new ClientSideConnection(
    () => ({
      sessionUpdate(params) {
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") assistantText += update.content.text;
        return Promise.resolve();
      },
      requestPermission() { return Promise.resolve({ outcome: { outcome: "cancelled" } }); },
    }),
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );
  try {
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await connection.newSession({ cwd: workspace, mcpServers: [] });
    const result = await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: JSON.stringify({ task, evidence: input, candidateReceipt }) }],
    });
    if (result.stopReason !== "end_turn") throw new Error(`Deep Agents ACP stopped with ${result.stopReason}`);
    const deepReceipt = parseObject(assistantText);
    const allowedRefs = evidenceRefs(input);
    return {
      projectId: task.projectId,
      taskId: task.taskId,
      role: task.role,
      conclusion: deepReceipt.status === "blocked" ? "BLOCKED" : "HUMAN_REVIEW",
      analysis: { deepAgentsAcp: true, nextAction: deepReceipt.nextAction || "人工复核复杂证据。" },
      facts: filterEvidenceItems(deepReceipt.facts, allowedRefs),
      conflicts: filterEvidenceItems(deepReceipt.conflicts, allowedRefs),
      unknownFields: Array.isArray(deepReceipt.unknownFields) ? deepReceipt.unknownFields.filter((item) => typeof item === "string") : [],
      external_write_count: 0,
      safetyCounters: { productionWrites: 0, publicPublishes: 0, realRefunds: 0, externalMessages: 0 },
      runtime: { harness: "dsh", deepAgents: "acp", model: config.model },
    };
  } finally {
    child.stdin.end();
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    if (exitCode !== 0) throw new Error(`Deep Agents ACP exited ${exitCode}: ${stderr.trim()}`);
  }
}
