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

## 文件拆分规范

代码文件应保持单一职责。一个文件可以有多个小 helper，但不能同时承担多个架构角色，例如路由定义、容器组装、workflow 定义、store 实现和业务规则不应长期堆在同一个文件中。

出现以下情况时应优先拆分，而不是继续追加：

- 单个源码文件超过约 300 行，并且包含两个以上职责。
- 单个文件同时出现框架适配、领域逻辑、持久化、副作用编排。
- 单个 React 组件同时管理页面状态、网络请求、事件订阅和多个大块 UI。
- 单个 API 文件同时包含多组资源路由、SSE/WS 逻辑和响应组装。
- 单个 workflow 文件包含多条独立 workflow 定义，且节点 handler 已经难以快速定位。
- 新增功能需要在文件中插入大段分支逻辑，而不是复用现有抽象。

拆分时按职责和分层边界移动代码：

- `packages/core`：只放框架无关的类型、接口、workflow/runtime/queue/event/store 抽象和通用实现。
- `packages/skills`：一个 skill 一个主要文件；`register.ts` 只负责注册，不放 skill 逻辑。
- `apps/api`：路由、container 组装、workflow 定义、store adapter、queue adapter、RAG client 分开维护。
- `apps/web`：页面编排、组件、hooks、API client、类型、样式分开维护；`App.tsx` 应偏向页面组合，不承载全部 UI 细节。

拆分步骤应保守：

- 先抽出纯类型、纯 helper 或明显独立的 adapter。
- 保持原有 public export 和 API 行为稳定。
- 移动代码和行为修改分开提交，除非行为修改很小且测试覆盖清楚。
- 拆分后补齐或移动对应测试。
- 至少运行 `npm run build` 和 `npm test`；只改 web 时至少运行 `npm run build --workspace @wa/web`。

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
