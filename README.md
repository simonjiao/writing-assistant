# Writing Assistant

一版 workflow-driven 写作助手。它不是普通聊天机器人，而是以 **Task Card / Outline / Article Artifact / Patch / Version** 为中心的写作工作台。

本版已经加入：

- TypeScript monorepo：`apps/api`、`apps/web`、`packages/core`、`packages/skills`
- Fastify API 后端 + React/Vite 前端
- OpenAI-compatible LLM Provider，默认 `mock` 模式可离线运行
- Skill 机制：任务卡、大纲、章节写作、局部修改、引用/连贯性检查
- WorkflowEngine / WorkflowRunner 拆分
- 外部化 Session / State / Memory / Artifact / Knowledge / Event Trace
- HTTP RAG KnowledgeStore：通过 HTTP POST 接入真实 RAG 服务
- Redis / Local 多 Runner 异步队列
- SQLite 单一持久化存储后端
- SSE + WebSocket 实时事件通道
- 单元与集成测试

## 目录

```text
writing-assistant/
├─ apps/
│  ├─ api/                 # Fastify API、stores、queue、RAG client
│  └─ web/                 # React/Vite 写作工作台
├─ packages/
│  ├─ core/                # Workflow、AgentRuntime、Skill、Store、Queue、EventBus
│  └─ skills/              # 默认写作 skills
├─ docs/                   # 产品、架构、模块、部署测试文档
├─ scripts/smoke.sh        # API smoke test
├─ docker-compose.yml      # API + Web + 可选 Redis Queue
├─ Dockerfile.api
└─ Dockerfile.web
```

## 环境要求

- Node.js `22.x`（`>=22.12.0 <23`）
- npm `>=10`
- 可选：Docker / Docker Compose
- 可选：Redis，仅在 `WORKFLOW_QUEUE_DRIVER=redis` 时需要

项目通过 `.nvmrc`、`.node-version`、`.npmrc`、`package.json#engines` 和 npm 脚本检查共同限定 Node 22。若当前 shell 不是 Node 22，`npm install`、`npm run build`、`npm run test`、`npm run dev` 会直接失败。

> SQLite 使用 Node 22 的 `node:sqlite`，运行时可能出现 ExperimentalWarning，不影响测试与本地使用。

## 本地启动

```bash
nvm use
cp .env.example .env
npm install
npm run build
npm run test
npm run dev
```

另开一个终端启动前端：

```bash
npm run dev:web
```

访问：

```text
http://localhost:5173
```

默认配置为 `mock` LLM、SQLite 持久化存储、本地异步队列、本地知识库。

## Docker 启动

```bash
docker compose up --build
```

默认 compose 会启动：

- API: `http://localhost:8787`
- Web: `http://localhost:5173`
- Redis Queue: `localhost:6379`

## 核心配置

### LLM Provider

```bash
LLM_PROVIDER=mock
# 或
LLM_PROVIDER=openai-compatible
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=your-key
OPENAI_MODEL=gpt-4.1-mini
```

### Store

```bash
DATA_DIR=.data
```

持久化存储固定使用 SQLite。Session、Workflow State、Memory、Article Artifact、Local Knowledge、EventTrace 都写入：

```text
${DATA_DIR}/writing-assistant.sqlite
```

Redis 不再作为持久化 Store 使用；它只在 `WORKFLOW_QUEUE_DRIVER=redis` 时作为异步 workflow 队列。

### Workflow 执行模式

```bash
WORKFLOW_EXECUTION_MODE=inline # API 请求内同步执行
WORKFLOW_EXECUTION_MODE=async  # 入队后由 Runner workers 执行
ENABLE_WORKERS=true
RUNNER_CONCURRENCY=2
```

### 队列

```bash
WORKFLOW_QUEUE_DRIVER=local
# 或
WORKFLOW_QUEUE_DRIVER=redis
REDIS_URL=redis://localhost:6379
```

`local` 队列适合单进程开发；`redis` 队列适合多个 API/worker 进程共享任务。

### HTTP RAG

```bash
RAG_PROVIDER=http
RAG_BASE_URL=http://localhost:9000
RAG_API_KEY=
RAG_SEARCH_PATH=/search
RAG_REFS_PATH=/refs
RAG_TIMEOUT_MS=10000
```

`RAG_PROVIDER=http` 面向通用 `/search` 风格服务。若接入 `tonglingyu-knownledge` 现有 retriever HTTP 接口，使用：

```bash
RAG_PROVIDER=tonglingyu
RAG_BASE_URL=http://127.0.0.1:8765
RAG_SEARCH_PATH=/retrieve
RAG_TIMEOUT_MS=60000
```

该模式会向 `/retrieve` 发送 `{ "query": "...", "top_k": 6 }`，并把返回的 `evidence_pack.docs[]` 映射为写作工作台内部的 `KnowledgeItem[]`。

搜索接口请求：

```http
POST /search
Content-Type: application/json
Authorization: Bearer <RAG_API_KEY> # 可选

{
  "query": "宝黛关系",
  "limit": 6,
  "themeTags": ["红楼梦"]
}
```

支持的返回格式：

```json
{
  "items": [
    {
      "id": "k1",
      "title": "第三十二回",
      "content": "宝玉诉肺腑相关材料……",
      "sourceType": "external",
      "sourceRef": "rag:chapter-32",
      "themeTags": ["宝黛关系", "知己"]
    }
  ]
}
```

也兼容：

```json
[{ "title": "...", "text": "...", "source": "...", "metadata": {} }]
```

引用反查接口请求：

```http
POST /refs

{
  "sourceRefs": ["rag:chapter-32"]
}
```

## API 快速检查

```bash
curl http://localhost:8787/health
curl http://localhost:8787/api/queue/status
./scripts/smoke.sh
```

## SSE 与 WebSocket

按 run 订阅 SSE：

```text
GET /api/runs/:runId/stream
```

全局/过滤订阅 SSE：

```text
GET /api/events/stream?runId=<runId>&userId=<userId>
```

WebSocket：

```text
WS /api/events/ws?runId=<runId>&userId=<userId>
```

事件类型包括：

```text
workflow.started / workflow.queued / workflow.waiting / workflow.completed / workflow.failed
node.started / node.completed / node.failed
skill.started / skill.completed / skill.failed
queue.enqueued / queue.dequeued / queue.completed / queue.failed
runner.started / runner.stopped
artifact.updated
review.required
rag.http.started / rag.http.completed / rag.http.failed
```

## 测试

```bash
npm run build
npm run test
```

当前测试覆盖：

- core workflow inline run
- skills task-card builder
- API health + task-card inline workflow
- local async queue + runner worker
- SQLite store
- HTTP RAG provider integration

## 用户流程

```text
用户输入写作需求
  ↓
生成任务卡 Task Card
  ↓
用户确认任务卡
  ↓
生成大纲 Outline
  ↓
用户开始写作，系统自动锁定当前大纲
  ↓
按章节生成正文
  ↓
选中段落生成局部 Patch
  ↓
用户确认 Patch
  ↓
提交文章版本
```

## 架构原则

- Workflow 控制流程，Agent 只执行节点能力。
- Runner 执行一次 workflow run；Engine 管理 workflow 定义、状态、队列、恢复。
- Context 由 Session / State / Memory / Artifact / Knowledge 临时组装，不把聊天历史当上下文。
- Skill 是能力包，不只是 prompt。
- 文章、引用、主题标签、版本都进入 ArtifactStore，不留在聊天记录里。
- 用户选中段落时默认局部修改，只有 evaluator 发现影响范围时才扩大修改。
