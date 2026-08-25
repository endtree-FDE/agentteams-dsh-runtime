#!/usr/bin/env bash
set -euo pipefail

current="${JUCHANG_MANAGER_CONTAINER:-agentteams-manager}"
source_container="${JUCHANG_MANAGER_STATE_SOURCE:?Set JUCHANG_MANAGER_STATE_SOURCE to a stopped Manager that owns the authoritative state}"
image="${JUCHANG_RUNTIME_IMAGE:-juchang/agentteams-dsh-runtime:0.4.6}"
state_volume="${JUCHANG_MANAGER_STATE_VOLUME:-juchang-dsh-manager-state}"
state_dir="${JUCHANG_SUPERVISOR_STATE_DIR:-/root/agentteams-fs/agents/manager/supervisor}"
stamp="${JUCHANG_MANAGER_BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
backup="${current}-backup-novol-${stamp}"

[[ "${JUCHANG_CONFIRM_MANAGER_STATE_MIGRATION:-}" == "1" ]] || {
  echo "Set JUCHANG_CONFIRM_MANAGER_STATE_MIGRATION=1" >&2
  exit 2
}

docker image inspect "${image}" >/dev/null
docker inspect "${current}" >/dev/null
docker inspect "${source_container}" >/dev/null
! docker inspect "${backup}" >/dev/null 2>&1 || {
  echo "Backup container already exists: ${backup}" >&2
  exit 2
}

seed_dir="$(mktemp -d "${TMPDIR:-/tmp}/agentteams-manager-seed.XXXXXX")"
env_file="$(mktemp "${TMPDIR:-/tmp}/agentteams-manager-env.XXXXXX")"
chmod 0700 "${seed_dir}"
chmod 0600 "${env_file}"
cleanup() {
  rm -rf -- "${seed_dir}"
  rm -f -- "${env_file}"
}
trap cleanup EXIT

docker volume inspect "${state_volume}" >/dev/null 2>&1 || docker volume create "${state_volume}" >/dev/null
state_count="$(docker run --rm --entrypoint sh -v "${state_volume}:/state" "${image}" -c 'find /state -type f | wc -l')"
if [[ "${state_count}" == "0" ]]; then
  docker cp "${source_container}:${state_dir}/." "${seed_dir}"
  source_count="$(find "${seed_dir}" -type f | wc -l)"
  [[ "${source_count}" -gt 0 ]] || {
    echo "Authoritative Manager state is empty" >&2
    exit 2
  }
  docker run --rm --entrypoint sh \
    -v "${state_volume}:/state" \
    -v "${seed_dir}:/seed:ro" \
    "${image}" -c 'cp -a /seed/. /state/'
  state_count="$(docker run --rm --entrypoint sh -v "${state_volume}:/state" "${image}" -c 'find /state -type f | wc -l')"
fi
[[ "${state_count}" -gt 0 ]] || { echo "Manager state volume is empty" >&2; exit 2; }

docker inspect "${current}" --format '{{range .Config.Env}}{{println .}}{{end}}' >"${env_file}"
network="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "${current}")"
restart="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "${current}")"
restart="${restart:-no}"
port_args=()
while IFS='|' read -r container_port host_ip host_port; do
  [[ -n "${container_port}" && -n "${host_port}" ]] || continue
  if [[ -n "${host_ip}" ]]; then
    port_args+=( -p "${host_ip}:${host_port}:${container_port}" )
  else
    port_args+=( -p "${host_port}:${container_port}" )
  fi
done < <(docker inspect -f='{{range $port, $bindings := .HostConfig.PortBindings}}{{range $bindings}}{{printf "%s|%s|%s\n" $port .HostIp .HostPort}}{{end}}{{end}}' "${current}")

rollback() {
  docker rm -f "${current}" >/dev/null 2>&1 || true
  docker rename "${backup}" "${current}"
  docker start "${current}" >/dev/null
  echo "AGENTTEAMS_DSH_MANAGER_STATE_MIGRATION_ROLLED_BACK" >&2
}

docker rename "${current}" "${backup}"
docker stop "${backup}" >/dev/null 2>&1 || true
run_args=(
  docker run -d
  --name "${current}"
  --restart "${restart}"
  --network "${network}"
  --env-file "${env_file}"
  --volumes-from "${backup}"
  -v "${state_volume}:${state_dir}"
)
run_args+=("${port_args[@]}")
run_args+=("${image}")
if ! "${run_args[@]}" >/dev/null; then
  rollback
  exit 1
fi

for _ in $(seq 1 45); do
  if docker logs "${current}" 2>&1 | grep -q AGENTTEAMS_DSH_MANAGER_READY; then
    trap - EXIT
    cleanup
    echo "AGENTTEAMS_DSH_MANAGER_STATE_PERSISTED"
    echo "active=${current} image=${image} state_files=${state_count}"
    echo "rollback=${backup} (stopped)"
    exit 0
  fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "${current}")" != "true" ]]; then
    break
  fi
  sleep 2
done

rollback
exit 1
