#!/usr/bin/env node

import { runLeaderLoop } from "../src/leader-bridge.mjs";
import { loadRuntimeConfig } from "../src/runtime-config.mjs";

const index = process.argv.indexOf("--config");
const filename = index >= 0 ? process.argv[index + 1] : "";
if (!filename) {
  process.stderr.write("Usage: node bin/leader.mjs --config /path/to/runtime.yaml\n");
  process.exit(2);
}

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  const config = loadRuntimeConfig(filename);
  if (config.agentRole !== "leader") throw new Error("member.role must be team_leader");
  process.stdout.write(`${JSON.stringify({ marker: "AGENTTEAMS_DSH_LEADER_READY", name: config.name, model: config.model })}\n`);
  await runLeaderLoop(config, { signal: controller.signal });
} catch (error) {
  process.stderr.write(`${JSON.stringify({ marker: "AGENTTEAMS_DSH_LEADER_FAILED", error: error.message })}\n`);
  process.exit(1);
}
