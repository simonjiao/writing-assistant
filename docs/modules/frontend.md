# 模块：Frontend

## 文件

- `apps/web/src/App.tsx`
- `apps/web/src/api.ts`
- `apps/web/src/types.ts`
- `apps/web/src/styles.css`

## 作用

前端是写作工作台，负责展示：

- 左侧任务卡
- 中间大纲和文章 block
- 右侧知识来源、引用来源、主题标签、修订日志、HumanGate 和 review 提示
- 底部对话输入；选中任务卡、大纲或段落时，会把当前选择作为对话上下文

## 实时更新

前端启动 `writing-autopilot` 后调用：

```ts
api.streamRunEvents(runId, onEvent)
```

通过 SSE 接收：

- workflow status
- tool progress
- artifact.updated
- human_gate.created / review_artifact.created
- rag.http events

收到关键事件后自动刷新 `/api/workflows/:runId`。

正文批注的“处理”按钮发送 writing-autopilot intent，而不是直接调用孤立的批注处理流程。前端把 open comment ids 放入 `commentIds`，由 runner 执行 `process_article_comments` 并通过右侧流程卡显示执行记录。

## WebSocket

`api.openEventWebSocket(runId, onEvent)` 已提供，当前 UI 默认使用 SSE；后续可以切换为 WebSocket 或二者并存。
