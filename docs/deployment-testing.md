# 部署与测试说明

## 本地开发

```bash
cp .env.example .env
npm install
npm run build
npm run test
npm run dev
```

前端：

```bash
npm run dev:web
```

## 推荐本地配置

```bash
WORKFLOW_EXECUTION_MODE=async
WORKFLOW_QUEUE_DRIVER=local
ENABLE_WORKERS=true
RUNNER_CONCURRENCY=2
RAG_PROVIDER=local
LLM_PROVIDER=mock
```

## Redis 队列测试

启动 Redis：

```bash
docker run --rm -p 6379:6379 redis:7-alpine
```

`.env`：

```bash
WORKFLOW_EXECUTION_MODE=async
WORKFLOW_QUEUE_DRIVER=redis
REDIS_URL=redis://localhost:6379
```

启动 API 后检查：

```bash
curl http://localhost:8787/api/queue/status
```

## HTTP RAG 测试

启动一个通用兼容服务，提供：

```text
POST /search
POST /refs
```

`.env`：

```bash
RAG_PROVIDER=http
RAG_BASE_URL=http://localhost:9000
```

接入 `tonglingyu-knownledge` 现有 retriever HTTP 服务时：

```bash
RAG_PROVIDER=tonglingyu
RAG_BASE_URL=http://127.0.0.1:8765
RAG_SEARCH_PATH=/retrieve
RAG_TIMEOUT_MS=60000
```

测试：

```bash
curl -s -X POST http://localhost:8787/api/knowledge/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"宝黛关系","limit":2}' | jq .
```

## SSE 测试

先启动一个 workflow，拿到 `run.id`，然后：

```bash
curl -N http://localhost:8787/api/runs/<runId>/stream
```

## WebSocket 测试

可用 `wscat`：

```bash
npx wscat -c 'ws://localhost:8787/api/events/ws?runId=<runId>'
```

## Docker Compose

```bash
docker compose up --build
```

默认使用：

```bash
WORKFLOW_EXECUTION_MODE=async
WORKFLOW_QUEUE_DRIVER=redis
REDIS_URL=redis://redis:6379
LLM_PROVIDER=mock
RAG_PROVIDER=local
```

## 验证命令

```bash
npm run build
npm run test
./scripts/smoke.sh
```

## 已验证项

- TypeScript build：core / skills / api / web
- Unit tests：core / skills
- API tests：health、inline workflow、async local queue、SQLite persistent store、HTTP RAG
