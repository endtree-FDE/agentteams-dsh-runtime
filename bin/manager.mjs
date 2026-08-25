#!/usr/bin/env node

import { runManagerLoop } from "../src/manager-bridge.mjs";
import { loadManagerConfig } from "../src/manager-config.mjs";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  const config = loadManagerConfig();
  process.stdout.write(`${JSON.stringify({ marker: "AGENTTEAMS_DSH_MANAGER_READY", name: config.name, model: config.model })}\n`);
  await runManagerLoop(config, { signal: controller.signal });
} catch (error) {
  process.stderr.write(`${JSON.stringify({ marker: "AGENTTEAMS_DSH_MANAGER_FAILED", error: error.message })}\n`);
  process.exit(1);
}
