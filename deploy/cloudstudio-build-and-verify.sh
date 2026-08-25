#!/usr/bin/env bash
set -euo pipefail

runtime_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agentteams_source="${AGENTTEAMS_SOURCE:?Set AGENTTEAMS_SOURCE to the AgentTeams v1.2.3 checkout}"
controller_image="${JUCHANG_CONTROLLER_IMAGE:-juchang/agentteams-controller-dsh:v1.2.3-0.3.0}"
runtime_image="${JUCHANG_RUNTIME_IMAGE:-juchang/agentteams-dsh-runtime:0.3.0}"

test -f "${agentteams_source}/agentteams-controller/go.mod"
test -f "${agentteams_source}/helm/agentteams/Chart.yaml"
node "${runtime_root}/scripts/patch-agentteams-v1.2.3.mjs" --source "${agentteams_source}"

gofmt -w \
  "${agentteams_source}/agentteams-controller/api/v1beta1/types.go" \
  "${agentteams_source}/agentteams-controller/internal/backend/interface.go" \
  "${agentteams_source}/agentteams-controller/internal/controller/member_reconcile.go" \
  "${agentteams_source}/agentteams-controller/internal/controller/team_controller.go" \
  "${agentteams_source}/agentteams-controller/internal/service/worker_env.go" \
  "${agentteams_source}/agentteams-controller/cmd/agt/create.go" \
  "${agentteams_source}/agentteams-controller/cmd/agt/apply.go" \
  "${agentteams_source}/agentteams-controller/cmd/agt/update.go"

(
  cd "${agentteams_source}/agentteams-controller"
  go test ./internal/backend ./internal/controller ./internal/service ./cmd/agt
)

docker build -f "${agentteams_source}/agentteams-controller/Dockerfile" -t "${controller_image}" "${agentteams_source}/agentteams-controller"
docker build -t "${runtime_image}" "${runtime_root}"
docker image inspect "${controller_image}" "${runtime_image}" >/dev/null

printf '%s\n' "CLOUDSTUDIO_DSH_IMAGES_READY" "controller=${controller_image}" "runtime=${runtime_image}"
