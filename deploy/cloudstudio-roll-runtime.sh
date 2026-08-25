#!/usr/bin/env bash
set -euo pipefail

from_image="${JUCHANG_RUNTIME_FROM_IMAGE:-juchang/agentteams-dsh-runtime:0.4.5}"
to_image="${JUCHANG_RUNTIME_TO_IMAGE:-juchang/agentteams-dsh-runtime:0.4.6}"
stamp="${JUCHANG_RUNTIME_BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
targets=(
  agentteams-manager
  agentteams-worker-juchang-v14-lead
  agentteams-worker-juchang-v14-material-intake
  agentteams-worker-juchang-v14-evidence-guard
  agentteams-worker-juchang-v14-entity-matcher
  agentteams-worker-juchang-v14-approval-guard
)

[[ "${JUCHANG_CONFIRM_RUNTIME_ROLL:-}" == "1" ]] || {
  echo "Set JUCHANG_CONFIRM_RUNTIME_ROLL=1" >&2
  exit 2
}

docker image inspect "${to_image}" >/dev/null

declare -A backups=()
declare -a pending=()
declare -a upgraded=()
declare -a env_files=()

cleanup() {
  local file
  for file in "${env_files[@]:-}"; do
    rm -f -- "${file}"
  done
}

rollback() {
  local index target backup
  for ((index=${#upgraded[@]}-1; index>=0; index--)); do
    target="${upgraded[index]}"
    backup="${backups[${target}]}"
    docker rm -f "${target}" >/dev/null 2>&1 || true
    docker rename "${backup}" "${target}"
    docker start "${target}" >/dev/null
  done
  echo "AGENTTEAMS_DSH_RUNTIME_ROLLBACK_COMPLETE" >&2
}

on_exit() {
  local status=$?
  if [[ ${status} -ne 0 && ${#upgraded[@]} -gt 0 ]]; then
    rollback
  fi
  cleanup
  exit "${status}"
}
trap on_exit EXIT

for target in "${targets[@]}"; do
  docker inspect "${target}" >/dev/null
  current_image="$(docker inspect -f '{{.Config.Image}}' "${target}")"
  if [[ "${current_image}" == "${to_image}" ]]; then
    echo "already_current=${target}"
    continue
  fi
  [[ "${current_image}" == "${from_image}" ]] || {
    echo "Unexpected image for ${target}: ${current_image}" >&2
    exit 2
  }
  backup="${target}-backup-prev-${stamp}"
  ! docker inspect "${backup}" >/dev/null 2>&1 || {
    echo "Backup container already exists: ${backup}" >&2
    exit 2
  }
  backups["${target}"]="${backup}"
  pending+=("${target}")
done

if [[ ${#pending[@]} -eq 0 ]]; then
  echo "AGENTTEAMS_DSH_RUNTIME_ALREADY_CURRENT"
  trap - EXIT
  cleanup
  exit 0
fi

for target in "${pending[@]}"; do
  backup="${backups[${target}]}"
  env_file="$(mktemp "${TMPDIR:-/tmp}/agentteams-runtime-env.XXXXXX")"
  chmod 0600 "${env_file}"
  env_files+=("${env_file}")
  docker inspect "${target}" --format '{{range .Config.Env}}{{println .}}{{end}}' >"${env_file}"
  network="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "${target}")"
  restart="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "${target}")"
  restart="${restart:-no}"
  port_args=()
  while IFS='|' read -r container_port host_ip host_port; do
    [[ -n "${container_port}" && -n "${host_port}" ]] || continue
    if [[ -n "${host_ip}" ]]; then
      port_args+=( -p "${host_ip}:${host_port}:${container_port}" )
    else
      port_args+=( -p "${host_port}:${container_port}" )
    fi
  done < <(docker inspect -f='{{range $port, $bindings := .HostConfig.PortBindings}}{{range $bindings}}{{printf "%s|%s|%s\n" $port .HostIp .HostPort}}{{end}}{{end}}' "${target}")

  docker rename "${target}" "${backup}"
  docker stop "${backup}" >/dev/null

  run_args=(
    docker run -d
    --name "${target}"
    --restart "${restart}"
    --network "${network}"
    --env-file "${env_file}"
    --volumes-from "${backup}"
  )
  run_args+=("${port_args[@]}")
  run_args+=("${to_image}")
  "${run_args[@]}" >/dev/null
  upgraded+=("${target}")

  case "${target}" in
    agentteams-manager) marker="AGENTTEAMS_DSH_MANAGER_READY" ;;
    agentteams-worker-juchang-v14-lead) marker="AGENTTEAMS_DSH_LEADER_READY" ;;
    *) marker="AGENTTEAMS_DSH_WORKER_READY" ;;
  esac
  ready=0
  for _ in $(seq 1 45); do
    if docker logs "${target}" 2>&1 | grep -q "${marker}"; then
      ready=1
      break
    fi
    if [[ "$(docker inspect -f '{{.State.Running}}' "${target}")" != "true" ]]; then
      break
    fi
    sleep 2
  done
  [[ ${ready} -eq 1 ]] || {
    echo "Runtime readiness failed: ${target}" >&2
    exit 1
  }
  echo "ready=${target} image=${to_image}"
done

trap - EXIT
cleanup
echo "AGENTTEAMS_DSH_RUNTIME_ROLL_READY"
for target in "${upgraded[@]}"; do
  echo "rollback=${backups[${target}]} (stopped)"
done
