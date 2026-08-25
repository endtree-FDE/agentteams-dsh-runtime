import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { managerAction } from "./controller-client.mjs";

const safeName = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const workerStates = new Set(["Running", "Sleeping", "Stopped"]);

function cleanText(value, limit = 500) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function resourceName(value, required = true) {
  const name = cleanText(value, 63).toLowerCase();
  if ((!name && required) || (name && !safeName.test(name))) throw new Error("Manager resourceName is unsafe");
  return name;
}

function cleanWorkerRequest(config, action, request, name) {
  const input = request && typeof request === "object" && !Array.isArray(request) ? request : {};
  if (action === "create_worker") {
    return {
      name,
      model: cleanText(input.model, 120) || config.model,
      runtime: "dsh",
      image: config.defaultWorkerImage,
      ...(cleanText(input.identity, 500) ? { identity: cleanText(input.identity, 500) } : {}),
      ...(cleanText(input.soul, 1_500) ? { soul: cleanText(input.soul, 1_500) } : {}),
      ...(input.env && typeof input.env === "object"
        ? { env: Object.fromEntries(Object.entries(input.env).filter(([key, value]) => /^JUCHANG_[A-Z0-9_]+$/.test(key) && typeof value === "string").map(([key, value]) => [key, value.slice(0, 4_000)])) }
        : {}),
    };
  }
  const output = {};
  if (cleanText(input.model, 120)) output.model = cleanText(input.model, 120);
  if (cleanText(input.state, 20)) {
    if (!workerStates.has(input.state)) throw new Error("Worker state is unsupported");
    output.state = input.state;
  }
  if (input.runtime !== undefined || input.image !== undefined) {
    output.runtime = "dsh";
    output.image = config.defaultWorkerImage;
  }
  if (!Object.keys(output).length) throw new Error("update_worker needs model, state, or DSH runtime migration");
  return output;
}

function cleanTeamRequest(action, request, name) {
  const input = request && typeof request === "object" && !Array.isArray(request) ? request : {};
  const output = {};
  if (action === "create_team") output.name = name;
  if (cleanText(input.description, 1_000)) output.description = cleanText(input.description, 1_000);
  if (Array.isArray(input.workerMembers)) {
    const members = input.workerMembers.map((member) => ({
      name: resourceName(member?.name),
      role: member?.role === "team_leader" ? "team_leader" : "worker",
    }));
    if (members.length < 2 || members.length > 32 || members.filter((member) => member.role === "team_leader").length !== 1) {
      throw new Error("Team needs 2-32 members and exactly one team_leader");
    }
    if (new Set(members.map((member) => member.name)).size !== members.length) throw new Error("Team members must be unique");
    output.workerMembers = members;
  }
  if (input.peerMentions !== undefined) output.peerMentions = input.peerMentions !== false;
  if (action === "create_team" && !output.workerMembers) throw new Error("create_team needs workerMembers");
  if (action === "update_team" && !Object.keys(output).length) throw new Error("update_team has no supported changes");
  return output;
}

export function validateManagerPlan(config, value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Manager plan must be an object");
  if (value.schema !== "agentteams-dsh-manager-plan@1") throw new Error("Manager plan schema is unsupported");
  const route = managerAction(value.action);
  const needsName = !["status", "list_workers", "list_teams"].includes(value.action);
  const name = resourceName(value.resourceName, needsName);
  let request = {};
  if (["create_worker", "update_worker"].includes(value.action)) request = cleanWorkerRequest(config, value.action, value.request, name);
  if (["create_team", "update_team"].includes(value.action)) request = cleanTeamRequest(value.action, value.request, name);
  return Object.freeze({
    schema: value.schema,
    planId: randomUUID(),
    action: value.action,
    resourceName: name,
    request,
    summary: cleanText(value.summary, 500) || `${value.action} ${name}`.trim(),
    write: route.write,
    destructive: route.destructive === true,
    status: route.write ? "pending_confirmation" : "ready",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 15 * 60_000).toISOString(),
  });
}

export function createManagerPlanStore(root) {
  fs.mkdirSync(root, { recursive: true });
  const filename = (planId) => path.join(root, `${planId}.json`);
  const write = (plan, replace = false) => {
    const target = filename(plan.planId);
    const temporary = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    if (replace && fs.existsSync(target)) fs.rmSync(target);
    fs.renameSync(temporary, target);
    return plan;
  };
  return Object.freeze({
    save: write,
    read(planId) {
      if (!/^[0-9a-f-]{36}$/i.test(planId)) throw new Error("Manager planId is invalid");
      return JSON.parse(fs.readFileSync(filename(planId), "utf8"));
    },
    update(plan) { return write(plan, true); },
  });
}

export function confirmationFromText(text) {
  const match = String(text || "").trim().match(/^MANAGER_CONFIRM:\s*([0-9a-f-]{36})(?:\s+(DELETE))?$/i);
  return match ? { planId: match[1], destructiveConfirmed: match[2] === "DELETE" } : null;
}
