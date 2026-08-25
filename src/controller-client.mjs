import fs from "node:fs";

function controllerToken(env) {
  if (env.AGENTTEAMS_AUTH_TOKEN?.trim()) return env.AGENTTEAMS_AUTH_TOKEN.trim();
  const filename = env.AGENTTEAMS_AUTH_TOKEN_FILE?.trim();
  if (filename && fs.existsSync(filename)) return fs.readFileSync(filename, "utf8").trim();
  return "";
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => (
    /token|password|secret|gatewaykey|accesskey|privatekey|authorization|\benv\b/i.test(key)
      ? []
      : [[key, redact(child)]]
  )));
}

export function createControllerClient(env = process.env, fetchImpl = fetch) {
  const baseURL = new URL(env.AGENTTEAMS_CONTROLLER_URL?.trim() || "http://127.0.0.1:8090");
  if (!/^https?:$/.test(baseURL.protocol)) throw new Error("AGENTTEAMS_CONTROLLER_URL must use http or https");
  const token = controllerToken(env);
  return Object.freeze({
    async request(method, pathname, body) {
      const response = await fetchImpl(new URL(pathname, baseURL), {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let payload = {};
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = { message: text.slice(0, 500) }; }
      }
      if (!response.ok) throw new Error(`AgentTeams Controller ${method} ${pathname} failed: ${response.status}`);
      return redact(payload);
    },
  });
}

const planRoutes = Object.freeze({
  status: { method: "GET", path: () => "/api/v1/status", write: false },
  list_workers: { method: "GET", path: () => "/api/v1/workers", write: false },
  list_teams: { method: "GET", path: () => "/api/v1/teams", write: false },
  get_worker: { method: "GET", path: (plan) => `/api/v1/workers/${encodeURIComponent(plan.resourceName)}`, write: false },
  get_team: { method: "GET", path: (plan) => `/api/v1/teams/${encodeURIComponent(plan.resourceName)}`, write: false },
  create_worker: { method: "POST", path: () => "/api/v1/workers", write: true },
  update_worker: { method: "PUT", path: (plan) => `/api/v1/workers/${encodeURIComponent(plan.resourceName)}`, write: true },
  create_team: { method: "POST", path: () => "/api/v1/teams", write: true },
  update_team: { method: "PUT", path: (plan) => `/api/v1/teams/${encodeURIComponent(plan.resourceName)}`, write: true },
  wake_worker: { method: "POST", path: (plan) => `/api/v1/workers/${encodeURIComponent(plan.resourceName)}/wake`, write: true },
  sleep_worker: { method: "POST", path: (plan) => `/api/v1/workers/${encodeURIComponent(plan.resourceName)}/sleep`, write: true },
  delete_worker: { method: "DELETE", path: (plan) => `/api/v1/workers/${encodeURIComponent(plan.resourceName)}`, write: true, destructive: true },
  delete_team: { method: "DELETE", path: (plan) => `/api/v1/teams/${encodeURIComponent(plan.resourceName)}`, write: true, destructive: true },
});

export function managerAction(action) {
  const route = planRoutes[action];
  if (!route) throw new Error(`unsupported Manager action: ${action}`);
  return route;
}

export async function executeManagerPlan(client, plan) {
  const route = managerAction(plan.action);
  return client.request(route.method, route.path(plan), route.method === "GET" || route.method === "DELETE" ? undefined : plan.request);
}
