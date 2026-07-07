#!/usr/bin/env bash
set -euo pipefail

API=${API:-http://localhost:8787}

echo "health"
curl -s "$API/health" | jq .

echo "session"
SESSION=$(curl -s -X POST "$API/api/sessions" -H 'Content-Type: application/json' -d '{"userId":"demo-user"}')
echo "$SESSION" | jq .
SESSION_ID=$(echo "$SESSION" | jq -r .id)

echo "task-card"
RUN=$(curl -s -X POST "$API/api/workflows/writing/start" -H 'Content-Type: application/json' -d "{\"userId\":\"demo-user\",\"sessionId\":\"$SESSION_ID\",\"message\":\"写一篇关于宝黛关系的长文，半文半白\",\"targetStage\":\"task-card\"}")
echo "$RUN" | jq .run.status
RUN_ID=$(echo "$RUN" | jq -r .run.id)
GATE_ID=$(echo "$RUN" | jq -r '.humanGates[] | select(.status=="pending") | .id' | head -n 1)

echo "wait until workflow reaches user confirmation"
for _ in $(seq 1 40); do
  RUN=$(curl -s "$API/api/workflows/$RUN_ID")
  STATUS=$(echo "$RUN" | jq -r .run.status)
  echo "status=$STATUS"
  if [ "$STATUS" = "waiting" ]; then break; fi
  sleep 0.25
done

echo "$RUN" | jq .article.taskCard.topic

echo "resume task-card confirmation"
curl -s -X POST "$API/api/workflows/$RUN_ID/human-gates/$GATE_ID/resolve" -H 'Content-Type: application/json' -d '{"userId":"demo-user","decision":"accept"}' | jq .run.status

echo "knowledge search"
curl -s -X POST "$API/api/knowledge/search" -H 'Content-Type: application/json' -d '{"query":"宝黛关系","limit":2}' | jq '.[].sourceRef'
