#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { startTeamHarness } from "../src/teamharness-client.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const server = path.resolve(argument("--server"));
const workspaceRoot = path.resolve(argument("--workspace"));
const sharedRoot = path.join(workspaceRoot, "shared");
if (!fs.statSync(server).isFile() || !fs.statSync(sharedRoot).isDirectory()) {
  process.stderr.write("Usage: node bin/probe-teamharness.mjs --server /path/to/server.py --workspace /path/to/workspace-with-shared\n");
  process.exit(2);
}

const config = {
  agentRole: "worker",
  matrixUrl: "http://matrix.invalid",
  matrixToken: "probe-only",
  matrixUserId: "@probe:matrix.invalid",
  runtimeName: "probe",
  workspaceRoot,
  sharedRoot,
  teamHarnessCommand: process.env.AGENTTEAMS_PYTHON_BIN?.trim() || "python3",
  teamHarnessServer: server,
};

try {
  const client = await startTeamHarness(config);
  const health = await client.call("health", {});
  client.close();
  process.stdout.write(`${JSON.stringify({ marker: "OFFICIAL_TEAMHARNESS_READY", server, health })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ marker: "OFFICIAL_TEAMHARNESS_FAILED", error: error.message })}\n`);
  process.exit(1);
}
