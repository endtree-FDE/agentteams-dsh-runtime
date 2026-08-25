import fs from "node:fs";
import path from "node:path";

import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

export const name = "juchang-resumable-headless";
export const inject = ["agentDefaultModel", "agents", "sessions", "headlessStartup"];
export const Config = z.object({});

export const internals = {
  stdout: process.stdout,
  stderr: process.stderr,
};

function requiredSessionId(env) {
  const value = env.JUCHANG_DSH_SESSION_ID?.trim() || "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(value)) {
    throw new Error("JUCHANG_DSH_SESSION_ID is missing or unsafe");
  }
  return SessionId(value);
}

function safeEvent(event) {
  const base = { seq: event.seq, time: event.time, type: event.type };
  if (event.type === "turn/start") return { ...base, status: "running" };
  if (event.type === "step/start") return { ...base, status: "working", step: event.data?.step };
  if (event.type === "tool/call") return { ...base, status: "tool", tool: String(event.data?.name || event.data?.toolName || "tool").slice(0, 120) };
  if (event.type === "tool/result") return { ...base, status: event.data?.isError ? "tool_error" : "tool_done" };
  if (event.type === "assistant/message") {
    const text = (event.data?.message?.content || [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("");
    return { ...base, status: "answer", text: text.slice(0, 2_000) };
  }
  if (event.type === "turn/end") return { ...base, status: event.data?.reason?.kind || "ended" };
  return null;
}

function appendEvents(filename, events, cursor) {
  if (!filename) return events.length;
  const rows = events.slice(cursor).map(safeEvent).filter(Boolean);
  if (rows.length) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.appendFileSync(filename, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  }
  return events.length;
}

function summarize(events, firstSeq) {
  let started = false;
  let text = "";
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") started = true;
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = (event.data?.message?.content || [])
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined) text = joined;
    }
    if (event.type === "turn/end") reason = event.data.reason;
  }
  return { text, reason };
}

export async function runResumable(ctx, task, io = internals, env = process.env) {
  await ctx.get("loader")?.await();
  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  const sessions = ctx.get("sessions");
  if (!agents || !defaultModel || !sessions) throw new Error("DSH resumable runner services are unavailable");

  const selection = defaultModel.currentSelection();
  const agentOptions = { provider: selection.provider, model: selection.model };
  const setup = (agentCtx) => installModelSelection(agentCtx, { current: selection, assembled: undefined });
  const sessionId = requiredSessionId(env);
  const resume = env.JUCHANG_DSH_SESSION_MODE === "resume";
  const handle = resume
    ? await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    : await agents.create({ sessionId, meta: { cwd: process.cwd() }, agentOptions, setup });
  const agent = handle.agent;
  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  const eventPath = env.JUCHANG_DSH_EVENTS_PATH?.trim() || "";
  if (eventPath) fs.writeFileSync(eventPath, "", "utf8");
  let cursor = agent.session.events.length;
  const timer = setInterval(() => { cursor = appendEvents(eventPath, agent.session.events, cursor); }, 200);
  try {
    agent.followup(createUserMessage({
      content: [{ type: "text", text: task }],
      source: { kind: "user" },
    }));
    await agent.whenIdle();
    cursor = appendEvents(eventPath, agent.session.events, cursor);
    await sessions.flush(agent.session);
    return summarize(agent.session.events, firstSeq);
  } finally {
    clearInterval(timer);
  }
}

export function apply(ctx) {
  const exit = ctx.get("appExit");
  const task = ctx.get("headlessStartup")?.task;
  if (!exit || typeof task !== "string") throw new Error("juchang-resumable-headless requires launcher task and exit services");
  runResumable(ctx, task).then((outcome) => {
    internals.stdout.write(`${outcome.text}\n`);
    if (outcome.reason?.kind === "error") {
      internals.stderr.write(`dsh: ${outcome.reason.error?.code || "error"}: ${outcome.reason.error?.message || "turn failed"}\n`);
    }
    exit(outcome.reason?.kind === "completed" ? 0 : 1);
  }).catch((error) => {
    internals.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
    exit(1);
  });
}
