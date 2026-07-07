# 模块：API

## 文件

- `apps/api/src/app.ts`
- `apps/api/src/bootstrap.ts`
- `apps/api/src/config.ts`

## REST API

| Method | Path | 作用 |
|---|---|---|
| GET | `/health` | 健康检查和运行模式 |
| POST | `/api/sessions` | 创建 session |
| GET | `/api/articles` | 列出文章 |
| GET | `/api/articles/:articleId` | 读取文章 artifact |
| POST | `/api/knowledge/search` | 调用 KnowledgeStore，HTTP RAG 时转发到外部 RAG |
| POST | `/api/workflows/writing/start` | 启动或继续 writing-autopilot，根据 `targetStage` 推进任务卡、大纲、章节或整篇写作 |
| POST | `/api/workflows/:runId/human-gates/:gateId/resolve` | 处理 HumanGate |
| POST | `/api/workflows/:runId/cancel` | 取消 workflow |
| GET | `/api/workflows/:runId` | 读取 run、article、events、HumanGate、operation log、review artifact |
| GET | `/api/workflows/:runId/events` | 读取 run 事件日志 |

## SSE

```text
GET /api/workflows/:runId/stream
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
3. 选择 local/http/tonglingyu knowledge store。
4. 选择 mock/openai-compatible LLM。
5. 创建 PiWorkflowRunner，并注入幂等 action executor。
6. 创建 pi-agent decision provider；每轮只允许选择 runner 提供的 allowed action。
