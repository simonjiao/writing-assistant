# 模块：API

## 文件

- `apps/api/src/app.ts`
- `apps/api/src/bootstrap.ts`
- `apps/api/src/config.ts`

## REST API

| Method | Path | 作用 |
|---|---|---|
| GET | `/health` | 健康检查和运行模式 |
| GET | `/api/queue/status` | 队列深度和 runner 配置 |
| POST | `/api/sessions` | 创建 session |
| GET | `/api/articles` | 列出文章 |
| GET | `/api/articles/:articleId` | 读取文章 artifact |
| POST | `/api/knowledge/search` | 调用 KnowledgeStore，HTTP RAG 时转发到外部 RAG |
| POST | `/api/workflows/task-card/start` | 启动任务卡 workflow |
| POST | `/api/workflows/outline/start` | 启动大纲 workflow |
| POST | `/api/workflows/section/start` | 启动章节写作 workflow |
| POST | `/api/workflows/patch/start` | 启动局部 patch workflow |
| POST | `/api/workflows/:runId/resume` | 恢复等待中的 workflow |
| POST | `/api/workflows/:runId/cancel` | 取消 workflow |
| GET | `/api/runs/:runId` | 读取 run、article、events |
| GET | `/api/runs/:runId/events` | 读取 run 事件日志 |

## SSE

```text
GET /api/runs/:runId/stream
GET /api/events/stream?runId=&userId=
```

SSE 会先发送历史事件，再发送后续实时事件，并每 15 秒发送 ping。

## WebSocket

```text
WS /api/events/ws?runId=&userId=
```

消息格式：

```json
{ "type": "event", "event": { "id": "evt_x", "type": "workflow.completed" } }
```

## Bootstrap

`createContainer(config)` 会：

1. 创建 SQLite stores。
2. 包装 EventTraceStore，使事件同时持久化和发布到 EventBus。
3. 选择 local/http knowledge store。
4. 选择 mock/openai-compatible LLM。
5. 创建 WorkflowEngine。
6. 在 async 模式下创建 queue 和 worker pool。
