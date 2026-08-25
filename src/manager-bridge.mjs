import { createControllerClient, executeManagerPlan } from "./controller-client.mjs";
import { runManagerPlanner } from "./dsh-runner.mjs";
import { listManagerEvents, sendMatrixText, syncMatrix } from "./matrix-client.mjs";
import { confirmationFromText, createManagerPlanStore, validateManagerPlan } from "./manager-runtime.mjs";

function compact(value, limit = 3_000) {
  const text = JSON.stringify(value, null, 2);
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…`;
}

export async function handleManagerMessage(config, event, options = {}) {
  const controller = options.controller || createControllerClient(options.env || process.env, options.fetch);
  const store = options.store || createManagerPlanStore(config.planRoot);
  const sendText = options.sendText || sendMatrixText;
  const confirmation = confirmationFromText(event.body);
  if (confirmation) {
    const plan = store.read(confirmation.planId);
    if (plan.status === "executed") {
      await sendText(config, event.roomId, `MANAGER_ALREADY_EXECUTED: ${plan.planId}`);
      return { plan, repeated: true };
    }
    if (plan.status !== "pending_confirmation") throw new Error("Manager plan is not pending confirmation");
    if (Date.parse(plan.expiresAt) <= Date.now()) throw new Error("Manager plan has expired");
    if (plan.destructive && !confirmation.destructiveConfirmed) throw new Error(`Destructive plan requires: MANAGER_CONFIRM: ${plan.planId} DELETE`);
    const result = await executeManagerPlan(controller, plan);
    const executed = store.update({ ...plan, status: "executed", executedAt: new Date().toISOString() });
    await sendText(config, event.roomId, `MANAGER_EXECUTED: ${plan.planId}\naction: ${plan.action}\nresult:\n${compact(result)}`);
    return { plan: executed, result };
  }

  const candidate = await (options.plan || runManagerPlanner)(config, event.body, options.env);
  const plan = validateManagerPlan(config, candidate, options.now?.() || Date.now());
  if (!plan.write) {
    const result = await executeManagerPlan(controller, plan);
    await sendText(config, event.roomId, `MANAGER_READ_RESULT: ${plan.action}\n${compact(result)}`);
    return { plan, result };
  }
  store.save(plan);
  const confirmationLine = `MANAGER_CONFIRM: ${plan.planId}${plan.destructive ? " DELETE" : ""}`;
  await sendText(config, event.roomId, [
    `MANAGER_PLAN_READY: ${plan.planId}`,
    `action: ${plan.action}`,
    `resource: ${plan.resourceName}`,
    `summary: ${plan.summary}`,
    `expires: ${plan.expiresAt}`,
    `confirm exactly: ${confirmationLine}`,
  ].join("\n"));
  return { plan };
}

export async function runManagerLoop(config, options = {}) {
  let since = "";
  const seen = new Set();
  while (!options.signal?.aborted) {
    const response = await (options.sync || syncMatrix)(config, since, 30_000);
    since = response.next_batch || since;
    for (const event of listManagerEvents(config, response)) {
      if (!event.eventId || seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      try {
        await handleManagerMessage(config, event, options);
      } catch (error) {
        await (options.sendText || sendMatrixText)(config, event.roomId, `MANAGER_BLOCKED: ${String(error.message || error).replace(/[\r\n]+/g, " ").slice(0, 400)}`);
      }
    }
  }
}
