#!/usr/bin/env bash
set -euo pipefail

[[ "$#" == "2" ]] || { echo "Usage: $0 ROOM_ID MESSAGE" >&2; exit 2; }
room="$1"
message="$2"
matrix_url="${AGENTTEAMS_MATRIX_URL:?AGENTTEAMS_MATRIX_URL is required}"
admin_user="${AGENTTEAMS_ADMIN_USER:?AGENTTEAMS_ADMIN_USER is required}"
admin_password="${AGENTTEAMS_ADMIN_PASSWORD:?AGENTTEAMS_ADMIN_PASSWORD is required}"
manager_user="${AGENTTEAMS_MANAGER_MATRIX_USER_ID:-@manager:${AGENTTEAMS_MATRIX_DOMAIN:?AGENTTEAMS_MATRIX_DOMAIN is required}}"
token=""

cleanup() {
  if [[ -n "${token}" ]]; then
    curl -sS -X POST -H "Authorization: Bearer ${token}" "${matrix_url}/_matrix/client/v3/logout" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

login_payload="$(jq -cn --arg user "${admin_user}" --arg password "${admin_password}" '{type:"m.login.password",identifier:{type:"m.id.user",user:$user},password:$password,initial_device_display_name:"juchang-cloud-smoke"}')"
token="$(curl -fsS -X POST -H 'Content-Type: application/json' -d "${login_payload}" "${matrix_url}/_matrix/client/v3/login" | jq -er '.access_token')"
since="$(curl -fsS -H "Authorization: Bearer ${token}" "${matrix_url}/_matrix/client/v3/sync?timeout=0" | jq -er '.next_batch')"
room_uri="$(jq -rn --arg value "${room}" '$value|@uri')"
message_payload="$(jq -cn --arg body "${message}" '{msgtype:"m.text",body:$body}')"
curl -fsS -X PUT -H "Authorization: Bearer ${token}" -H 'Content-Type: application/json' -d "${message_payload}" \
  "${matrix_url}/_matrix/client/v3/rooms/${room_uri}/send/m.room.message/$(date +%s%N)" >/dev/null

for _ in $(seq 1 18); do
  response="$(curl -fsS -G -H "Authorization: Bearer ${token}" --data-urlencode "since=${since}" --data-urlencode 'timeout=5000' "${matrix_url}/_matrix/client/v3/sync")"
  since="$(jq -er '.next_batch' <<<"${response}")"
  body="$(jq -r --arg room "${room}" --arg sender "${manager_user}" '.rooms.join[$room].timeline.events[]? | select(.type=="m.room.message" and .sender==$sender) | .content.body // empty' <<<"${response}" | grep '^MANAGER_' | tail -n 1 || true)"
  if [[ -n "${body}" ]]; then
    printf '%s\n' "${body}"
    exit 0
  fi
done

echo "Timed out waiting for DSH Manager response" >&2
exit 1
