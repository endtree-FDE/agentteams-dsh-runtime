# GOAI Agent Infra submission entry

## Project

AgentTeams DSH Runtime is an Apache-2.0 community extension that adds a QwenPaw-free DSH Manager, Team Leader and Worker runtime to AgentTeams v1.2.3.

## Executable architecture

```text
Admin / Yixun editor
  -> DSH Manager (Controller resource administration + human confirmation)
  -> AgentTeams Controller / Matrix / Team / Project / Taskflow
  -> DSH Team Leader
  -> DSH Material Intake
  -> DSH Evidence Guard -> optional Deep Agents ACP
  -> DSH Entity Matcher
  -> DSH Approval Guard
  -> READY_FOR_HUMAN_REVIEW
```

AgentTeams remains authoritative for identity, membership, Matrix rooms, DAG state, Taskflow submission, Leader acceptance and Project completion. DSH owns model execution and bounded planning. Neither DSH nor Deep Agents can approve or publish.

## Build and verify

```bash
npm ci
npm test
npm run probe:teamharness -- --server /path/to/AgentTeams/plugins/teamharness/mcp/server.py --workspace /tmp/agentteams-dsh-probe
npm run patch:agentteams -- --source /path/to/AgentTeams-v1.2.3
cd /path/to/AgentTeams-v1.2.3/agentteams-controller
go test ./internal/backend ./internal/controller ./internal/service ./cmd/agt
docker build -t juchang/agentteams-dsh-runtime:0.3.1 /path/to/agentteams-dsh-runtime
```

Deploy the patched Controller, then use `deploy/cloudstudio-values.yaml`, `deploy/manager-dsh.yaml` when needed, and `deploy/agentteams-v1.2.3-dsh.yaml`.

## Evidence state

Locally verified evidence is listed in `STATUS-20260825.md`. CloudStudio image build, rollout, six live identities, one real Manager confirmation, one real four-Worker Project, one live complex ACP task and editor visual readback are mandatory before the final competition claim. Do not replace these with screenshots of manifests or local mocks.
