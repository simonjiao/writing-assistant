---
id: evaluate-quality
title: 质量检查
version: 1
tools:
  - evaluate_quality
actions:
  review_task_card_outline_consistency: 检查任务卡和大纲是否一致。
  generate_polish_report: 正文完成后生成统稿报告。
---

## Goal
检查文章或局部内容是否满足任务卡、引用、连贯性等基本标准。

## When To Use
- 需要自动检查来源、任务一致性或基础质量。

## Inputs
- 必须有 articleId 和 criteria。

## Process
- 读取当前文章。
- 按 criteria 检查。
- 返回通过状态、分数和建议动作。

## RAG Policy
- 不主动 RAG，只检查已有来源绑定。

## Human Gate Policy
- 发现阻断问题时交给 proposal 或 HumanGate 流程。

## Completion Criteria
- 返回 passed、score、findings、recommendedAction。

## Failure Policy
- 缺任务卡时给出失败 finding。

## Prompt Rules
- 检查结果要能转成后续修改建议。
