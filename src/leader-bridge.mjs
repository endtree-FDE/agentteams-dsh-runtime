import { acceptTask, completeProject, startProject } from "./leader-runtime.mjs";
import { listLeaderEvents, sendMatrixText, syncMatrix } from "./matrix-client.mjs";
import { startTeamHarness } from "./teamharness-client.mjs";

function projectIdFromTask(taskId) {
  const match = String(taskId || "").match(/^(.+)-0[1-4]$/);
  if (!match) throw new Error("TASK_COMPLETED taskId is outside the four-role DAG");
  return match[1];
}

export async function runLeaderLoop(config, options = {}) {
  let since = "";
  const seen = new Set();
  const ownsTeamHarness = !options.teamHarness;
  const teamHarness = options.teamHarness || await (options.startTeamHarness || startTeamHarness)(config);
  try {
    while (!options.signal?.aborted) {
      const response = await (options.sync || syncMatrix)(config, since, 30_000);
      since = response.next_batch || since;
      for (const event of listLeaderEvents(config, response)) {
        if (!event.eventId || seen.has(event.eventId)) continue;
        seen.add(event.eventId);
        try {
          if (event.kind === "project") {
            const started = await startProject(config, event.envelope, teamHarness);
            await (options.sendText || sendMatrixText)(config, event.roomId, `PROJECT_STARTED: ${started.request.projectId}\ndelegated: ${started.delegated.join(", ")}`);
            continue;
          }
          const projectId = projectIdFromTask(event.taskId);
          const accepted = await acceptTask(config, projectId, event.taskId, teamHarness);
          if (!accepted.completed) {
            await (options.sendText || sendMatrixText)(config, event.roomId, `TASK_ACCEPTED: ${event.taskId}\ndelegated: ${accepted.delegated.join(", ") || "none"}`);
            continue;
          }
          const result = await completeProject(config, projectId, teamHarness, { runDsh: options.runDsh, env: options.env });
          await (options.sendText || sendMatrixText)(config, event.roomId, `PROJECT_COMPLETED: ${projectId}\nstatus: ${result.leader.status}\nresult: shared/projects/${projectId}/workspace/result.json`);
        } catch (error) {
          await (options.sendText || sendMatrixText)(config, event.roomId, `JUCHANG_DSH_LEADER_BLOCKED\nerror: ${String(error.message || error).replace(/[\r\n]+/g, " ").slice(0, 300)}`);
        }
      }
    }
  } finally {
    if (ownsTeamHarness) teamHarness.close();
  }
}
