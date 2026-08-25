#!/usr/bin/env bash
set -euo pipefail

current="${JUCHANG_CONTROLLER_CONTAINER:-agentteams-controller}"
backup="${JUCHANG_CONTROLLER_BACKUP:-agentteams-controller-v122-backup}"
image="${JUCHANG_CONTROLLER_IMAGE:-juchang/agentteams-controller-dsh:v1.2.3-0.3.0}"
health="${JUCHANG_CONTROLLER_HEALTH_URL:-http://127.0.0.1:18080/healthz}"

[[ "${JUCHANG_CONFIRM_UPGRADE:-}" == "1" ]] || { echo "Set JUCHANG_CONFIRM_UPGRADE=1" >&2; exit 2; }
docker image inspect "${image}" >/dev/null
docker inspect "${current}" >/dev/null
! docker inspect "${backup}" >/dev/null 2>&1 || { echo "Backup container already exists: ${backup}" >&2; exit 2; }
curl -fsS "${health}" >/dev/null

env_file="$(mktemp "${TMPDIR:-/tmp}/agentteams-controller-env.XXXXXX")"
chmod 0600 "${env_file}"
cleanup() { rm -f -- "${env_file}"; }
trap cleanup EXIT
docker inspect "${current}" --format '{{range .Config.Env}}{{println .}}{{end}}' >"${env_file}"

rollback() {
  docker rm -f "${current}" >/dev/null 2>&1 || true
  docker rename "${backup}" "${current}"
  docker start "${current}" >/dev/null
  echo "AGENTTEAMS_CONTROLLER_UPGRADE_ROLLED_BACK" >&2
}

docker rename "${current}" "${backup}"
docker stop "${backup}" >/dev/null
if ! docker run -d \
  --name "${current}" \
  --restart unless-stopped \
  --network agentteams-net \
  --env-file "${env_file}" \
  -p 127.0.0.1:18001:8001 \
  -p 127.0.0.1:18080:8080 \
  -p 127.0.0.1:18088:8088 \
  -v agentteams-data:/data \
  -v /root/agentteams-manager:/root/agentteams-fs/agents/manager \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "${image}" >/dev/null; then
  rollback
  exit 1
fi

for _ in $(seq 1 60); do
  if curl -fsS "${health}" >/dev/null 2>&1; then
    echo "AGENTTEAMS_CONTROLLER_DSH_UPGRADE_READY"
    echo "active=${current} image=${image}"
    echo "rollback=${backup} (stopped)"
    exit 0
  fi
  sleep 2
done

rollback
exit 1
