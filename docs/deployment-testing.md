# 部署与测试说明

## 本地开发

```bash
cp .env.example .env
nvm use
npm install
npm run build
npm run test
npm run local:start
```

状态检查：

```bash
npm run local:status
```

## 推荐本地配置

```bash
RAG_PROVIDER=local
LLM_PROVIDER=mock
```

## Workflow Runtime 检查

当前 workflow runtime 是 pi-agent，不依赖 Redis 队列。启动 API 后检查：

```bash
curl http://localhost:8787/health
```

## Pi Workflow 状态重置

从旧 workflow 运行态切到 pi-agent 时，保留工作台、文章、会话、知识和对话数据；清理 run、event、pi session、HumanGate、operation、review artifact，清掉 session 中悬挂的 `currentRunId`，并补齐缺失的文章 revision。

先 dry-run：

```bash
npm run workflow:reset-pi:dry-run
```

确认后执行：

```bash
npm run workflow:reset-pi
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
curl -N http://localhost:8787/api/workflows/<runId>/stream
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
LLM_PROVIDER=mock
RAG_PROVIDER=local
```

## 验证命令

```bash
npm run build
npm run test
npm run test:browser:local
./scripts/smoke.sh
```

浏览器回归测试会通过统一本地运行入口重启服务，并固定使用 `LLM_PROVIDER=mock`、`RAG_PROVIDER=local`：

```bash
npm run test:browser:local
```

如果需要在已经启动的本地实例上只跑 Playwright：

```bash
npm run test:browser
```

## 已验证项

- TypeScript build：core / skills / api / web
- Unit tests：core / skills / api / web workflow state
- API tests：health、writing-autopilot、HumanGate、SQLite persistent store、HTTP RAG
- Browser smoke：创建任务卡、确认任务卡、生成大纲、开始写作、添加并处理正文批注
