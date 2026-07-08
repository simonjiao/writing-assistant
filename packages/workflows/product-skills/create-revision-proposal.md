---
id: create-revision-proposal
title: 生成修改方案
version: 1
tools:
  - create_revision_proposal
actions:
  create_revision_proposal: 根据审阅结果生成待确认修改方案。
---

## Goal
把用户的自然语言修改意见转成待确认 proposal，而不是直接改文章。

## When To Use
- 用户明确要求修改任务卡、大纲、大纲项或段落。
- 一致性或统稿报告产生可操作建议。

## Inputs
- 必须有 articleId、上下文、用户消息和当前 artifact 摘要。

## Process
- 判断修改对象。
- 生成最小必要 operations。
- 把风险写入 warnings。

## RAG Policy
- 默认不 RAG。
- 用户要求资料依据时先走资料能力。

## Human Gate Policy
- proposal 必须用户应用后才写入。

## Completion Criteria
- operations 与当前 context 匹配。
- message 简短说明方案。

## Failure Policy
- 解释类输入返回 answer。
- 目标不清返回 clarify。

## Prompt Rules
- 不要把只读解释包装成修改方案。
- operation instruction 简明可执行。
