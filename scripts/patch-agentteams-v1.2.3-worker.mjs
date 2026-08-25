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
patch(
  "agentteams-controller/internal/service/worker_env.go",
  '"AGENTTEAMS_MANAGER_MATRIX_TOKEN": prov.MatrixToken,\n',
  '"AGENTTEAMS_MANAGER_MATRIX_TOKEN":   prov.MatrixToken,\n\t\t"AGENTTEAMS_MANAGER_ROOM_ID":        prov.RoomID,\n',
);
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
