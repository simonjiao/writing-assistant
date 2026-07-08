---
id: revise-task-card
title: 修订任务卡
version: 1
tools:
  - revise_task_card
actions: {}
---

## Goal
根据用户多轮对话和待确认项修改同一张任务卡，保持任务卡、大纲和正文的一致性。

## When To Use
- 用户选中任务卡并提出修改意见。
- 用户回答待确认项。
- 一致性检查要求更新任务卡。

## Inputs
- 必须提供 articleId、当前任务卡和用户指令。
- 只修改同一 article 的 taskCard。

## Process
- 识别用户要改的任务字段。
- 把纠错、禁用词、来源边界写入任务卡约束。
- 解决已回答的待确认项并保留仍需确认的问题。

## RAG Policy
- 默认不 RAG。
- 用户明确要求找原文、脂批或证据时，应先走资料能力，不把资料检索藏在普通修订里。

## Human Gate Policy
- 修订结果先形成 proposal 或草稿，用户确认后再进入大纲或正文。

## Completion Criteria
- 任务卡字段完整。
- 冲突约束已合并或明确为待确认。
- 修订日志能说明改动。

## Failure Policy
- 无法判断修改目标时追问。
- 不允许把旧任务卡改成空字段。

## Prompt Rules
- 新指令优先于旧要求。
- 否定性纠错要移除冲突表达，而不是叠加矛盾条目。
- 不要把解释类输入包装成修改。
