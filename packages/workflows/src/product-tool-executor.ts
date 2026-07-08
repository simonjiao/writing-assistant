import { ContextBuilder, ExternalStores, LLMProvider, PiAgentSession, newId, nowIso } from '@wa/core';
import { PromptProgramRegistry } from './prompt-program';
import { ToolRegistry, toJsonValue } from './product-tool';
import { agentToolArgsHash } from './agent-operation-ids';
import { appendAgentSessionToolTrace } from './agent-session-compaction';
import { assertAllowedTool } from './allowed-dialogue-tools';

export interface AgentToolExecutionInput<I> {
  agentSession: PiAgentSession;
  allowedTools: readonly string[];
  toolName: string;
  input: I;
  operationId: string;
  argsHash?: string;
  sessionId?: string;
  runId?: string;
  workflowId?: string;
  articleId?: string;
  blockId?: string;
  resultRef?: string;
}

export class AgentToolExecutor {
  constructor(private readonly deps: { stores: ExternalStores; toolRegistry: ToolRegistry; promptPrograms: PromptProgramRegistry; contextBuilder: ContextBuilder; llm: LLMProvider }) {}

  async executeTool<I = unknown, O = unknown>(input: AgentToolExecutionInput<I>): Promise<O> {
    assertAllowedTool(input.toolName, input.allowedTools);
    const tool = this.deps.toolRegistry.get<I, O>(input.toolName);
    const parsedInput = tool.inputSchema.parse(input.input);
    const argsHash = input.argsHash ?? agentToolArgsHash(input.input);
    const existing = await this.deps.stores.agentOperationStore.getOperation(input.operationId);
    if (existing?.status === 'completed') return existing.resultPayload as O;
    if (existing?.status === 'running') throw new Error(`Agent operation is already running: ${input.operationId}`);

    const operationInput = {
      operationId: input.operationId,
      agentSessionId: input.agentSession.id,
      runId: input.runId,
      userId: input.agentSession.userId,
      workspaceId: input.agentSession.workspaceId,
      articleId: input.articleId ?? input.agentSession.articleId,
      contextKind: input.agentSession.contextKind,
      targetId: input.agentSession.targetId,
      toolName: input.toolName,
      allowedActionId: input.toolName,
      argsHash,
      resultRef: input.resultRef,
    };
    const running = existing?.status === 'failed'
      ? await this.deps.stores.agentOperationStore.updateOperation({ ...existing, ...operationInput, status: 'running', error: undefined })
      : await this.deps.stores.agentOperationStore.startOperation(operationInput);
    await appendAgentSessionToolTrace(this.deps.stores, input.agentSession.id, { toolName: input.toolName, operationId: input.operationId, status: 'started' });
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: input.runId, type: 'tool.started', payload: { toolName: input.toolName, operationId: input.operationId, agentSessionId: input.agentSession.id }, createdAt: nowIso() });
    try {
      const output = await tool.execute({
        input: parsedInput,
        userId: input.agentSession.userId,
        sessionId: input.sessionId,
        agentSessionId: input.agentSession.id,
        runId: input.runId,
        workflowId: input.workflowId,
        articleId: input.articleId ?? input.agentSession.articleId,
        blockId: input.blockId,
      }, {
        stores: this.deps.stores,
        llm: this.deps.llm,
        contextBuilder: this.deps.contextBuilder,
        promptPrograms: this.deps.promptPrograms,
      });
      const parsedOutput = tool.outputSchema.parse(output);
      await this.deps.stores.agentOperationStore.updateOperation({ ...running, status: 'completed', resultPayload: toJsonValue(parsedOutput), resultRef: input.resultRef, error: undefined });
      await appendAgentSessionToolTrace(this.deps.stores, input.agentSession.id, { toolName: input.toolName, operationId: input.operationId, status: 'completed' });
      await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: input.runId, type: 'tool.completed', payload: { toolName: input.toolName, operationId: input.operationId, agentSessionId: input.agentSession.id }, createdAt: nowIso() });
      return parsedOutput;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.stores.agentOperationStore.updateOperation({ ...running, status: 'failed', error: message });
      await appendAgentSessionToolTrace(this.deps.stores, input.agentSession.id, { toolName: input.toolName, operationId: input.operationId, status: 'failed', error: message });
      await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: input.runId, type: 'tool.failed', payload: { toolName: input.toolName, operationId: input.operationId, agentSessionId: input.agentSession.id, error: message }, createdAt: nowIso() });
      throw error;
    }
  }
}
