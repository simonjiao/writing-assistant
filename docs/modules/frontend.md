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
- 右侧知识来源、引用来源、主题标签、版本、实时事件
- 底部局部修改输入和 patch 预览

## 实时更新

前端在启动/恢复 workflow 后调用：

```ts
api.streamRunEvents(runId, onEvent)
```

通过 SSE 接收：

- workflow status
- queue status
- node/skill progress
- artifact.updated
- review.required
- rag.http events

收到关键事件后自动刷新 `/api/runs/:runId`。

## WebSocket

`api.openEventWebSocket(runId, onEvent)` 已提供，当前 UI 默认使用 SSE；后续可以切换为 WebSocket 或二者并存。
