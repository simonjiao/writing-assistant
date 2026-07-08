---
id: write-section
title: 生成章节正文
version: 1
tools:
  - write_section
actions:
  write_section: 生成用户指定章节正文。
  write_next_section: 生成下一节未完成正文。
---

## Goal
按大纲项生成原创分析性正文，并绑定可追溯来源。

## When To Use
- 大纲已确认。
- 指定章节尚未生成正文。
- 用户要求继续写作或生成当前章节。

## Inputs
- 必须有 taskCard、outline item 和 articleId。
- draft 大纲项不能直接写正文。

## Process
- 读取当前章节、任务卡和已有正文连续性。
- 优先使用未用过且符合来源策略的材料。
- 生成当前章节正文块并绑定 sourceRefs。

## RAG Policy
- 正文阶段应使用 RAG。
- 提到原文、回目、脂批、批语或具体事实时必须绑定 knowledge 中的 sourceRef。
- 被任务卡排除的来源必须过滤。

## Human Gate Policy
- 生成正文不要求每节人工确认，但失败或来源不合规时阻止保存。

## Completion Criteria
- 正文保存到对应章节。
- 不超出章节字数预算。
- 来源绑定通过校验。

## Failure Policy
- 超字数或缺来源绑定时先自动修正一次。
- 仍不合规则失败，不保存正文。

## Prompt Rules
- 写作不是翻译、复述或资料摘要。
- 每段先判断，再解释，再少量证据支撑。
- 承接前文，避免重复。
