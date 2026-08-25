import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

function requiredString(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function credential(env, name, fallback, label) {
  const ref = requiredString(name, `${label} env reference`);
  if (!/^AGENTTEAMS_[A-Z0-9_]+$/.test(ref)) throw new Error(`${label} env reference is unsafe`);
  return requiredString(env[ref] || fallback, label);
}

function url(value, label) {
  const parsed = new URL(requiredString(value, label));
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`${label} must use http or https`);
  return parsed.toString().replace(/\/$/, "");
}

function leaderMatrixUserId(value, member) {
  const runtimeName = requiredString(value.team?.leaderRuntimeName, "team.leaderRuntimeName");
  const match = (value.team?.members || []).find((item) => item?.runtimeName === runtimeName);
  const explicit = typeof match?.matrixUserId === "string" ? match.matrixUserId.trim() : "";
  if (explicit) return explicit;
  const ownId = requiredString(member.matrixUserId, "member.matrixUserId");
  const separator = ownId.indexOf(":");
  if (!runtimeName || separator < 0) throw new Error("Team Leader Matrix identity is unavailable");
  return `@${runtimeName}:${ownId.slice(separator + 1)}`;
}

function roleBindings(value, env) {
  let bindings = value.juchang?.roleBindings || {};
  if (env.JUCHANG_ROLE_BINDINGS_JSON?.trim()) {
    bindings = JSON.parse(env.JUCHANG_ROLE_BINDINGS_JSON);
  }
  return Object.freeze(Object.fromEntries(Object.entries(bindings).map(([role, binding]) => [role, Object.freeze({
    runtimeName: requiredString(binding?.runtimeName, `juchang.roleBindings.${role}.runtimeName`),
    matrixUserId: requiredString(binding?.matrixUserId, `juchang.roleBindings.${role}.matrixUserId`),
  })])));
}

export function loadRuntimeConfig(filename, env = process.env) {
  const absolute = path.resolve(filename);
  const value = YAML.parse(fs.readFileSync(absolute, "utf8"));
  if (value?.apiVersion !== "agentteams.io/v1beta1" || value?.kind !== "MemberRuntimeConfig") {
    throw new Error("unsupported AgentTeams runtime document");
  }
  const member = value.member || {};
  const desired = value.desired || {};
  const model = desired.model || {};
  const credentials = value.credentials || {};
  const runtime = requiredString(member.runtime, "member.runtime");
  if (runtime !== "dsh") throw new Error("member.runtime must be dsh");
  const matrixUrl = url(env.AGENTTEAMS_MATRIX_URL, "AGENTTEAMS_MATRIX_URL");
  const gatewayUrl = url(model.gatewayUrl || env.AGENTTEAMS_AI_GATEWAY_URL, "AgentTeams gateway URL");
  const sharedRoot = path.resolve(requiredString(env.AGENTTEAMS_SHARED_DIR, "AGENTTEAMS_SHARED_DIR"));
  if (!fs.statSync(sharedRoot).isDirectory()) throw new Error("AGENTTEAMS_SHARED_DIR must be a directory");
  const workspaceRoot = path.resolve(env.AGENTTEAMS_WORKSPACE_DIR?.trim() || path.dirname(sharedRoot));
  if (!fs.statSync(workspaceRoot).isDirectory()) throw new Error("AGENTTEAMS_WORKSPACE_DIR must be a directory");
  if (path.resolve(workspaceRoot, "shared") !== sharedRoot) {
    throw new Error("AGENTTEAMS_SHARED_DIR must equal <workspace>/shared");
  }
  const teamHarnessServer = path.resolve(requiredString(env.AGENTTEAMS_TEAMHARNESS_SERVER, "AGENTTEAMS_TEAMHARNESS_SERVER"));
  if (!fs.statSync(teamHarnessServer).isFile()) throw new Error("AGENTTEAMS_TEAMHARNESS_SERVER must be a file");
  const runtimeRole = env.JUCHANG_DSH_ROLE?.trim() || requiredString(member.role, "member.role");
  const agentRole = runtimeRole === "team_leader" ? "leader" : "worker";
  return Object.freeze({
    filename: absolute,
    name: requiredString(member.name, "member.name"),
    runtimeName: requiredString(member.runtimeName, "member.runtimeName"),
    role: runtimeRole,
    agentRole,
    matrixUserId: requiredString(member.matrixUserId, "member.matrixUserId"),
    leaderMatrixUserId: leaderMatrixUserId(value, member),
    roleBindings: roleBindings(value, env),
    matrixUrl,
    matrixToken: credential(env, credentials.matrixTokenEnv, value.matrix?.accessToken, "Matrix token"),
    gatewayUrl,
    gatewayKey: credential(env, credentials.gatewayKeyEnv, model.gatewayKey, "Gateway key"),
    model: requiredString(model.model, "desired.model.model"),
    sharedRoot,
    workspaceRoot,
    teamHarnessCommand: env.AGENTTEAMS_PYTHON_BIN?.trim() || "python3",
    teamHarnessServer,
    teamName: requiredString(value.team?.name, "team.name"),
    leaderRuntimeName: requiredString(value.team?.leaderRuntimeName, "team.leaderRuntimeName"),
  });
}

export function resolveSharedPath(config, relative, label) {
  const value = requiredString(relative, label).replaceAll("\\", "/");
  if (path.isAbsolute(value) || value.split("/").includes("..")) throw new Error(`${label} must be a safe relative path`);
  const resolved = path.resolve(config.sharedRoot, value);
  const prefix = `${config.sharedRoot}${path.sep}`;
  if (resolved !== config.sharedRoot && !resolved.startsWith(prefix)) throw new Error(`${label} escapes shared root`);
  return resolved;
}
