#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const expectedCommit = "223ddc2b8073e4c8b93bcbb15e1d717f196c04d9";

function sourceArgument() {
  const index = process.argv.indexOf("--source");
  if (index < 0 || !process.argv[index + 1]) throw new Error("Usage: patch-agentteams-v1.2.3-worker.mjs --source /path/to/AgentTeams-v1.2.3");
  return path.resolve(process.argv[index + 1]);
}

function replaceExact(root, relative, before, after) {
  const filename = path.join(root, relative);
  const value = fs.readFileSync(filename, "utf8");
  const newline = value.includes("\r\n") ? "\r\n" : "\n";
  const normalized = value.replaceAll("\r\n", "\n");
  if (normalized.includes(after)) return false;
  const occurrences = normalized.split(before).length - 1;
  if (occurrences !== 1) throw new Error(`${relative}: expected one patch anchor, found ${occurrences}`);
  fs.writeFileSync(filename, normalized.replace(before, after).replaceAll("\n", newline), "utf8");
  return true;
}

function writeIfMissing(root, relative, content) {
  const filename = path.join(root, relative);
  if (fs.existsSync(filename)) {
    if (fs.readFileSync(filename, "utf8") !== content) throw new Error(`${relative}: generated file differs from expected content`);
    return false;
  }
  fs.writeFileSync(filename, content, "utf8");
  return true;
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

const root = sourceArgument();
if (git(root, ["rev-parse", "HEAD"]) !== expectedCommit) throw new Error("AgentTeams source must be the audited v1.2.3 commit");

const changed = [];
const patch = (relative, before, after) => {
  if (replaceExact(root, relative, before, after)) changed.push(relative);
};

patch(
  "agentteams-controller/internal/backend/interface.go",
  '\tRuntimeQwenPaw   = "qwenpaw"\n',
  '\tRuntimeQwenPaw   = "qwenpaw"\n\tRuntimeDSH       = "dsh"\n',
);
patch(
  "agentteams-controller/internal/backend/interface.go",
  "return r == \"\" || r == RuntimeOpenClaw || r == RuntimeCopaw || r == RuntimeHermes || r == RuntimeOpenHuman || r == RuntimeQwenPaw",
  "return r == \"\" || r == RuntimeOpenClaw || r == RuntimeCopaw || r == RuntimeHermes || r == RuntimeOpenHuman || r == RuntimeQwenPaw || r == RuntimeDSH",
);
patch(
  "agentteams-controller/api/v1beta1/types.go",
  "// openclaw | copaw | hermes | qwenpaw (default: openclaw)",
  "// openclaw | copaw | hermes | qwenpaw | dsh (default: openclaw)",
);
patch(
  "agentteams-controller/api/v1beta1/types.go",
  "// openclaw | copaw | qwenpaw\n",
  "// openclaw | copaw | qwenpaw | dsh\n",
);
for (const relative of [
  "agentteams-controller/config/crd/workers.agentteams.io.yaml",
  "helm/agentteams/crds/workers.agentteams.io.yaml",
]) {
  patch(relative, "enum: [openclaw, copaw, hermes, qwenpaw]", "enum: [openclaw, copaw, hermes, qwenpaw, dsh]");
}
for (const relative of [
  "agentteams-controller/config/crd/managers.agentteams.io.yaml",
  "helm/agentteams/crds/managers.agentteams.io.yaml",
]) {
  patch(relative, "enum: [openclaw, copaw, qwenpaw]", "enum: [openclaw, copaw, qwenpaw, dsh]");
}
patch(
  "agentteams-controller/internal/controller/member_reconcile.go",
  "if effectiveRuntime == backend.RuntimeQwenPaw || m.DeployMode == v1beta1.DeployModeEdge {",
  "if effectiveRuntime == backend.RuntimeQwenPaw || effectiveRuntime == backend.RuntimeDSH || m.DeployMode == v1beta1.DeployModeEdge {",
);
patch(
  "agentteams-controller/internal/controller/member_reconcile.go",
  "\t\tif m.DeployMode == v1beta1.DeployModeEdge {\n\t\t\truntime = runtimeRemoteManagedLocal\n\t\t\tmatrixAccessToken = state.ProvResult.MatrixToken\n\t\t\tgatewayKey = state.ProvResult.GatewayKey\n\t\t}",
  "\t\tif m.DeployMode == v1beta1.DeployModeEdge {\n\t\t\truntime = runtimeRemoteManagedLocal\n\t\t\tmatrixAccessToken = state.ProvResult.MatrixToken\n\t\t\tgatewayKey = state.ProvResult.GatewayKey\n\t\t} else if effectiveRuntime == backend.RuntimeDSH {\n\t\t\tmatrixAccessToken = state.ProvResult.MatrixToken\n\t\t\tgatewayKey = state.ProvResult.GatewayKey\n\t\t}",
);
patch(
  "agentteams-controller/internal/controller/team_controller.go",
  "if runtime != backend.RuntimeQwenPaw && runtime != backend.RuntimeCopaw && deployMode != v1beta1.DeployModeEdge {",
  "if runtime != backend.RuntimeQwenPaw && runtime != backend.RuntimeCopaw && runtime != backend.RuntimeDSH && deployMode != v1beta1.DeployModeEdge {",
);
patch(
  "agentteams-controller/internal/controller/team_controller.go",
  "\t\tif deployMode == v1beta1.DeployModeEdge {\n\t\t\treq.Runtime = runtimeRemoteManagedLocal\n\t\t\tif err := r.Deployer.MergeMemberRuntimeTeamContext(ctx, req); err != nil {",
  "\t\tif deployMode == v1beta1.DeployModeEdge || runtime == backend.RuntimeDSH {\n\t\t\tif deployMode == v1beta1.DeployModeEdge {\n\t\t\t\treq.Runtime = runtimeRemoteManagedLocal\n\t\t\t}\n\t\t\tif err := r.Deployer.MergeMemberRuntimeTeamContext(ctx, req); err != nil {",
);
const workerEnvRelative = "agentteams-controller/internal/service/worker_env.go";
const workerEnv = fs.readFileSync(path.join(root, workerEnvRelative), "utf8");
if (!workerEnv.includes('"AGENTTEAMS_MANAGER_ROOM_ID"')) {
  patch(
    workerEnvRelative,
    '"AGENTTEAMS_MANAGER_MATRIX_TOKEN": prov.MatrixToken,\n',
    '"AGENTTEAMS_MANAGER_MATRIX_TOKEN":   prov.MatrixToken,\n\t\t"AGENTTEAMS_MANAGER_ROOM_ID":        prov.RoomID,\n',
  );
}
patch(
  "agentteams-controller/internal/server/types.go",
  'type CreateWorkerRequest struct {\n\tName          string                             `json:"name"`\n\tWorkerName    string                             `json:"workerName,omitempty"`\n\tModel         string                             `json:"model,omitempty"`\n\tModelProvider string                             `json:"modelProvider,omitempty"`\n\tRuntime       string                             `json:"runtime,omitempty"`\n\tImage         string                             `json:"image,omitempty"`\n',
  'type CreateWorkerRequest struct {\n\tName          string                             `json:"name"`\n\tWorkerName    string                             `json:"workerName,omitempty"`\n\tModel         string                             `json:"model,omitempty"`\n\tModelProvider string                             `json:"modelProvider,omitempty"`\n\tRuntime       string                             `json:"runtime,omitempty"`\n\tImage         string                             `json:"image,omitempty"`\n\tEnv           map[string]string                  `json:"env,omitempty"`\n',
);
patch(
  "agentteams-controller/internal/server/types.go",
  'type UpdateWorkerRequest struct {\n\tWorkerName    string                             `json:"workerName,omitempty"`\n\tModel         string                             `json:"model,omitempty"`\n\tModelProvider string                             `json:"modelProvider,omitempty"`\n\tRuntime       string                             `json:"runtime,omitempty"`\n\tImage         string                             `json:"image,omitempty"`\n',
  'type UpdateWorkerRequest struct {\n\tWorkerName    string                             `json:"workerName,omitempty"`\n\tModel         string                             `json:"model,omitempty"`\n\tModelProvider string                             `json:"modelProvider,omitempty"`\n\tRuntime       string                             `json:"runtime,omitempty"`\n\tImage         string                             `json:"image,omitempty"`\n\tEnv           map[string]string                  `json:"env,omitempty"`\n',
);
patch(
  "agentteams-controller/internal/server/types.go",
  'type CreateManagerRequest struct {\n\tName          string                             `json:"name"`\n\tModel         string                             `json:"model"`\n\tModelProvider string                             `json:"modelProvider,omitempty"`\n\tRuntime       string                             `json:"runtime,omitempty"`\n\tImage         string                             `json:"image,omitempty"`\n',
  'type CreateManagerRequest struct {\n\tName          string                             `json:"name"`\n\tModel         string                             `json:"model"`\n\tModelProvider string                             `json:"modelProvider,omitempty"`\n\tRuntime       string                             `json:"runtime,omitempty"`\n\tImage         string                             `json:"image,omitempty"`\n\tEnv           map[string]string                  `json:"env,omitempty"`\n',
);
patch(
  "agentteams-controller/internal/server/types.go",
  'type UpdateManagerRequest struct {\n\tModel         string                             `json:"model,omitempty"`\n\tModelProvider string                             `json:"modelProvider,omitempty"`\n\tRuntime       string                             `json:"runtime,omitempty"`\n\tImage         string                             `json:"image,omitempty"`\n',
  'type UpdateManagerRequest struct {\n\tModel         string                             `json:"model,omitempty"`\n\tModelProvider string                             `json:"modelProvider,omitempty"`\n\tRuntime       string                             `json:"runtime,omitempty"`\n\tImage         string                             `json:"image,omitempty"`\n\tEnv           map[string]string                  `json:"env,omitempty"`\n',
);
patch(
  "agentteams-controller/internal/server/resource_handler.go",
  '\t\t\tResources:        req.Resources,\n\t\t\tContainerManaged: &containerManaged,\n',
  '\t\t\tResources:        req.Resources,\n\t\t\tEnv:              req.Env,\n\t\t\tContainerManaged: &containerManaged,\n',
);
patch(
  "agentteams-controller/internal/server/resource_handler.go",
  '\t\tif req.Resources != nil {\n\t\t\tworker.Spec.Resources = req.Resources\n\t\t}\n\t\tif req.ContainerManaged != nil {\n',
  '\t\tif req.Resources != nil {\n\t\t\tworker.Spec.Resources = req.Resources\n\t\t}\n\t\tif req.Env != nil {\n\t\t\tworker.Spec.Env = req.Env\n\t\t}\n\t\tif req.ContainerManaged != nil {\n',
);
patch(
  "agentteams-controller/internal/server/resource_handler.go",
  '\t\t\tState:         req.State,\n\t\t\tResources:     req.Resources,\n\t\t},\n',
  '\t\t\tState:         req.State,\n\t\t\tResources:     req.Resources,\n\t\t\tEnv:           req.Env,\n\t\t},\n',
);
patch(
  "agentteams-controller/internal/server/resource_handler.go",
  '\t\tif req.Resources != nil {\n\t\t\tmgr.Spec.Resources = req.Resources\n\t\t}\n\n\t\tif err := h.client.Update(ctx, &mgr); err != nil {\n',
  '\t\tif req.Resources != nil {\n\t\t\tmgr.Spec.Resources = req.Resources\n\t\t}\n\t\tif req.Env != nil {\n\t\t\tmgr.Spec.Env = req.Env\n\t\t}\n\n\t\tif err := h.client.Update(ctx, &mgr); err != nil {\n',
);
const envApiTest = `package server

import (
\t"bytes"
\t"context"
\t"net/http"
\t"net/http/httptest"
\t"testing"

\tv1beta1 "github.com/agentscope-ai/AgentTeams/agentteams-controller/api/v1beta1"
\t"sigs.k8s.io/controller-runtime/pkg/client"
\t"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func TestDSHApplyPreservesWorkerAndManagerEnv(t *testing.T) {
\tscheme := newServerTestScheme(t)
\tk8sClient := fake.NewClientBuilder().WithScheme(scheme).Build()
\thandler := NewResourceHandler(k8sClient, "default", nil, "")

\tworkerReq := httptest.NewRequest(http.MethodPost, "/api/v1/workers", bytes.NewReader([]byte(\`{"name":"dsh-worker","model":"step","runtime":"dsh","env":{"JUCHANG_DSH_ROLE":"material_intake"}}\`)))
\tworkerRec := httptest.NewRecorder()
\thandler.CreateWorker(workerRec, workerReq)
\tif workerRec.Code != http.StatusCreated { t.Fatalf("create worker: %d %s", workerRec.Code, workerRec.Body.String()) }
\tvar worker v1beta1.Worker
\tif err := k8sClient.Get(context.Background(), client.ObjectKey{Name: "dsh-worker", Namespace: "default"}, &worker); err != nil { t.Fatal(err) }
\tif worker.Spec.Env["JUCHANG_DSH_ROLE"] != "material_intake" { t.Fatalf("worker env=%v", worker.Spec.Env) }

\tmanagerReq := httptest.NewRequest(http.MethodPost, "/api/v1/managers", bytes.NewReader([]byte(\`{"name":"default","model":"step","runtime":"dsh","env":{"JUCHANG_DSH_WORKER_IMAGE":"juchang/runtime:test"}}\`)))
\tmanagerRec := httptest.NewRecorder()
\thandler.CreateManager(managerRec, managerReq)
\tif managerRec.Code != http.StatusCreated { t.Fatalf("create manager: %d %s", managerRec.Code, managerRec.Body.String()) }
\tvar manager v1beta1.Manager
\tif err := k8sClient.Get(context.Background(), client.ObjectKey{Name: "default", Namespace: "default"}, &manager); err != nil { t.Fatal(err) }
\tif manager.Spec.Env["JUCHANG_DSH_WORKER_IMAGE"] != "juchang/runtime:test" { t.Fatalf("manager env=%v", manager.Spec.Env) }
}
`;
if (writeIfMissing(root, "agentteams-controller/internal/server/dsh_env_api_test.go", envApiTest)) changed.push("agentteams-controller/internal/server/dsh_env_api_test.go");
patch(
  "agentteams-controller/cmd/agt/create.go",
  '"Agent runtime (openclaw|copaw|qwenpaw|hermes|openhuman)"',
  '"Agent runtime (openclaw|copaw|qwenpaw|hermes|openhuman|dsh)"',
);
patch(
  "agentteams-controller/cmd/agt/create.go",
  '"Agent runtime (openclaw|copaw|qwenpaw)"',
  '"Agent runtime (openclaw|copaw|qwenpaw|dsh)"',
);
patch(
  "agentteams-controller/cmd/agt/apply.go",
  '"Agent runtime (openclaw|copaw|qwenpaw|hermes|openhuman)"',
  '"Agent runtime (openclaw|copaw|qwenpaw|hermes|openhuman|dsh)"',
);
patch(
  "agentteams-controller/cmd/agt/update.go",
  '"Agent runtime (openclaw|copaw|qwenpaw|hermes|openhuman)"',
  '"Agent runtime (openclaw|copaw|qwenpaw|hermes|openhuman|dsh)"',
);
patch(
  "agentteams-controller/cmd/agt/update.go",
  '"Agent runtime (openclaw|copaw|hermes|openhuman)"',
  '"Agent runtime (openclaw|copaw|qwenpaw|dsh)"',
);

process.stdout.write(`${JSON.stringify({ marker: "AGENTTEAMS_V123_DSH_RUNTIME_PATCHED", source: root, commit: expectedCommit, changed })}\n`);
