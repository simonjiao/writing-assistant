# 模块：AgentRuntime

## 文件

- `packages/core/src/agent-runtime.ts`
- `packages/core/src/context.ts`
- `packages/core/src/llm.ts`

## 作用

AgentRuntime 是 skill 执行环境。pi workflow action executor、对话接口和批注处理会通过它调用具体 skill。它负责：

1. 从 SkillRegistry 加载 skill。
2. 调用 ContextBuilder 组装上下文。
3. 通过 LLMProvider 请求模型。
4. 校验和返回 skill output。
5. 写入 skill started/completed/failed 事件。

## Skill Invocation

```text
PiWorkflowActionExecutor / API route
  → AgentRuntime.invokeSkill(skillId, input)
  → SkillRegistry.get(skillId)
  → ContextBuilder.build(...)
  → LLMProvider.json/chat(...)
  → Skill output
```

## Context Assembly

Context 不是存储，而是本次 LLM 调用的临时材料包。它从以下外部 store 读取：

- SessionStore：当前文章、当前 block、当前 cursor
- StateStore：当前 workflow run state
- MemoryStore：用户长期偏好
- ArtifactStore：任务卡、大纲、正文、版本、引用
- KnowledgeStore：本地知识或 HTTP RAG 检索结果

## LLM Provider

- `MockLLMProvider`：默认可运行，不需要 key。
- `OpenAICompatibleProvider`：使用 OpenAI-compatible Chat Completions API。
