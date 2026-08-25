import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const threadPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

function safeThreadId(value) {
  const text = String(value || "").trim();
  if (!threadPattern.test(text)) throw new Error("Supervisor threadId is unsafe");
  return text;
}

function atomicWrite(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, filename);
  return value;
}

function createThread(threadId, now) {
  const digest = createHash("sha256").update(threadId).digest("hex").slice(0, 24);
  return {
    schema: "juchang-supervisor-thread@1",
    threadId,
    sessionId: `juchang-supervisor-${digest}`,
    sessionCreated: false,
    revision: 0,
    turns: [],
    approvals: [],
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

export function createSupervisorSessionStore(root, now = () => Date.now()) {
  const absolute = path.resolve(root);
  fs.mkdirSync(absolute, { recursive: true });
  const filename = (threadId) => path.join(absolute, `${safeThreadId(threadId)}.json`);
  const read = (threadId) => {
    const target = filename(threadId);
    return fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : null;
  };
  const update = (threadId, mutate) => {
    const current = read(threadId) || createThread(safeThreadId(threadId), now());
    const next = mutate(structuredClone(current));
    next.revision = current.revision + 1;
    next.updatedAt = new Date(now()).toISOString();
    return atomicWrite(filename(threadId), next);
  };
  return Object.freeze({
    open(threadId) {
      const current = read(threadId);
      return current || atomicWrite(filename(threadId), createThread(safeThreadId(threadId), now()));
    },
    markSessionCreated(threadId) {
      return update(threadId, (state) => ({ ...state, sessionCreated: true }));
    },
    appendTurn(threadId, turn) {
      return update(threadId, (state) => ({
        ...state,
        turns: [...state.turns, { ...turn, at: new Date(now()).toISOString() }].slice(-80),
      }));
    },
    saveApproval(threadId, input) {
      const approval = {
        approvalId: input.approvalId || randomUUID(),
        status: "pending",
        commandId: input.commandId,
        action: input.action,
        taskId: input.taskId || "",
        roomId: input.roomId || "",
        summary: input.summary,
        reason: input.reason,
        createdAt: new Date(now()).toISOString(),
        resolvedAt: "",
        decision: "",
        note: "",
      };
      update(threadId, (state) => ({ ...state, approvals: [...state.approvals, approval].slice(-40) }));
      return approval;
    },
    resolveApproval(threadId, approvalId, decision, note) {
      let resolved = null;
      update(threadId, (state) => ({
        ...state,
        approvals: state.approvals.map((approval) => {
          if (approval.approvalId !== approvalId) return approval;
          if (approval.status !== "pending") {
            if (approval.decision !== decision || approval.note !== note) {
              throw new Error("Supervisor approval was already resolved differently");
            }
            resolved = approval;
            return approval;
          }
          resolved = {
            ...approval,
            status: decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "edited",
            decision,
            note,
            resolvedAt: new Date(now()).toISOString(),
          };
          return resolved;
        }),
      }));
      if (!resolved) throw new Error("Supervisor approval was not found");
      return resolved;
    },
    read,
  });
}
