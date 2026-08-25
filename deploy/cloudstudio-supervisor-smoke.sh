#!/usr/bin/env bash
set -euo pipefail

room="${AGENTTEAMS_MANAGER_ROOM_ID:?AGENTTEAMS_MANAGER_ROOM_ID is required}"
command_id="${JUCHANG_SUPERVISOR_COMMAND_ID:?JUCHANG_SUPERVISOR_COMMAND_ID is required}"
thread_id="${JUCHANG_SUPERVISOR_THREAD_ID:?JUCHANG_SUPERVISOR_THREAD_ID is required}"
text="${JUCHANG_SUPERVISOR_TEXT:?JUCHANG_SUPERVISOR_TEXT is required}"
context="${JUCHANG_SUPERVISOR_CONTEXT_JSON:?JUCHANG_SUPERVISOR_CONTEXT_JSON is required}"

jq -e 'type == "object"' <<<"${context}" >/dev/null
payload="$(jq -cn \
  --arg commandId "${command_id}" \
  --arg threadId "${thread_id}" \
  --arg text "${text}" \
  --argjson context "${context}" \
  '{schema:"juchang-case-command@1",commandId:$commandId,threadId:$threadId,text:$text,context:$context}')"

export JUCHANG_EXPECT_PREFIX="JUCHANG_CASE_RESULT:"
"$(dirname "$0")/cloudstudio-matrix-message.sh" "${room}" "JUCHANG_CASE_COMMAND: ${payload}"
