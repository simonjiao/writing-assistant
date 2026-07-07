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
| RevisionProposal | 由对话或 workflow review 生成的待确认修改方案，应用前不改写正文 |

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
- 一致性检查出现 blocking finding 时，runner 先用 `create_revision_proposal` 生成绑定当前 run 的待确认方案，再等待用户应用或取消；同一 revision 上不会继续生成正文。
- workflow 生成的 `RevisionProposal` 带 `runId`。应用后清理当前一致性阻断并恢复 runner；取消后清理 pending proposal，但保留一致性阻断，让 run 回到 `consistency-review` 等待态。
- run 等待 pending proposal 时，workflow message 会先处理这个 proposal：应用、取消、或基于新意见刷新 proposal；普通“继续写作”不会绕过未处理的 pending proposal。
- 同一文章、同一用户已有 workflow pending proposal 时，新的 `/api/workflows/writing/start` intent 会复用原 run，不创建并行 run。
- 同一文章、同一用户已有 pending HumanGate 时，新的 `/api/workflows/writing/start` intent 会返回原 run，让用户先处理该确认项。
- 批注处理是 `process_article_comments` workflow action：只在明确批注意图时触发，处理后完成本次 run，不顺手继续写正文。
- 统稿报告发现可修订 warning 时，也通过同一条 `pendingReviewProposal -> create_revision_proposal` 路径生成待确认修改方案；runner 不自动应用统稿建议。
- 任务卡确认、任务卡智能修订、大纲项智能修订不保留直连 REST 入口。确认走 HumanGate；智能修订走对话 proposal apply/dismiss。
