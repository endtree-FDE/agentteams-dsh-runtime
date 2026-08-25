import fs from "node:fs";
import path from "node:path";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function httpUrl(value, label) {
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`${label} must use http or https`);
  return parsed.toString().replace(/\/$/, "");
}

export function loadManagerConfig(env = process.env) {
  const matrixDomain = required(env, "AGENTTEAMS_MATRIX_DOMAIN");
  const workspaceRoot = path.resolve(env.AGENTTEAMS_WORKSPACE_DIR?.trim() || "/workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const sharedRoot = path.resolve(env.AGENTTEAMS_SHARED_DIR?.trim() || path.join(workspaceRoot, "shared"));
  fs.mkdirSync(sharedRoot, { recursive: true });
  const managerName = env.AGENTTEAMS_MANAGER_NAME?.trim() || "default";
  const adminUser = env.AGENTTEAMS_ADMIN_USER?.trim() || "admin";
  const matrixUserId = env.AGENTTEAMS_MANAGER_MATRIX_USER_ID?.trim() || `@manager:${matrixDomain}`;
  return Object.freeze({
    name: managerName,
    agentRole: "manager",
    role: "manager",
    matrixUrl: httpUrl(required(env, "AGENTTEAMS_MATRIX_URL"), "AGENTTEAMS_MATRIX_URL"),
    matrixToken: required(env, "AGENTTEAMS_MANAGER_MATRIX_TOKEN"),
    matrixUserId,
    adminMatrixUserId: `@${adminUser}:${matrixDomain}`,
    managerRoomId: required(env, "AGENTTEAMS_MANAGER_ROOM_ID"),
    gatewayUrl: httpUrl(required(env, "AGENTTEAMS_AI_GATEWAY_URL"), "AGENTTEAMS_AI_GATEWAY_URL"),
    gatewayKey: required(env, "AGENTTEAMS_MANAGER_GATEWAY_KEY"),
    model: env.AGENTTEAMS_DEFAULT_MODEL?.trim() || "MiniMax-M3",
    workspaceRoot,
    sharedRoot,
    planRoot: path.resolve(env.JUCHANG_MANAGER_STATE_DIR?.trim() || path.join(workspaceRoot, ".agentteams-dsh-manager")),
    supervisorStateRoot: path.resolve(env.JUCHANG_SUPERVISOR_STATE_DIR?.trim() || path.join(workspaceRoot, ".juchang-supervisor")),
    dshHome: path.resolve(env.JUCHANG_DSH_HOME?.trim() || path.join(workspaceRoot, ".dsh-supervisor")),
    defaultWorkerImage: env.JUCHANG_DSH_WORKER_IMAGE?.trim() || "juchang/agentteams-dsh-runtime:0.4.3",
  });
}
