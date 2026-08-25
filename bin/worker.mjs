#!/usr/bin/env node

import { loadRuntimeConfig } from "../src/runtime-config.mjs";
import { runWorkerLoop } from "../src/worker-bridge.mjs";

const index = process.argv.indexOf("--config");
const filename = index >= 0 ? process.argv[index + 1] : "";
if (!filename) {
  process.stderr.write("Usage: node bin/worker.mjs --config /path/to/runtime.yaml\n");
  process.exit(2);
}

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  const config = loadRuntimeConfig(filename);
  process.stdout.write(`${JSON.stringify({ marker: "AGENTTEAMS_DSH_WORKER_READY", name: config.name, role: config.role, model: config.model })}\n`);
  await runWorkerLoop(config, { signal: controller.signal });
} catch (error) {
  process.stderr.write(`${JSON.stringify({ marker: "AGENTTEAMS_DSH_WORKER_FAILED", error: error.message })}\n`);
  process.exit(1);
}
