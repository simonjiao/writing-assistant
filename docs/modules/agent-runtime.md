# 模块：Agent Tool Runtime

## 文件

- `packages/runtime/src/product-tool-executor.ts`
- `packages/runtime/src/product-tool.ts`
- `packages/runtime/src/prompt-program.ts`
- `packages/writing-assistant/src/tool-catalog.ts`
- `packages/writing-assistant/src/schemas/tool-schemas.ts`
- `packages/core/src/context.ts`
- `packages/core/src/llm.ts`

## 作用

Agent Tool Runtime 是 pi-agent session 和产品工具之间的统一执行边界。它不决定业务流程，不直接写 UI，也不绕过 artifact revision；它只做四件事：

1. 校验 tool 是否在当前 allowed tools 内。
2. 通过 ToolRegistry 的 Zod schema 校验输入和输出。
3. 绑定 pi-agent session，记录幂等 operation 和 tool trace。
4. 调用对应 PromptProgram，并写入 `prompt_program.*` 与 `tool.*` 事件。

## Execution

```text
PiWorkflowRunner / dialogue service / comment processor
  → getOrCreateAgentSession(...)
  → AgentToolExecutor.executeTool(toolName, input)
  → ToolRegistry.get(toolName)
  → tool.inputSchema.parse(input)
  → ContextBuilder.build(promptProgramId, input)
  → PromptProgramRegistry.get(programId)
  → PromptProgram.invoke(...)
  → tool.outputSchema.parse(output)
  → AgentOperationStore + EventTraceStore
```

## Context Assembly

Context 不是存储，而是本次 LLM 调用的临时材料包。它从以下外部 store 读取：

- SessionStore：当前文章、当前 block、当前 cursor
- StateStore：当前 workflow run state
- MemoryStore：用户长期偏好
- ArtifactStore：任务卡、大纲、正文、版本、引用
- KnowledgeStore：本地知识或 HTTP/Tonglingyu RAG 检索结果

## LLM Provider

- 应用运行时只使用 `OpenAICompatibleProvider`。
- 测试使用显式注入的 `TestLLMProvider`，不通过生产配置 fallback。
- 缺少 `OPENAI_API_KEY` 或 `OPENAI_MODEL` 时，API container 启动失败。
