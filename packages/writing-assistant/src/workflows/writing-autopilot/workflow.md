---
id: writing-autopilot
title: 写作自动流程
version: 1
---

## Goal
自主推进写作任务，从创建任务卡到生成大纲、正文、一致性审阅和统稿报告。

## Stages
- 创建任务卡：先保存 intake，再整理 taskCard 草稿。
- 确认任务卡：任务卡未确认前只允许继续补充或确认。
- 生成大纲：任务卡确认后生成或覆盖大纲；覆盖已有大纲必须经过 HumanGate。
- 开始写作：开始写作时自动确认当前大纲，再进行一致性检查。
- 生成正文：按大纲项逐节写作，并保持来源和任务卡约束。
- 批注处理：用户明确要求处理正文批注时，只处理批注，不顺手继续写正文。
- 统稿检查：正文完成后生成统稿报告，发现可修订项时生成待确认 proposal。

## Agent Policy
- Runner 每轮只把产品 planner 给出的 allowedActions 交给 pi-agent。
- Agent 只能选择 allowedActions 中的一个 action，不能自造 action、toolName 或 operationId。
- 单一可执行 action 可由 runner 内部选择，不额外请求 LLM。

## Human Gate Policy
- 覆盖已有大纲、确认当前大纲、处理 stale revision 或需要用户裁决时必须暂停。
- HumanGate 解决前不继续执行后续写作 action。

## Completion Criteria
- 任务卡已确认。
- 大纲已生成且可写。
- 所有可写大纲项均已有正文。
- 统稿报告已生成或当前 revision 无需再次生成。

## Failure Policy
- 工具失败时记录 operation 和 workflow failed 事件。
- 幂等 operation 已完成时不得重复改写 artifact。
- revision 冲突时失败并等待用户重新发起或处理。
