---
id: create-task-card
title: 创建任务卡
version: 1
tools:
  - create_task_intake
  - refine_task_card
actions:
  create_task_intake: 先保存任务容器，保证用户输入不会丢失。
  refine_task_card: 基于已保存的 intake 整理任务卡草稿。
  ask_followup: 任务卡草稿已生成，需要用户确认或继续补充。
---

## Goal
用户输入自然语言写作需求后，立即保存一个可恢复的写作任务，再逐步整理成可确认的任务卡。

## When To Use
- 新任务没有 article 容器时先创建 intake。
- 已有 article 但缺少 taskCard 时整理任务卡草稿。
- 第一轮只做任务理解，不开始写大纲或正文。

## Inputs
- 必须有 userId、workspaceId 和原始需求。
- 写作标准和题材标准是显式选择项，优先级高于模型猜测。
- intake 工具不需要 LLM 输出。

## Process
- create_task_intake 立即创建 article/task 容器并保存原始需求关联。
- refine_task_card 在同一个 article 上整理任务卡草稿。
- 生成待确认项，篇幅和资料边界通常单选，场景、重点、人物关系通常多选。
- 任务卡确认前不得生成大纲或正文。

## RAG Policy
- 创建 intake 绝不 RAG。
- 整理任务卡默认不 RAG，只理解用户需求和显式标准。
- 只有用户明确要求依据原文、脂批、出处或证据推荐材料时，才进入资料检索能力。

## Human Gate Policy
- 任务卡草稿生成后进入待确认。
- 用户可以继续对话修订任务卡；确认前所有修改仍落在同一 article 上。

## Completion Criteria
- article 已创建且可在任务列表中恢复。
- taskCard 草稿保存到同一个 article，状态为 draft。
- 待确认项反映尚未明确的关键写作选择。

## Failure Policy
- refine_task_card 失败时保留 intake article，不删除用户输入。
- 缺少 workspace 权限时失败，不创建任务。

## Prompt Rules
- 不要把内部状态词作为展示文案。
- 不要默认查询 RAG。
- 场景类待确认项必须可多选。
- 输出字段必须自然、可读、适合后续大纲和正文。
