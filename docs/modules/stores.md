# 模块：Stores

## Store 类型

| Store | 作用 |
|---|---|
| SessionStore | 当前会话状态：当前文章、当前选中 block |
| StateStore | Workflow run、state、checkpoint、waitingFor |
| MemoryStore | 用户长期写作偏好 |
| ArtifactStore | 任务卡、大纲、正文 block、引用、版本 |
| KnowledgeStore | 本地知识或 HTTP RAG 检索结果 |
| EventTraceStore | workflow、queue、RAG、artifact 事件日志 |

## Store Driver

### sqlite

SQLite 是当前版本唯一的持久化 Store。它使用 `DATA_DIR/writing-assistant.sqlite`，并通过统一的 `json_records` 表按 namespace 保存不同类型的 JSON 对象。

```bash
DATA_DIR=.data
```

当前 SQLite Store 覆盖：

- SessionStore
- StateStore
- MemoryStore
- ArtifactStore
- 本地 KnowledgeStore
- EventTraceStore

注意：本实现使用 Node 22 内置 `node:sqlite`。运行时可能出现 ExperimentalWarning，不影响本地使用。

Redis 不作为持久化 Store 使用；它只用于可选的 `RedisWorkflowQueue`。

## HTTP RAG KnowledgeStore

```bash
RAG_PROVIDER=http
RAG_BASE_URL=http://localhost:9000
RAG_SEARCH_PATH=/search
RAG_REFS_PATH=/refs
```

失败时可配置回退：

```bash
RAG_FALLBACK_LOCAL=true
```
