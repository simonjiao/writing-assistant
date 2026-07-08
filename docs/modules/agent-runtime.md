# 模块：SkillExecutor

## 文件

- `packages/core/src/skill-executor.ts`
- `packages/core/src/context.ts`
- `packages/core/src/llm.ts`

## 作用

SkillExecutor 是低层 skill 执行环境，不负责 agent session、业务决策或 artifact 写入策略。它不对 API route/service 暴露，只能作为 `AgentToolExecutor` 的内部依赖。workflow、对话、对话摘要、批注处理和局部修订统一先绑定 pi-agent session，再通过 agent tool 执行具体 skill。

它负责：

1. 从 SkillRegistry 加载 skill。
2. 调用 ContextBuilder 组装上下文。
3. 通过 LLMProvider 请求模型。
4. 校验和返回 skill output。
5. 写入 skill started/completed/failed 事件。

## Skill Execution

```text
PiWorkflowActionExecutor / article dialogue service / comment processor
  → getOrCreateAgentSession(...)
  → AgentToolExecutor.executeSkillTool(...)
  → SkillExecutor.executeSkill(skillId, input)
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
