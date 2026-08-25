#!/usr/bin/env bash
set -euo pipefail

runtime_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agentteams_source="${AGENTTEAMS_SOURCE:?Set AGENTTEAMS_SOURCE to the AgentTeams v1.2.3 checkout}"
controller_image="${JUCHANG_CONTROLLER_IMAGE:-juchang/agentteams-controller-dsh:v1.2.3-0.3.0}"
runtime_image="${JUCHANG_RUNTIME_IMAGE:-juchang/agentteams-dsh-runtime:0.3.0}"
controller_base_image="${JUCHANG_CONTROLLER_BASE_IMAGE:-higress-registry.cn-hangzhou.cr.aliyuncs.com/agentteams/agentteams-embedded:v1.2.3}"

test -f "${agentteams_source}/agentteams-controller/go.mod"
test -f "${agentteams_source}/helm/agentteams/Chart.yaml"
test -d "${agentteams_source}/manager/agent"
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

controller_context="${agentteams_source}/agentteams-controller"
mkdir -p "${controller_context}/agent"
cp -R "${agentteams_source}/manager/agent/." "${controller_context}/agent/"
overlay_root="$(mktemp -d "${TMPDIR:-/tmp}/agentteams-controller-overlay.XXXXXX")"
cleanup() {
  if [[ -n "${overlay_root:-}" && "${overlay_root}" != "/" && -d "${overlay_root}" ]]; then
    rm -rf -- "${overlay_root}"
  fi
}
trap cleanup EXIT

docker build --target builder --output "type=local,dest=${overlay_root}/builder" -f "${controller_context}/Dockerfile" "${controller_context}"
cp "${overlay_root}/builder/agentteams-controller" "${overlay_root}/agentteams-controller"
cp "${overlay_root}/builder/agt" "${overlay_root}/agt"
mkdir -p "${overlay_root}/crd"
cp -R "${agentteams_source}/agentteams-controller/config/crd/." "${overlay_root}/crd/"
cp "${runtime_root}/deploy/Dockerfile.controller-overlay" "${overlay_root}/Dockerfile"
docker build --build-arg "BASE_IMAGE=${controller_base_image}" -t "${controller_image}" "${overlay_root}"
docker build -t "${runtime_image}" "${runtime_root}"
docker image inspect "${controller_image}" "${runtime_image}" >/dev/null

printf '%s\n' "CLOUDSTUDIO_DSH_IMAGES_READY" "controller=${controller_image}" "runtime=${runtime_image}"
