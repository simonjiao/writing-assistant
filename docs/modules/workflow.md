# 模块：Workflow

## 文件

- `packages/core/src/pi-workflow-runner.ts`
- `packages/core/src/allowed-actions.ts`
- `packages/core/src/pi-agent-decision.ts`
- `apps/api/src/piWorkflowActionExecutor.ts`

## 作用

Workflow 模块以 `writing-autopilot` 为主流程。Runner 每轮读取 run、article、pi session、HumanGate 和 review artifact，生成当前允许的 `allowedActions`，再让 pi-agent 在这些动作里选择下一步。工具执行结果写入 operation log，所有覆盖性动作必须经过独立建模的 HumanGate。

## 核心对象

| 对象 | 说明 |
|---|---|
| PiWorkflowRunner | 推进 `writing-autopilot`，每轮计算 allowed actions、调用 pi-agent decision、执行工具或进入等待 |
| AllowedActionPlanner | 根据任务卡、大纲、正文、revision 和 targetStage 生成单步可执行动作 |
| PiAgentSession | 保存每个 run 的 agent 会话状态、消息、base revision 和 pending gate |
| WorkflowOperation | 幂等工具调用记录，使用稳定 operationId 防止重复写入 |
| HumanGate | 用户确认模型，用于任务卡确认、大纲覆盖等需要人工裁决的步骤 |
| ReviewArtifact | 一致性检查和统稿报告的结构化结果 |

## 典型状态

```text
running -> waiting -> running -> completed
running -> failed
running -> cancelled
```

## 设计约束

- 前端按钮只发送 intent，例如 `targetStage=outline` 或 `targetStage=section`。
- Runner 是流程真相来源，不保留分散的任务卡、大纲、章节旧 workflow 入口。
- 工具必须幂等；同一 operationId 已完成时不能重复改写 artifact。
- 工具层必须二次校验 action 是否来自当前 run 的 allowedActions，并校验 workspace/article 权限。
- 覆盖当前大纲、确认任务卡等用户裁决点必须生成 HumanGate。
- 修改 artifact 时要校验 article revision，防止过期操作覆盖新内容。
