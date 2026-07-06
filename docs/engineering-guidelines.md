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

## 本地运行规范

本地运行只使用一套固定命令：

```bash
npm run local:start
npm run local:status
npm run local:stop
npm run local:restart
```

可以通过 npm 参数转发只操作单个服务：

```bash
npm run local:restart -- api
npm run local:restart -- web
```

规则：

- 本地服务统一由 `scripts/local-runtime.mjs` 通过 macOS `launchctl` 管理。
- 不再使用临时 `npm run start`、`npm run dev`、`nohup`、手工找 PID 或一次性的 `launchctl submit` 命令启动项目服务。
- API 和 Web 日志固定写入 `.data/logs/api.log`、`.data/logs/api.err`、`.data/logs/web.log`、`.data/logs/web.err`。
- 后端相关代码变更后使用 `npm run local:restart -- api`；只改前端通常由 Vite 热更新处理，必要时使用 `npm run local:restart -- web`。
- Redis 默认不启动；只有显式设置 `WORKFLOW_QUEUE_DRIVER=redis` 时，才要求本地 Redis。
- `local:*` 脚本必须使用 Node 22；不要绕过 `scripts/check-node-version.cjs` 或 `package.json#engines`。

## 模块划分规范

模块应围绕稳定职责划分，而不是围绕临时页面或接口堆叠。新增能力时先判断它属于哪一层，再决定文件位置。

- `packages/core` 放跨端共享的领域类型、workflow/runtime 抽象、store 接口、queue/event 抽象和框架无关工具。
- `packages/skills` 放默认 agent skill；一个复杂 skill 应拆成 prompt 组装、预算/策略计算、输出归一化、质量校验和测试夹具。
- `apps/api` 放 HTTP 路由、container/bootstrap、workflow 定义、store adapter、queue adapter、RAG client 和运行配置；这些角色不要长期混在同一个文件。
- `apps/web` 放页面编排、组件、hooks、API client、展示类型和样式；页面组件只做组合和状态协调，复杂展示组件应独立。
- 跨层共享类型优先放 `packages/core`；仅 API 入参/出参使用的 DTO 留在 `apps/api`；仅 UI 展示需要的 view model 留在 `apps/web`。
- 禁止为了省事让 `apps/web` 直接依赖 `packages/skills` 或 `apps/api` 内部模块；Web 只通过 HTTP API 使用后端能力。
- 避免用大而全的 barrel export 掩盖模块边界；如果 barrel 导出会造成循环依赖或所有模块互相可见，应改为显式导入。
- 内部 id、run id、section id、block id 等只用于状态和 API，不直接作为 UI 文案展示。

## 文件拆分规范

代码文件应保持单一职责。一个文件可以有多个小 helper，但不能同时承担多个架构角色，例如路由定义、容器组装、workflow 定义、store 实现和业务规则不应长期堆在同一个文件中。

出现以下情况时应优先拆分，而不是继续追加：

- 单个源码文件超过约 300 行，并且包含两个以上职责。
- 单个源码文件超过约 500 行时，新功能应先拆分再继续添加，除非该文件是纯声明或纯测试数据。
- 单个源码文件超过约 800 行时，必须把拆分列入本次改动范围；不要继续在其中追加新的业务分支。
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

典型拆分方向：

- `apps/web/src/App.tsx` 继续变大时，优先拆出任务导航、任务卡工作区、大纲工作区、辅助列、对话输入区、运行进度和选择态 hooks。
- `apps/api/src/app.ts` 继续变大时，按 sessions、workspaces、articles、workflows、dialogue、knowledge 拆路由注册文件。
- `apps/api/src/bootstrap.ts` 继续变大时，拆出 workflow definitions、store/container factory、runtime provider factory。
- `packages/skills/src/section-writer.ts` 继续变大时，拆出 writing budget、continuity context、source policy validation、length/quote validation、prompt builder。

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
- I/O 边界先使用 `unknown` 或明确 DTO，再做解析和收窄；不要把外部 JSON 直接断言成 domain type 后继续传递。
- 避免新增 `any`。只有在隔离第三方库或测试夹具时可局部使用，并且不得跨出该函数边界。
- 公开函数、skill `invoke`、store 方法、route handler helper 必须写清返回类型或让返回类型来自已命名接口。
- workflow/run/status 类状态优先使用判别联合或字面量联合；新增分支时要做穷尽处理。
- 不要依赖非空断言 `!` 处理业务数据；先检查并返回 400/404 或抛出明确错误。
- 使用 `import type` 引入纯类型，避免运行时循环依赖。
- `Record<string, unknown>` 只能用于边界层；进入 core、skill 或 UI 前应转换为明确结构。
- React state 类型必须表达“未加载、加载中、失败、已加载”的区别；不要用空对象或空字符串混合表示多个状态。
- 前端展示层不得直接显示内部技术标识；需要展示时转成标题、序号、状态或用户可理解的摘要。

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
