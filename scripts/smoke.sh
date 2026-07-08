#!/usr/bin/env bash
# End-to-end smoke against a live crew-bus Worker (local wrangler dev or bus.internal).
set -euo pipefail

API_URL="${CREW_BUS_API_URL:-http://localhost:8787}"
TOKEN="${CREW_BUS_API_TOKEN:?CREW_BUS_API_TOKEN is required}"

auth=(-H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json")

echo "== health =="
curl -sf "${API_URL}/health" | jq .

echo "== send =="
send_resp="$(curl -sf "${auth[@]}" -d '{
  "channel": "general",
  "to": ["*"],
  "type": "ping",
  "body": "crew-bus smoke ping"
}' "${API_URL}/api/send")"
echo "${send_resp}" | jq .
msg_id="$(echo "${send_resp}" | jq -r .message.id)"
thread_id="$(echo "${send_resp}" | jq -r .message.thread_id)"

echo "== poll =="
poll_resp="$(curl -sf "${auth[@]}" "${API_URL}/api/poll?channel=general&limit=5")"
echo "${poll_resp}" | jq .
cursor="$(echo "${poll_resp}" | jq -r .cursor // empty)"

echo "== poll exclusive since cursor =="
if [ -n "${cursor}" ]; then
  curl -sf "${auth[@]}" "${API_URL}/api/poll?channel=general&since=${cursor}" | jq .
fi

echo "== thread =="
curl -sf "${auth[@]}" "${API_URL}/api/thread/${thread_id}" | jq .

echo "== ack =="
curl -sf "${auth[@]}" -d "{\"message_id\":\"${msg_id}\",\"body\":\"smoke ack\"}" "${API_URL}/api/ack" | jq .

echo "== channels =="
curl -sf "${auth[@]}" "${API_URL}/api/channels" | jq .

echo "== mark_seen =="
curl -sf "${auth[@]}" -d '{"channel":"general"}' "${API_URL}/api/mark_seen" | jq .

echo "smoke ok"
