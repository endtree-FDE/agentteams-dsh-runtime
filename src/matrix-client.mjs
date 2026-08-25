import { randomUUID } from "node:crypto";

function auth(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function matrixRequest(config, pathname, init = {}) {
  const response = await fetch(`${config.matrixUrl}${pathname}`, {
    ...init,
    headers: { ...auth(config.matrixToken), ...(init.headers || {}) },
  });
  if (!response.ok) throw new Error(`Matrix ${init.method || "GET"} ${pathname} failed: ${response.status}`);
  return response.json();
}

export async function syncMatrix(config, since = "", timeoutMs = 30_000) {
  const query = new URLSearchParams({ timeout: String(timeoutMs) });
  if (since) query.set("since", since);
  return matrixRequest(config, `/_matrix/client/v3/sync?${query}`);
}

export async function sendMatrixText(config, roomId, body, mentions = []) {
  const txnId = randomUUID().replaceAll("-", "");
  return matrixRequest(
    config,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    {
      method: "PUT",
      body: JSON.stringify({
        msgtype: "m.text",
        body,
        ...(mentions.length ? { "m.mentions": { user_ids: mentions } } : {}),
      }),
    },
  );
}

export function parseTaskEnvelope(body) {
  const line = String(body || "").split(/\r?\n/).find((item) => item.startsWith("JUCHANG_DSH_TASK: "));
  if (!line) return null;
  const value = JSON.parse(line.slice("JUCHANG_DSH_TASK: ".length));
  if (value?.schema !== "juchang-agentteams-dsh-task@1") throw new Error("unsupported DSH task envelope");
  return value;
}

export function parseProjectEnvelope(body) {
  const line = String(body || "").split(/\r?\n/).find((item) => item.startsWith("JUCHANG_DSH_PROJECT: "));
  if (!line) return null;
  const value = JSON.parse(line.slice("JUCHANG_DSH_PROJECT: ".length));
  if (value?.schema !== "juchang-agentteams-dsh-project@1") throw new Error("unsupported DSH project envelope");
  return value;
}

export function parseTaskCompletion(body) {
  const match = String(body || "").match(/(?:^|\n)@[^\s]+\s+TASK_COMPLETED:\s+([A-Za-z0-9][A-Za-z0-9._-]*)\b/);
  return match ? { taskId: match[1] } : null;
}

export function listAssignments(config, syncResponse) {
  const assignments = [];
  const rooms = syncResponse?.rooms?.join || {};
  for (const [roomId, room] of Object.entries(rooms)) {
    for (const event of room?.timeline?.events || []) {
      if (event?.type !== "m.room.message" || event.sender !== config.leaderMatrixUserId) continue;
      const body = event.content?.body;
      const mentions = event.content?.["m.mentions"]?.user_ids || [];
      if (!mentions.includes(config.matrixUserId) && !String(body || "").includes(config.matrixUserId)) continue;
      const envelope = parseTaskEnvelope(body);
      if (envelope) assignments.push({ roomId, eventId: event.event_id, sender: event.sender, envelope });
    }
  }
  return assignments;
}

export function listLeaderEvents(config, syncResponse) {
  const events = [];
  const rooms = syncResponse?.rooms?.join || {};
  for (const [roomId, room] of Object.entries(rooms)) {
    for (const event of room?.timeline?.events || []) {
      if (event?.type !== "m.room.message" || event.sender === config.matrixUserId) continue;
      const body = String(event.content?.body || "");
      const mentions = event.content?.["m.mentions"]?.user_ids || [];
      if (!mentions.includes(config.matrixUserId) && !body.includes(config.matrixUserId)) continue;
      const project = parseProjectEnvelope(body);
      const completion = parseTaskCompletion(body);
      if (project && event.sender === config.projectRequesterMatrixUserId) {
        events.push({ kind: "project", roomId, eventId: event.event_id, sender: event.sender, envelope: project });
      } else if (completion) {
        const index = Number(completion.taskId.match(/-0([1-4])$/)?.[1] || 0) - 1;
        const role = ["material_intake", "evidence_guard", "entity_matcher", "approval_guard"][index];
        if (role && event.sender === config.roleBindings?.[role]?.matrixUserId) {
          events.push({ kind: "completion", roomId, eventId: event.event_id, sender: event.sender, ...completion });
        }
      }
    }
  }
  return events;
}

export function listManagerEvents(config, syncResponse) {
  const events = [];
  const room = syncResponse?.rooms?.join?.[config.managerRoomId];
  for (const event of room?.timeline?.events || []) {
    if (event?.type !== "m.room.message" || event.sender !== config.adminMatrixUserId) continue;
    const body = String(event.content?.body || "").trim();
    if (!body) continue;
    events.push({ roomId: config.managerRoomId, eventId: event.event_id, sender: event.sender, body });
  }
  return events;
}
