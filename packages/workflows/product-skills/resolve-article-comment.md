---
id: resolve-article-comment
title: 处理正文批注
version: 1
tools:
  - resolve_article_comment
actions:
  process_article_comments: 处理正文批注。
---

## Goal
批量处理用户对生成正文选区添加的批注，按批注意图修订、解释或追问。

## When To Use
- 正文存在 open 批注且用户要求处理。
- 用户针对批注追加回复。

## Inputs
- 必须有 article、comment、选中 block 和 baseRevision。

## Process
- 逐条判断批注意图。
- 能局部替换 selectedText 就修订。
- 只是解释就回复说明。
- 信息不足或会破坏上下文就追问。

## RAG Policy
- 批注涉及来源边界、后四十回、脂批或原文事实时，应遵守任务卡来源策略。

## Human Gate Policy
- 无法安全局部修订时标记 needs_input，不强行改。

## Completion Criteria
- 每条批注都有处理结果或追问。
- 已处理批注可折叠，未处理回复可删除。

## Failure Policy
- 单条失败不阻断其它批注处理。
- 无有效 JSON 时保留人工确认提示。

## Prompt Rules
- 只处理选中文本，不返回整段。
- 不要暴露内部标记。
- 最新用户回复优先。
