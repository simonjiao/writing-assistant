---
id: patch-block
title: 局部修改段落
version: 1
tools:
  - patch_block
actions: {}
---

## Goal
只对用户选中的段落生成局部 patch，避免无意扩大修改范围。

## When To Use
- 用户选中正文段落并提出修改。

## Inputs
- 必须有 articleId、blockId 和 instruction。

## Process
- 读取选中段落和邻近段落。
- 生成完整替换后的 selected block。
- 说明修改点和是否扩大范围。

## RAG Policy
- 默认不 RAG；如果涉及来源事实，应保留或要求来源绑定。

## Human Gate Policy
- 扩大修改范围需要用户确认。

## Completion Criteria
- patch.after 是完整段落。
- evaluation 说明是否保留含义。

## Failure Policy
- 找不到 selected block 直接失败。

## Prompt Rules
- 默认只改选中段。
- 不要返回未选中上下文。
