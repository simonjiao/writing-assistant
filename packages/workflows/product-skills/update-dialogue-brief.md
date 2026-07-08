---
id: update-dialogue-brief
title: 更新对话摘要
version: 1
tools:
  - update_dialogue_brief
actions: {}
---

## Goal
从用户消息中提取可持久化的写作要求、偏好、来源说明和冲突。

## When To Use
- 对话消息保存后异步更新摘要。
- 下一轮对话前需要等待未完成摘要更新。

## Inputs
- 必须有 message、context 和当前 brief。

## Process
- 提取当前消息的新要求。
- 用新要求替代冲突旧要求。
- 记录证据说明和最近意图。

## RAG Policy
- 不主动 RAG。
- 不要把 assistant 或资料内容当用户要求。

## Human Gate Policy
- 摘要更新不需要 HumanGate。

## Completion Criteria
- brief patch 可合并。

## Failure Policy
- 失败记录 job，下轮对话前重试或暴露状态。

## Prompt Rules
- 当前用户消息优先。
- 冲突处理不要过度保守。
- 每条摘要短而可执行。
