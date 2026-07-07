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
| POST | `/api/workflows/:runId/message` | 向等待中的 workflow run 发送后续指令；pending HumanGate 必须先处理；pending revision proposal 会优先应用、取消或刷新 |
| POST | `/api/workflows/:runId/human-gates/:gateId/resolve` | 处理 HumanGate |
| POST | `/api/workflows/:runId/cancel` | 取消 workflow |
| GET | `/api/workflows/:runId` | 读取 run、article、events、HumanGate、operation log、review artifact、pending revision proposals |
| GET | `/api/workflows/:runId/events` | 读取 run 事件日志 |
| POST | `/api/articles/:articleId/dialogue/:proposalId/apply` | 应用修改方案；若 proposal 绑定 workflow run，会同步恢复 runner |
| POST | `/api/articles/:articleId/dialogue/:proposalId/dismiss` | 取消修改方案；若 proposal 绑定 workflow run，会同步清理 pending proposal |

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

`RunResponse.revisionProposals` 返回当前文章、当前用户仍待处理的修改方案。workflow review 生成的 proposal 会通过这个字段同步到前端，不要求前端额外猜测或轮询对话接口。

`/api/workflows/writing/start` 在已有同文章、同用户、绑定 workflow run 的 pending revision proposal 时，不会新建第二条 run；它会返回原 run 的等待态，并把本次 intent 作为 workflow message 处理。

workflow review 生成的 proposal 带 `runId`。`apply` 返回 `DialogueResponse`，其中可以包含恢复后的 `run/article/events/revisionProposals`；`dismiss` 同样返回 `DialogueResponse`，前端应按普通对话响应更新本地状态。

当 workflow run 已等待一个 pending revision proposal 时，`/api/workflows/:runId/message` 不会直接绕过该 proposal 继续写作。确认类消息会应用 proposal，取消类消息会取消 proposal，明确修改意见会通过 `dialogue-coordinator` 刷新 proposal 并保持 run 等待新 proposal；普通讨论消息只返回当前等待状态。

统稿报告的 warning 建议也会走同一套 workflow proposal API。前端不需要为 polish report 单独实现应用入口，只要显示 pending revision proposals 并调用 `apply/dismiss`。
