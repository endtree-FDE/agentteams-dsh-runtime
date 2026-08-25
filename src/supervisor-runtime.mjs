import { randomUUID } from "node:crypto";

import { runSupervisorTurn } from "./dsh-runner.mjs";
import { createSupervisorSessionStore } from "./supervisor-session-store.mjs";

export const CASE_COMMAND_PREFIX = "JUCHANG_CASE_COMMAND: ";
export const CASE_DECISION_PREFIX = "JUCHANG_CASE_DECISION: ";
export const CASE_EVENT_PREFIX = "JUCHANG_CASE_EVENT: ";
export const CASE_RESULT_PREFIX = "JUCHANG_CASE_RESULT: ";

const actionSet = new Set(["answer", "status", "clarify", "team_dispatch", "approval_required"]);
const approvalActions = new Set(["archive", "restore", "request_recheck", "prepare_formal_change"]);

function parseLine(body, prefix) {
  const line = String(body || "").split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  if (!line) return null;
  return JSON.parse(line.slice(prefix.length));
}

function safeText(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function safeContext(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const context = {
    roomId: safeText(input.roomId, 220),
    taskId: safeText(input.taskId, 120),
    sourceUrl: safeText(input.sourceUrl, 2_000),
    sourceTitle: safeText(input.sourceTitle, 500),
    sourceAuthor: safeText(input.sourceAuthor, 300),
    intakeKind: safeText(input.intakeKind, 40),
    taskState: safeText(input.taskState, 80),
    projectStatus: safeText(input.projectStatus, 80),
    approvalState: safeText(input.approvalState, 80),
    resultExcerpt: safeText(input.resultExcerpt, 4_000),
    workflowNodes: Array.isArray(input.workflowNodes)
      ? input.workflowNodes.slice(0, 8).map((node) => ({
          role: safeText(node?.role, 80),
          status: safeText(node?.status, 80),
          summary: safeText(node?.summary, 600),
        }))
      : [],
    safetyCounters: input.safetyCounters && typeof input.safetyCounters === "object"
      ? {
          productionWrites: Number(input.safetyCounters.productionWrites) || 0,
          publicPublishes: Number(input.safetyCounters.publicPublishes) || 0,
          realRefunds: Number(input.safetyCounters.realRefunds) || 0,
          externalMessages: Number(input.safetyCounters.externalMessages) || 0,
        }
      : { productionWrites: 0, publicPublishes: 0, realRefunds: 0, externalMessages: 0 },
  };
  if (context.sourceUrl && !/^https:\/\//.test(context.sourceUrl)) throw new Error("Supervisor sourceUrl must use https");
  return context;
}

export function parseSupervisorCommand(body) {
  const value = parseLine(body, CASE_COMMAND_PREFIX);
  if (!value) return null;
  if (value.schema !== "juchang-case-command@1") throw new Error("Unsupported supervisor command schema");
  if (!/^[0-9a-f-]{36}$/i.test(value.commandId || "")) throw new Error("Supervisor commandId is invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(value.threadId || "")) throw new Error("Supervisor threadId is invalid");
  const text = safeText(value.text, 4_000);
  if (!text) throw new Error("Supervisor command text is empty");
  return Object.freeze({
    schema: value.schema,
    commandId: value.commandId,
    threadId: value.threadId,
    text,
    context: safeContext(value.context),
  });
}

export function parseSupervisorDecision(body) {
  const value = parseLine(body, CASE_DECISION_PREFIX);
  if (!value) return null;
  if (value.schema !== "juchang-case-decision@1") throw new Error("Unsupported supervisor decision schema");
  if (!/^[0-9a-f-]{36}$/i.test(value.approvalId || "")) throw new Error("Supervisor approvalId is invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(value.threadId || "")) throw new Error("Supervisor threadId is invalid");
  if (!["approve", "edit", "reject"].includes(value.decision)) throw new Error("Supervisor decision is invalid");
  return Object.freeze({
    approvalId: value.approvalId,
    threadId: value.threadId,
    decision: value.decision,
    note: safeText(value.note, 1_000),
  });
}

export function buildSupervisorPrompt(command) {
  return [
    "Return one compact JSON object only with schema juchang-case-supervisor-turn@1.",
    "Fields: schema, action, message, groundedFacts, teamInstruction, approval.",
    "action is answer, status, clarify, team_dispatch, or approval_required.",
    "Use team_dispatch only for read-only preparation that genuinely benefits from all four roles.",
    "Use approval_required for archive, restore, request_recheck, or prepare_formal_change.",
    "groundedFacts is an array of zero to six exact verbatim substrings copied from CURRENT CONTEXT; do not paraphrase them.",
    "answer and status require at least one groundedFacts item; if none exists, choose clarify.",
    "approval is null unless approval_required; otherwise include action, summary, reason.",
    "Never claim that a write, publication, refund, message, approval, or dispatch already happened.",
    "Do not invent roomId, taskId, source, dates, people, organizations, places, series, or evidence.",
    "ADMIN COMMAND:",
    command.text,
    "CURRENT CONTEXT:",
    JSON.stringify(command.context),
  ].join("\n");
}

export function validateSupervisorResult(value, command) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Supervisor result must be an object");
  if (value.schema !== "juchang-case-supervisor-turn@1") throw new Error("Supervisor result schema is unsupported");
  if (!actionSet.has(value.action)) throw new Error("Supervisor result action is unsupported");
  let message = safeText(value.message, 3_000);
  if (!message) throw new Error("Supervisor result message is empty");
  const corpus = JSON.stringify(command.context);
  const groundedFacts = Array.isArray(value.groundedFacts)
    ? value.groundedFacts.slice(0, 6).map((fact) => safeText(fact, 500)).filter((fact) => fact && corpus.includes(fact))
    : [];
  let action = value.action;
  if (action === "answer" || action === "status") {
    if (!groundedFacts.length) {
      action = "clarify";
      message = "现有案件材料不足以回答这个问题，请补充可核对的原文或具体对象。";
    } else {
      message = groundedFacts.join("；");
    }
  }
  const teamInstruction = safeText(value.teamInstruction, 2_000);
  if (action === "team_dispatch" && !teamInstruction) throw new Error("team_dispatch requires teamInstruction");
  let approval = null;
  if (action === "approval_required") {
    if (!value.approval || typeof value.approval !== "object") throw new Error("approval_required needs approval");
    const action = safeText(value.approval.action, 80);
    if (!approvalActions.has(action)) throw new Error("Supervisor approval action is unsupported");
    if (action !== "prepare_formal_change" && (!command.context.taskId || !command.context.roomId)) {
      throw new Error("Supervisor approval target is missing");
    }
    approval = {
      action,
      summary: `${({ archive: "归档", restore: "恢复", request_recheck: "重新核对", prepare_formal_change: "准备正式变更" })[action]}当前案件`,
      reason: groundedFacts.join("；") || "管理员已提出这项动作，执行前需要明确确认。",
    };
  }
  return Object.freeze({ schema: value.schema, action, message, groundedFacts, teamInstruction, approval });
}

function resultEnvelope(command, result, extra = {}) {
  return {
    schema: "juchang-case-result@1",
    commandId: command.commandId,
    threadId: command.threadId,
    action: result.action,
    message: result.message,
    teamInstruction: result.teamInstruction,
    context: command.context,
    ...extra,
  };
}

export async function handleSupervisorMessage(config, event, options = {}) {
  const sendText = options.sendText;
  const store = options.supervisorStore || createSupervisorSessionStore(config.supervisorStateRoot);
  const decision = parseSupervisorDecision(event.body);
  if (decision) {
    const existing = store.findApproval(decision.threadId, decision.approvalId);
    if (existing?.status !== "pending") {
      if (existing && existing.decision === decision.decision && existing.note === decision.note) {
        return { schema: "juchang-case-approval-resolution@1", threadId: decision.threadId, approval: existing, repeated: true };
      }
    }
    const approval = store.resolveApproval(decision.threadId, decision.approvalId, decision.decision, decision.note);
    const payload = { schema: "juchang-case-approval-resolution@1", threadId: decision.threadId, approval };
    await sendText(config, event.roomId, `${CASE_RESULT_PREFIX}${JSON.stringify(payload)}`);
    return payload;
  }

  const command = parseSupervisorCommand(event.body);
  if (!command) return null;
  const claim = store.beginCommand(command.threadId, command.commandId);
  if (!claim.claimed) {
    return { schema: "juchang-case-command-replay@1", commandId: command.commandId, threadId: command.threadId, status: claim.status, repeated: true };
  }
  const thread = store.open(command.threadId);
  let sessionCreated = thread.sessionCreated;
  await sendText(config, event.roomId, `${CASE_EVENT_PREFIX}${JSON.stringify({ schema: "juchang-case-event@1", commandId: command.commandId, threadId: command.threadId, kind: "run_started", at: new Date().toISOString() })}`);
  const result = await (options.runTurn || runSupervisorTurn)(config, thread, buildSupervisorPrompt(command), {
    env: options.env,
    onEvent: async (progress) => {
      if (!sessionCreated && progress.type === "turn/start") {
        store.markSessionCreated(command.threadId);
        sessionCreated = true;
      }
      if (!["tool", "tool_error", "tool_done"].includes(progress.status)) return;
      await sendText(config, event.roomId, `${CASE_EVENT_PREFIX}${JSON.stringify({ schema: "juchang-case-event@1", commandId: command.commandId, threadId: command.threadId, kind: progress.status, tool: progress.tool || "", at: new Date().toISOString() })}`);
    },
  });
  if (!sessionCreated) store.markSessionCreated(command.threadId);
  const validated = validateSupervisorResult(result, command);
  let approval = null;
  if (validated.approval) {
    approval = store.saveApproval(command.threadId, {
      approvalId: randomUUID(),
      commandId: command.commandId,
      action: validated.approval.action,
      taskId: command.context.taskId,
      roomId: command.context.roomId,
      summary: validated.approval.summary,
      reason: validated.approval.reason,
    });
  }
  const payload = resultEnvelope(command, validated, { approval });
  store.appendTurn(command.threadId, { commandId: command.commandId, input: command.text, action: validated.action, output: validated.message });
  await sendText(config, event.roomId, `${CASE_RESULT_PREFIX}${JSON.stringify(payload)}`);
  store.completeCommand(command.threadId, command.commandId);
  return payload;
}
