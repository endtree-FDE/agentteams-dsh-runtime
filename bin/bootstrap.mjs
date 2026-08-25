#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { runLeaderLoop } from "../src/leader-bridge.mjs";
import { runManagerLoop } from "../src/manager-bridge.mjs";
import { loadManagerConfig } from "../src/manager-config.mjs";
import { loadRuntimeConfig } from "../src/runtime-config.mjs";
import { runWorkerLoop } from "../src/worker-bridge.mjs";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function mc(args, allowFailure = false) {
  const result = spawnSync("mc", args, { encoding: "utf8", timeout: 30_000 });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(result.error?.message || result.stderr.trim() || `mc ${args[0]} failed`);
  }
  return result;
}

function pullRuntimeConfig(workspaceRoot) {
  const endpoint = requiredEnv("AGENTTEAMS_FS_ENDPOINT");
  const accessKey = requiredEnv("AGENTTEAMS_FS_ACCESS_KEY");
  const secretKey = requiredEnv("AGENTTEAMS_FS_SECRET_KEY");
  const workerName = requiredEnv("AGENTTEAMS_WORKER_NAME");
  const bucket = process.env.AGENTTEAMS_FS_BUCKET?.trim() || "agentteams-storage";
  const storagePrefix = process.env.AGENTTEAMS_STORAGE_PREFIX?.trim().replace(/\/$/, "") || `agentteams/${bucket}`;
  mc(["alias", "set", "agentteams", endpoint, accessKey, secretKey]);
  const remotePrefix = storagePrefix.includes("/") ? storagePrefix : `agentteams/${bucket}`;
  const remote = `${remotePrefix}/agents/${workerName}/runtime/runtime.yaml`;
  const runtimePath = path.join(workspaceRoot, "runtime.yaml");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = mc(["cp", remote, runtimePath], true);
    if (result.status === 0 && fs.existsSync(runtimePath)) return runtimePath;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
  }
  throw new Error(`runtime config did not appear at ${remote}`);
}

const workspaceRoot = path.resolve(process.env.AGENTTEAMS_WORKSPACE_DIR?.trim() || "/workspace");
fs.mkdirSync(path.join(workspaceRoot, "shared"), { recursive: true });
process.env.AGENTTEAMS_WORKSPACE_DIR = workspaceRoot;
process.env.AGENTTEAMS_SHARED_DIR = path.join(workspaceRoot, "shared");
process.env.AGENTTEAMS_TEAMHARNESS_SERVER ||= "/opt/agentteams/teamharness/mcp/server.py";
process.env.AGENTTEAMS_PYTHON_BIN ||= "python3";
process.env.JUCHANG_DSH_BIN ||= "/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  if (process.env.AGENTTEAMS_MANAGER_RUNTIME?.trim() === "dsh") {
    const config = loadManagerConfig();
    process.stdout.write(`${JSON.stringify({ marker: "AGENTTEAMS_DSH_MANAGER_READY", name: config.name, model: config.model })}\n`);
    await runManagerLoop(config, { signal: controller.signal });
    process.exit(0);
  }
  const runtimePath = pullRuntimeConfig(workspaceRoot);
  const config = loadRuntimeConfig(runtimePath);
  const marker = config.agentRole === "leader" ? "AGENTTEAMS_DSH_LEADER_READY" : "AGENTTEAMS_DSH_WORKER_READY";
  process.stdout.write(`${JSON.stringify({ marker, name: config.name, runtimeName: config.runtimeName, role: config.role, model: config.model })}\n`);
  if (config.agentRole === "leader") await runLeaderLoop(config, { signal: controller.signal });
  else await runWorkerLoop(config, { signal: controller.signal });
} catch (error) {
  process.stderr.write(`${JSON.stringify({ marker: "AGENTTEAMS_DSH_RUNTIME_FAILED", error: error.message })}\n`);
  process.exit(1);
}
