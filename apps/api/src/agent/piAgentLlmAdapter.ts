import { ChatMessage, ChatResponse, LLMProvider, loadPiAi } from '@wa/core';

export const writingAssistantPiModel = {
  id: 'writing-assistant-nonworkflow',
  name: 'Writing Assistant Non-Workflow Agent',
  api: 'writing-assistant',
  provider: 'writing-assistant',
  baseUrl: 'internal',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
} as any;

export function createPiStreamFn(llm: LLMProvider) {
  return async (_model: unknown, context: { systemPrompt?: string; messages: unknown[] }) => {
    const { createAssistantMessageEventStream } = await loadPiAi();
    const stream = createAssistantMessageEventStream();
    void llm.chat({
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
  };
}

export function convertAgentMessagesToLlm(messages: unknown[]): unknown[] {
  return messages.filter((message) => {
    if (!message || typeof message !== 'object') return false;
    const role = (message as { role?: unknown }).role;
    return role === 'user' || role === 'assistant' || role === 'toolResult';
  });
}

export function extractLastAssistantText(messages: unknown[]): string {
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'assistant') continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content.map((item) => {
        if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'text') return String((item as { text?: unknown }).text ?? '');
        return '';
      }).join('').trim();
      if (text) return text;
    }
  }
  return '';
}

function contextToChatMessages(context: { systemPrompt?: string; messages: unknown[] }): ChatMessage[] {
  const messages: ChatMessage[] = context.systemPrompt ? [{ role: 'system', content: context.systemPrompt }] : [];
  for (const message of context.messages) {
    if (!message || typeof message !== 'object') continue;
    const role = (message as { role?: unknown }).role;
    const content = stringifyContent((message as { content?: unknown }).content);
    if (role === 'user') messages.push({ role: 'user', content });
    if (role === 'assistant') messages.push({ role: 'assistant', content });
    if (role === 'toolResult') messages.push({ role: 'tool', content, name: String((message as { toolName?: unknown }).toolName ?? 'tool') });
  }
  return messages;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content.map((item) => {
    if (!item || typeof item !== 'object') return '';
    if ((item as { type?: unknown }).type === 'text') return String((item as { text?: unknown }).text ?? '');
    if ((item as { type?: unknown }).type === 'image') return `[image:${String((item as { mimeType?: unknown }).mimeType ?? '')}]`;
    if ((item as { type?: unknown }).type === 'thinking') return String((item as { thinking?: unknown }).thinking ?? '');
    if ((item as { type?: unknown }).type === 'toolCall') return JSON.stringify({ toolCall: (item as { name?: unknown }).name, arguments: (item as { arguments?: unknown }).arguments });
    return '';
  }).filter(Boolean).join('\n');
}

function assistantMessage(text: string, usage?: ChatResponse['usage'], stopReason = 'stop') {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: 'writing-assistant',
    provider: 'writing-assistant',
    model: 'writing-assistant-nonworkflow',
    usage: {
      input: usage?.promptTokens ?? 0,
      output: usage?.completionTokens ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage?.totalTokens ?? ((usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0)),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: stopReason as 'stop' | 'error' | 'aborted',
    timestamp: Date.now(),
  };
}
