# 工程规范

## Monorepo 边界

```text
packages/core   纯业务内核，不依赖 Fastify/React/Redis
packages/skills 默认 skill 实现，依赖 core 类型
apps/api        API、SQLite store、queue driver、RAG client、container bootstrap
apps/web        UI 和 API client
```

## 依赖方向

```text
apps/web  → HTTP API
apps/api  → packages/core + packages/skills
skills    → packages/core
core      → 无业务框架依赖
```

禁止 `core` 反向依赖 `apps/api` 或 `apps/web`。

## TypeScript 规则

- 公共对象必须定义显式类型。
- workflow state 中的动态字段要在节点边界做类型收窄。
- API request body 当前为轻量校验；生产版应加 Zod/JSON Schema。
- Store 接口返回值应使用 domain type，不返回数据库行。

## Workflow 规则

- workflow 节点必须小而明确。
- LLM 调用必须通过 skill。
- wait 节点必须可 resume。
- function 节点负责确定性副作用，如写 ArtifactStore。
- 每个重要节点应写 EventTraceStore。

## Store 规则

- LLM 不保存状态。
- ContextBuilder 只组装上下文，不作为状态源。
- ArtifactStore 是文章产物唯一可信来源。
- StateStore 是 workflow run 唯一可信来源。
- MemoryStore 只存用户长期偏好，不存临时上下文。

## Queue 规则

- local queue 只用于单进程开发。
- redis queue 只用于多进程和部署环境的 workflow run 排队，不保存业务持久化数据。
- async 模式下 API 不能假设 run 已完成，必须依赖状态查询和 SSE/WS。
- worker 并发通过 `RUNNER_CONCURRENCY` 控制。

## Realtime 规则

- 所有可观测事件先写 EventTraceStore，再发布 EventBus。
- SSE 适合浏览器单向进度流。
- WebSocket 适合后续多端协作或双向控制。

## 测试规范

- core：测试 workflow 执行语义。
- skills：测试默认 skill 输出结构。
- api：测试 REST、async queue、SQLite persistent store、HTTP RAG。
- web：通过 `npm run build --workspace @wa/web` 做类型和打包检查。
