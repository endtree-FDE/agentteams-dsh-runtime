import { spawn } from "node:child_process";
import readline from "node:readline";

function parseToolPayload(result) {
  const text = result?.content?.find((item) => item?.type === "text")?.text;
  if (!text) throw new Error("TeamHarness returned no text payload");
  const payload = JSON.parse(text);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("TeamHarness returned an invalid payload");
  }
  return payload;
}

export class TeamHarnessClient {
  constructor(child, timeoutMs = 30_000) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4_000); });
    child.once("exit", (code) => this.rejectAll(new Error(`TeamHarness exited ${code}: ${this.stderr.trim()}`)));
    child.once("error", (error) => this.rejectAll(error));
  }

  handleLine(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.error) pending.reject(new Error(response.error.message || "TeamHarness request failed"));
    else pending.resolve(response.result);
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`TeamHarness ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agentteams-dsh-runtime", version: "0.3.1" },
    });
    const listed = await this.request("tools/list");
    const names = new Set((listed?.tools || []).map((tool) => tool.name));
    for (const required of ["health", "taskflow", "projectflow"]) {
      if (!names.has(required)) throw new Error(`TeamHarness tool is missing: ${required}`);
    }
  }

  async call(name, argumentsValue = {}) {
    return parseToolPayload(await this.request("tools/call", { name, arguments: argumentsValue }));
  }

  async callTaskflow(config, action, payload) {
    return this.call("taskflow", {
      role: config.agentRole,
      action,
      workspaceDir: config.workspaceRoot,
      payload,
    });
  }

  async callProjectflow(config, action, payload) {
    return this.call("projectflow", {
      role: config.agentRole,
      action,
      projectId: payload.projectId,
      workspaceDir: config.workspaceRoot,
      payload,
    });
  }

  close() {
    this.child.stdin.end();
  }
}

export async function startTeamHarness(config, options = {}) {
  const child = (options.spawn || spawn)(
    config.teamHarnessCommand,
    [config.teamHarnessServer],
    {
      cwd: config.workspaceRoot,
      env: {
        ...process.env,
        ...options.env,
        AGENTTEAMS_AGENT_ROLE: config.agentRole,
        AGENTTEAMS_MATRIX_URL: config.matrixUrl,
        AGENTTEAMS_WORKER_MATRIX_TOKEN: config.matrixToken,
        AGENTTEAMS_MATRIX_USER_ID: config.matrixUserId,
        AGENTTEAMS_WORKER_NAME: config.runtimeName,
        AGENTTEAMS_SHARED_DIR: config.sharedRoot,
        TEAMHARNESS_SHARED_DIR: config.sharedRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const client = new TeamHarnessClient(child, options.timeoutMs);
  await client.initialize();
  const health = await client.call("health", {});
  if (health.ok !== true) throw new Error("TeamHarness health check failed");
  return client;
}
