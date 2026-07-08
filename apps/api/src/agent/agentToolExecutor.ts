import { ExternalStores, JsonValue, PiAgentSession, SkillExecutor, newId, nowIso } from '@wa/core';
import { agentToolArgsHash } from './agentOperationIds';
import { appendAgentSessionToolTrace } from './agentSessionCompaction';
import { assertAllowedTool } from './allowedTools';

export interface AgentToolExecutionInput<I> {
  agentSession: PiAgentSession;
  allowedTools: readonly string[];
  toolName: string;
  skillId: string;
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
  constructor(private readonly deps: { stores: ExternalStores; skillExecutor: SkillExecutor }) {}

  async executeSkillTool<I = unknown, O = unknown>(input: AgentToolExecutionInput<I>): Promise<O> {
    assertAllowedTool(input.toolName, input.allowedTools);
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
      const output = await this.deps.skillExecutor.executeSkill<I, O>(input.skillId, input.input, {
        userId: input.agentSession.userId,
        sessionId: input.sessionId,
        agentSessionId: input.agentSession.id,
        runId: input.runId,
        workflowId: input.workflowId,
        articleId: input.articleId ?? input.agentSession.articleId,
        blockId: input.blockId,
      });
      await this.deps.stores.agentOperationStore.updateOperation({ ...running, status: 'completed', resultPayload: toJsonValue(output), resultRef: input.resultRef, error: undefined });
      await appendAgentSessionToolTrace(this.deps.stores, input.agentSession.id, { toolName: input.toolName, operationId: input.operationId, status: 'completed' });
      await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: input.runId, type: 'tool.completed', payload: { toolName: input.toolName, operationId: input.operationId, agentSessionId: input.agentSession.id }, createdAt: nowIso() });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.stores.agentOperationStore.updateOperation({ ...running, status: 'failed', error: message });
      await appendAgentSessionToolTrace(this.deps.stores, input.agentSession.id, { toolName: input.toolName, operationId: input.operationId, status: 'failed', error: message });
      await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: input.runId, type: 'tool.failed', payload: { toolName: input.toolName, operationId: input.operationId, agentSessionId: input.agentSession.id, error: message }, createdAt: nowIso() });
      throw error;
    }
  }
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}
