import { ExternalStores, JsonValue, LLMProvider, PiAgentSession, createPiAgent, newId, nowIso } from '@wa/core';
import type { AgentSessionTarget } from './agentSessionTarget';
import { getOrCreateAgentSession } from './agentSessionTarget';
import { convertAgentMessagesToLlm, createPiStreamFn, extractLastAssistantText, writingAssistantPiModel } from './piAgentLlmAdapter';

export interface NonWorkflowPiAgentRunInput {
  target: AgentSessionTarget;
  systemPrompt: string;
  message: string;
  tools?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface NonWorkflowPiAgentRunResult {
  session: PiAgentSession;
  assistantText: string;
  messages: JsonValue[];
}

export class NonWorkflowPiAgentRunner {
  constructor(private readonly deps: { stores: ExternalStores; llm: LLMProvider }) {}

  async runTurn(input: NonWorkflowPiAgentRunInput): Promise<NonWorkflowPiAgentRunResult> {
    const { session, created } = await getOrCreateAgentSession(this.deps.stores, input.target);
    const agent = await createPiAgent({
      sessionId: session.id,
      initialState: {
        systemPrompt: input.systemPrompt,
        model: writingAssistantPiModel,
        messages: session.messages as unknown as any[],
        tools: (input.tools ?? []) as any[],
      },
      convertToLlm: convertAgentMessagesToLlm as never,
      streamFn: createPiStreamFn(this.deps.llm) as never,
      toolExecution: 'sequential',
    });
    await agent.prompt(input.message);
    const messages = agent.state.messages as unknown as JsonValue[];
    const updated = await this.deps.stores.piAgentSessionStore.saveSession({
      ...session,
      messages,
      lockVersion: session.lockVersion + 1,
      updatedAt: nowIso(),
    });
    await this.deps.stores.eventTraceStore.append({
      id: newId('evt'),
      type: 'pi.session.updated',
      payload: { userId: input.target.userId, articleId: input.target.articleId, sessionId: updated.id, contextKind: input.target.contextKind, targetId: input.target.targetId, created, metadata: input.metadata ?? {} },
      createdAt: nowIso(),
    });
    return { session: updated, assistantText: extractLastAssistantText(messages), messages };
  }
}
