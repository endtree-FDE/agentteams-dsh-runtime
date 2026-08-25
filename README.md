# AgentTeams DSH Runtime

Unofficial community Manager, Team Leader and Worker runtime for AgentTeams, built on DSH without QwenPaw.

## Current status

`0.4.0` implements an authoritative Worker bridge boundary:

1. read and validate an AgentTeams `MemberRuntimeConfig` YAML snapshot;
2. join the Worker identity to Matrix through the injected access token;
3. accept only explicitly mentioned `juchang-agentteams-dsh-task@1` envelopes;
4. run one isolated DSH Headless task;
5. use the official AgentTeams TeamHarness MCP server to call `ack_task` before execution;
6. validate and atomically write `receipt.json` under the AgentTeams shared root;
7. use official `submit_task` for `SUCCESS_WITH_NOTES` or `BLOCKED`;
8. mention the exact Team Leader identity in the Matrix task room.

`0.4.0` also includes an executable DSH Team Leader bridge. It creates the fixed four-role DAG, delegates only official `readyNodes`, synchronizes task inputs and receipts through AgentTeams MinIO, accepts only `check_task.effective=true` zero-write receipts, performs terminal readback, runs a DSH Leader summary, and completes the Project only after all four audited nodes are terminal. A completed run ends at `READY_FOR_HUMAN_REVIEW`, never at approval or publication.

`0.4.0` adds a business Supervisor beside the infrastructure Manager. One operator thread maps to one durable DSH Session; a custom runner uses the official `ctx.agents.create()` / `ctx.agents.resume()` boundary, emits redacted progress events, prepares four-role team dispatches, and pauses governed actions as explicit approve/edit/reject cards. The editor reaches it through an authenticated server-side Matrix gateway; DSH Web and Matrix credentials are never exposed to the browser.

The DSH Manager receives only the configured Admin DM. DSH converts natural language into a bounded Controller plan. Reads execute directly; mutations require an expiring exact confirmation; deletes additionally require the `DELETE` suffix. Controller responses are redacted before Matrix delivery, and a plan cannot select a non-DSH runtime, arbitrary image, or `AGENTTEAMS_*` environment value.

The repository includes a QwenPaw-free multi-arch Dockerfile and a version-locked AgentTeams v1.2.3 Manager/Worker patcher. The patch compiles against the official Controller and adds native `runtime: dsh` acceptance, credential-bearing Worker runtime projection, Team roster merges and Manager DM room injection. The image installs `@deepseek-ai/dsh@0.1.1-rc.2`, Python 3.12, the official TeamHarness MCP, Deep Agents ACP and MinIO Client, then boots as Manager, Team Leader or Worker.

## Target architecture

```text
Yixun editor
  -> AgentTeams Controller / Matrix / shared storage
  -> DSH Manager
  -> managed DSH Team Leader + four managed DSH Workers
  -> DSH Headless profiles
  -> optional Deep Agents ACP for complex evidence work
  -> AgentTeams Taskflow / Projectflow authoritative state
  -> HUMAN_REVIEW
```

## Run a Worker

```bash
npm install
node bin/worker.mjs --config /path/to/runtime.yaml
# Team Leader uses the same runtime contract:
node bin/leader.mjs --config /path/to/runtime.yaml
# Manager reads its controller-projected environment:
node bin/manager.mjs
```

Required environment variables are named by the AgentTeams runtime document. The normal contract uses:

- `AGENTTEAMS_MATRIX_URL`
- `AGENTTEAMS_WORKER_MATRIX_TOKEN`
- `AGENTTEAMS_WORKER_GATEWAY_KEY`
- `AGENTTEAMS_SHARED_DIR`
- `AGENTTEAMS_TEAMHARNESS_SERVER` (the official AgentTeams `plugins/teamharness/mcp/server.py`)
- `JUCHANG_DSH_BIN`

`AGENTTEAMS_SHARED_DIR` must be `<workspace>/shared`; set `AGENTTEAMS_WORKSPACE_DIR` only when inference is not sufficient. No upstream model key belongs in the Worker. DSH calls the AgentTeams AI Gateway with the Worker-scoped consumer token.

## Task message

The Worker only accepts a Matrix text message that mentions its exact Matrix user id and contains one line:

```text
JUCHANG_DSH_TASK: {"schema":"juchang-agentteams-dsh-task@1","projectId":"cloud_case_1","taskId":"cloud_case_1-02","role":"evidence_guard","inputPath":"tasks/cloud_case_1-02/workspace/input.json","workspacePath":"tasks/cloud_case_1-02/workspace","publicWriteAllowed":false}
```

Paths are resolved under `AGENTTEAMS_SHARED_DIR`. `receipt.json` is always written to the declared task workspace. Public writes, refunds, external messages, and AgentTeams state mutation are forbidden at this layer.

Evidence Guard invokes Deep Agents through ACP only when the deterministic gate sees at least three independent sources, mixed modalities, an evidence conflict, multiple research branches, or an explicit recovery requirement. ACP failure submits `BLOCKED`; it never silently falls back to the pre-ACP candidate.

## Compatibility

- AgentTeams target: the `agentteams.io/v1beta1` MemberRuntimeConfig / Matrix / Gateway contracts used by the competition deployment.
- DSH target: `0.1.1-rc.2` Headless CLI.
- Node.js: 22 or newer.

The runtime uses public Matrix HTTP, AgentTeams Controller REST, DSH CLI, ACP and the official Apache-2.0 TeamHarness MCP stdio boundary rather than private AgentTeams or DSH modules. It is not affiliated with or endorsed by DeepSeek or the AgentTeams maintainers.
