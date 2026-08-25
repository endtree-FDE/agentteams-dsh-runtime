#!/usr/bin/env bash
set -euo pipefail

test "${JUCHANG_CONFIRM_DEPLOY:-}" = "1" || {
  echo "Set JUCHANG_CONFIRM_DEPLOY=1 to authorize the Kubernetes write." >&2
  exit 2
}

runtime_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agentteams_source="${AGENTTEAMS_SOURCE:?Set AGENTTEAMS_SOURCE to the patched AgentTeams v1.2.3 checkout}"
namespace="${AGENTTEAMS_NAMESPACE:-agentteams}"
release="${AGENTTEAMS_RELEASE:-agentteams}"
controller_repository="${JUCHANG_CONTROLLER_REPOSITORY:-juchang/agentteams-controller-dsh}"
controller_tag="${JUCHANG_CONTROLLER_TAG:-v1.2.3-0.3.0}"
runtime_image="${JUCHANG_RUNTIME_IMAGE:-juchang/agentteams-dsh-runtime:0.4.5}"

if command -v kind >/dev/null 2>&1 && kind get clusters 2>/dev/null | grep -q .; then
  kind_cluster="${KIND_CLUSTER_NAME:-$(kind get clusters | head -n 1)}"
  kind load docker-image --name "${kind_cluster}" "${controller_repository}:${controller_tag}" "${runtime_image}"
fi

helm upgrade --install "${release}" "${agentteams_source}/helm/agentteams" \
  --namespace "${namespace}" \
  --create-namespace \
  --values "${runtime_root}/deploy/cloudstudio-values.yaml" \
  --set "controller.image.repository=${controller_repository}" \
  --set "controller.image.tag=${controller_tag}" \
  --set "manager.image.repository=${runtime_image%:*}" \
  --set "manager.image.tag=${runtime_image##*:}" \
  --wait \
  --timeout 15m

kubectl apply --namespace "${namespace}" -f "${runtime_root}/deploy/manager-dsh.yaml"
kubectl apply --namespace "${namespace}" -f "${runtime_root}/deploy/agentteams-v1.2.3-dsh.yaml"
kubectl get managers,workers,teams --namespace "${namespace}" -o wide

echo "CLOUDSTUDIO_DSH_RESOURCES_APPLIED"
