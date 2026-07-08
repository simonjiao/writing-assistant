# 模块：Prompt Programs 与 Context

## Prompt Program 是什么

Prompt program 是产品工具内部使用的结构化 LLM 执行单元。它不是公开 agent runtime，也不直接读写 store。每个 prompt program 包含：

- id / name / description
- inputSchema / outputSchema
- prompt builder
- optional policy / evaluator

## 默认 Prompt Programs

| Program | 作用 |
|---|---|
| task-card-builder | 将模糊需求整理成任务卡 |
| outline-planner | 基于任务卡生成大纲 |
| section-writer | 基于任务卡、大纲、RAG 资料生成章节 block |
| patch-editor | 对选中 block 生成局部 patch |
| citation-checker | 检查引用支撑 |
| coherence-evaluator | 检查连贯性 |

## Context 粒度

写作助手支持三种上下文粒度：

```text
article   全文级：任务卡、大纲、全文摘要、全局主题
section   章节级：当前章节目标、前后章节摘要、相关知识
paragraph 段落级：选中 block、前后 block、引用、patch 策略
```

## 设计原则

- 不把 chat history 当作全部上下文。
- 不把 memory 直接塞满 prompt，只取和当前任务相关的偏好。
- patch program 默认只改选中 block。
- 引用来源通过 `sourceRefs` 与 block 绑定。
