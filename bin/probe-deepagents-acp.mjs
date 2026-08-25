#!/usr/bin/env node

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

const index = process.argv.indexOf("--python");
const python = index >= 0 ? process.argv[index + 1] : process.env.JUCHANG_DEEPAGENTS_PYTHON || "python3";
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "acp", "juchang_acp.py");
const child = spawn(python, [server, "--smoke"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let assistantText = "";
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
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
  const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
  const result = await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "transport smoke" }] });
  const receipt = JSON.parse(assistantText);
  if (result.stopReason !== "end_turn" || receipt.status !== "completed") throw new Error("Deep Agents ACP smoke contract failed");
  process.stdout.write(`${JSON.stringify({ marker: "DEEPAGENTS_ACP_READY", protocolVersion: PROTOCOL_VERSION, stopReason: result.stopReason, receipt })}\n`);
} finally {
  child.stdin.end();
  const code = await new Promise((resolve) => child.once("exit", resolve));
  if (code !== 0) throw new Error(`Deep Agents ACP smoke exited ${code}: ${stderr.trim()}`);
}
