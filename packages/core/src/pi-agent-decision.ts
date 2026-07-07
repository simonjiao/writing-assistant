import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions, Usage } from '@earendil-works/pi-ai';
import { AllowedAction, AgentDecision, ArticleArtifact, ChatMessage, JsonValue, LLMProvider, PiAgentSession, WorkflowPolicy, WorkflowRun } from './types';
import { createPiAgent, loadPiAi } from './pi-agent-loader';
import { safeJsonParse } from './utils';

export interface PiAgentDecisionInput {
  policy: WorkflowPolicy;
  run: WorkflowRun;
  article?: ArticleArtifact;
  session: PiAgentSession;
  allowedActions: AllowedAction[];
}

export interface PiAgentDecisionOutput {
  decision: AgentDecision;
  messages: JsonValue[];
}

export class PiAgentDecisionProvider {
  constructor(private readonly llm: LLMProvider) {}

  async decide(input: PiAgentDecisionInput): Promise<PiAgentDecisionOutput> {
    const agent = await createPiAgent({
      sessionId: input.session.id,
      initialState: {
        systemPrompt: buildSystemPrompt(input.policy),
        model: piModel,
        messages: input.session.messages as unknown as AgentMessage[],
        tools: [],
      },
      convertToLlm: convertAgentMessagesToLlm,
      streamFn: (model, context, options) => this.stream(model, context, options),
      toolExecution: 'sequential',
    });
    await agent.prompt(buildDecisionPrompt(input));
    const messages = agent.state.messages as unknown as JsonValue[];
    const decision = parseDecision(agent.state.messages, input.allowedActions);
    return { decision, messages };
  }

  private async stream(_model: Model<any>, context: Context, _options?: SimpleStreamOptions) {
    const { createAssistantMessageEventStream } = await loadPiAi();
    const stream = createAssistantMessageEventStream();
    void this.llm.chat({
      jsonMode: true,
      temperature: 0.1,
      messages: contextToChatMessages(context),
    }).then((response) => {
      const message = assistantMessage(response.content, response.usage);
      const empty = assistantMessage('', response.usage);
      stream.push({ type: 'start', partial: empty });
      stream.push({ type: 'text_start', contentIndex: 0, partial: empty });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: response.content, partial: message });
      stream.push({ type: 'text_end', contentIndex: 0, content: response.content, partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
    }).catch((error) => {
      stream.push({ type: 'error', reason: 'error', error: assistantMessage(error instanceof Error ? error.message : String(error), undefined, 'error') });
    });
    return stream;
  }
}

const piModel: Model<any> = {
  id: 'writing-assistant-llm',
  name: 'Writing Assistant LLM',
  api: 'writing-assistant',
  provider: 'writing-assistant',
  baseUrl: 'internal',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

function buildSystemPrompt(policy: WorkflowPolicy): string {
  return [
    '你是写作工作流的 action selector。',
    '你只能从 allowedActions 中选择一个 action，不能发明 actionId、operationId 或工具名。',
    '如果没有可执行动作，返回 completed。',
    '只输出 JSON，不要输出 Markdown。',
    `工作流目标：${policy.goal}`,
    `动作策略：${policy.allowedActionPolicy}`,
    `人工确认策略：${policy.humanGatePolicy}`,
    `完成策略：${policy.completionPolicy}`,
  ].join('\n');
}

function buildDecisionPrompt(input: PiAgentDecisionInput): string {
  return JSON.stringify({
    requiredOutputShape: {
      intent: 'string',
      selectedActionId: 'string | undefined; 必须来自 allowedActions.id',
      rationale: 'string',
      requiresHumanGate: 'boolean',
      stopReason: 'completed | waiting | blocked | failed | undefined',
    },
    run: {
      id: input.run.id,
      workflowId: input.run.workflowId,
      status: input.run.status,
      input: input.run.input,
      state: input.run.state,
      metadata: input.run.metadata,
    },
    article: input.article ? {
      id: input.article.id,
      revision: input.article.revision,
      taskCardStatus: input.article.taskCard?.status,
      outlineCount: input.article.outline.length,
      blockCount: input.article.blocks.length,
      unwrittenOutline: input.article.outline.filter((item) => item.status !== 'written').map((item) => ({ id: item.id, title: item.title, status: item.status })),
    } : undefined,
    allowedActions: input.allowedActions,
  });
}

function convertAgentMessagesToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(isLlmMessage);
}

function isLlmMessage(message: AgentMessage): message is Message {
  return Boolean(message && typeof message === 'object' && 'role' in message && (
    (message as { role?: unknown }).role === 'user' ||
    (message as { role?: unknown }).role === 'assistant' ||
    (message as { role?: unknown }).role === 'toolResult'
  ));
}

function contextToChatMessages(context: Context): ChatMessage[] {
  const messages: ChatMessage[] = context.systemPrompt ? [{ role: 'system', content: context.systemPrompt }] : [];
  for (const message of context.messages) {
    if (message.role === 'user') messages.push({ role: 'user', content: stringifyContent(message.content) });
    if (message.role === 'assistant') messages.push({ role: 'assistant', content: stringifyContent(message.content) });
    if (message.role === 'toolResult') messages.push({ role: 'tool', content: stringifyContent(message.content), name: message.toolName });
  }
  return messages;
}

function stringifyContent(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content.map((item) => {
    if (item.type === 'text') return item.text;
    if (item.type === 'image') return `[image:${item.mimeType}]`;
    if (item.type === 'thinking') return item.thinking;
    if (item.type === 'toolCall') return JSON.stringify({ toolCall: item.name, arguments: item.arguments });
    return '';
  }).filter(Boolean).join('\n');
}

function assistantMessage(text: string, usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'writing-assistant',
    provider: 'writing-assistant',
    model: 'writing-assistant-llm',
    usage: usageToPiUsage(usage),
    stopReason,
    timestamp: Date.now(),
  };
}

function usageToPiUsage(usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }): Usage {
  return {
    input: usage?.promptTokens ?? 0,
    output: usage?.completionTokens ?? 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: usage?.totalTokens ?? ((usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0)),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function parseDecision(messages: AgentMessage[], allowedActions: AllowedAction[]): AgentDecision {
  const text = [...messages].reverse().map((message) => message.role === 'assistant' ? stringifyContent(message.content) : '').find((content) => content.trim());
  const decision = text ? safeJsonParse<AgentDecision>(text) : undefined;
  if (!decision) throw new Error('Pi agent decision did not return valid JSON.');
  if (decision.selectedActionId && !allowedActions.some((action) => action.id === decision.selectedActionId)) {
    throw new Error(`Pi agent selected unauthorized action: ${decision.selectedActionId}`);
  }
  if (!decision.selectedActionId && allowedActions.length && decision.stopReason !== 'blocked' && decision.stopReason !== 'failed' && decision.stopReason !== 'waiting') {
    throw new Error('Pi agent did not select an action while allowedActions is non-empty.');
  }
  return {
    intent: requireText(decision.intent, 'intent'),
    selectedActionId: decision.selectedActionId,
    rationale: requireText(decision.rationale, 'rationale'),
    requiresHumanGate: Boolean(decision.requiresHumanGate),
    stopReason: decision.stopReason,
  };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Pi agent decision missing ${field}.`);
  return value.trim();
}
