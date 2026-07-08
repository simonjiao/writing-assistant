---
id: plan-outline
title: 生成和确认大纲
version: 1
tools:
  - plan_outline
  - revise_outline
  - revise_outline_item
actions:
  plan_outline: 按任务卡生成大纲。
  confirm_outline_for_writing: 用户开始写作时确认当前大纲。
  request_human_gate: 覆盖已有大纲或正文前等待用户确认。
---

## Goal
根据已确认任务卡生成或修订文章大纲，明确开头、起承转合、关键段和结尾。

## When To Use
- 任务卡已确认且尚未生成大纲。
- 用户要求生成或重新生成大纲。
- 开始写作前需要自动确认当前大纲。

## Inputs
- 必须有已确认任务卡。
- 重新生成已有大纲必须经过 HumanGate。

## Process
- 按任务卡组织论证结构，不按原文顺序复述。
- 设置 opening、development、turn、conclusion。
- 为关键段写明 specialHandling。
- 开始写作时自动确认大纲。

## RAG Policy
- 生成大纲可以使用 RAG 作为材料线索。
- sourceHints 只是线索，不能当作无来源事实。

## Human Gate Policy
- 覆盖已有大纲或正文必须请求确认。
- 开始写作会自动确认当前 draft 大纲。

## Completion Criteria
- 大纲项完整、顺序清楚、角色齐全。
- 没有违反任务卡 mustAvoid 或来源策略。

## Failure Policy
- 大纲与任务卡冲突时生成一致性建议，不继续正文。

## Prompt Rules
- 不要输出模板编号。
- 开头提出核心问题，结尾收束判断。
- 章节 goal 写成分析任务，不写成情节复述。
