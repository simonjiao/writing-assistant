# 模块：Workflow

## 文件

- `packages/core/src/workflow.ts`
- `packages/core/src/queue.ts`
- `apps/api/src/queue/redisWorkflowQueue.ts`

## 作用

Workflow 模块负责把写作流程拆成可恢复、可暂停、可追踪的节点图。

## 核心对象

| 对象 | 说明 |
|---|---|
| WorkflowDefinition | 静态流程定义，包含 nodes、startNodeId |
| WorkflowEngine | 注册 workflow，启动/resume/cancel run，可将 run 入队 |
| WorkflowRunner | 执行某个 run 的节点直到完成或等待用户 |
| WorkflowQueue | 异步执行队列接口 |
| LocalWorkflowQueue | 单进程内存队列 |
| RedisWorkflowQueue | Redis list 队列，支持多进程消费 |
| WorkflowWorkerPool | 多 runner 并发 worker pool |

## 节点类型

| kind | 说明 |
|---|---|
| skill | 调用 AgentRuntime.invokeSkill |
| function | 执行业务函数，如创建文章、提交版本 |
| wait | 暂停并等待用户确认 |

## 典型状态

```text
queued → running → waiting → queued/running → completed
queued → running → failed
running → cancelled
```

## 设计约束

- Runner 不决定全局调度，只执行当前 run。
- Engine 不直接拼 prompt，也不直接调用 LLM。
- wait 节点必须保存 checkpoint，用户 resume 后继续。
- async 模式下 API 返回 queued/running/waiting 都是合理状态，前端依赖 SSE/WS 跟踪最终状态。
