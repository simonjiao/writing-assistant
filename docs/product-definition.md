# 产品定义

## 产品定位

写作助手 MVP 是一个面向长文写作的工作台，不是问答型 ChatBot。产品以结构化写作产物为核心：任务卡、文章大纲、正文块、知识来源、引用来源、主题标签、版本记录。

## 目标用户

- 需要持续打磨长文的作者、研究者、内容编辑
- 需要把模糊写作需求沉淀为明确任务卡的用户
- 需要引用和知识来源可追踪的专业写作者

## 核心价值

1. 将模糊需求变成可执行任务卡。
2. 用 workflow 管控大纲、写作、审核、修改。
3. 支持选中段落后的局部 patch，避免全文重写。
4. 将引用来源和主题标签绑定到文章 block。
5. 支持异步执行、状态恢复、实时进度展示。

## MVP 闭环

```text
自然语言需求
  → task-card workflow
  → 用户确认任务卡
  → outline workflow
  → 用户确认大纲
  → section-writing workflow
  → patch workflow
  → artifact version commit
```

## 本版新增能力

- HTTP RAG：真实知识库通过 HTTP 接入。
- SQLite Store：唯一持久化存储，保存 Session/State/Memory/Artifact/Knowledge/EventTrace。
- Redis Queue：可选异步队列，只用于 workflow run 排队和跨进程消费。
- 多 Runner：多个 runner worker 并发消费队列。
- SSE/WebSocket：前端实时接收 workflow、queue、RAG、artifact 事件。
