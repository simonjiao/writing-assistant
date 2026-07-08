---
id: dialogue-route
title: 对话路由
version: 1
tools:
  - route_dialogue
actions: {}
---

## Goal
轻量判断用户消息是解释、讨论、澄清、资料检索还是修改方案。

## When To Use
- 每次文章内对话消息进入后先路由。

## Inputs
- 必须有 message、context 和 pending proposal 状态。

## Process
- 先用规则判断是否显式 RAG。
- 再判断是否需要生成 proposal。
- 只读问题走 answer 或 discuss。

## RAG Policy
- 只有明确要求查找资料、出处、原文、脂批或证据时 route=needs-rag。

## Human Gate Policy
- 路由本身不创建 HumanGate。

## Completion Criteria
- 返回唯一 route。

## Failure Policy
- 判断不清时 clarify。

## Prompt Rules
- 不要把包含、保留、不要漏掉等写作约束误判为 RAG。
- 不要生成修改方案。
