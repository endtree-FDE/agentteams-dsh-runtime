import readline from "node:readline";

const tools = ["health", "taskflow", "projectflow"].map((name) => ({ name }));

function response(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    response(request.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake-teamharness", version: "1" } });
  } else if (request.method === "tools/list") {
    response(request.id, { tools });
  } else if (request.method === "tools/call") {
    const name = request.params?.name;
    const payload = name === "health"
      ? { ok: true, tool: "health", status: "ok" }
      : { ok: true, tool: name, action: request.params?.arguments?.action };
    response(request.id, { content: [{ type: "text", text: JSON.stringify(payload) }] });
  }
}
