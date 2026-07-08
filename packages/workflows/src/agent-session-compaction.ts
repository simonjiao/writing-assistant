import { ExternalStores, JsonValue, PiAgentSession, nowIso } from '@wa/core';

const maxSessionMessages = 24;
const compactBatchSize = 12;
const maxSummaryChars = 2400;
const maxTraceChars = 1800;
const maxContentChars = 360;

export async function appendAgentSessionMessages(stores: ExternalStores, session: PiAgentSession, messages: JsonValue[]): Promise<PiAgentSession> {
  if (!messages.length) return session;
  const combined = [...session.messages, ...messages];
  const compactCount = Math.max(0, combined.length - maxSessionMessages);
  if (!compactCount) {
    return stores.piAgentSessionStore.updateSession(session.id, { messages: combined });
  }
  const compacted = combined.slice(0, Math.max(compactCount, compactBatchSize));
  const kept = combined.slice(compacted.length);
  return stores.piAgentSessionStore.updateSession(session.id, {
    messages: kept,
    compactSummary: appendBoundedText(session.compactSummary, summarizeMessages(compacted), maxSummaryChars),
  });
}

export async function appendAgentSessionToolTrace(stores: ExternalStores, sessionId: string, trace: { toolName: string; operationId: string; status: 'started' | 'completed' | 'failed'; error?: string }): Promise<PiAgentSession | undefined> {
  const session = await stores.piAgentSessionStore.getSession(sessionId);
  if (!session) return undefined;
  const line = [
    nowIso(),
    trace.status,
    trace.toolName,
    trace.operationId,
    trace.error ? `error=${compactText(trace.error)}` : undefined,
  ].filter(Boolean).join(' | ');
  return stores.piAgentSessionStore.updateSession(session.id, {
    toolTraceSummary: appendBoundedText(session.toolTraceSummary, line, maxTraceChars),
  });
}

function summarizeMessages(messages: JsonValue[]): string {
  return messages.map((message) => {
    const record = message && typeof message === 'object' && !Array.isArray(message) ? message as Record<string, unknown> : {};
    const role = typeof record.role === 'string' ? record.role : 'message';
    const content = typeof record.content === 'string' ? compactText(record.content) : compactText(JSON.stringify(message) ?? String(message));
    const proposalId = typeof record.proposalId === 'string' ? ` proposal=${record.proposalId}` : '';
    return `${role}${proposalId}: ${content}`;
  }).join('\n');
}

function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxContentChars);
}

function appendBoundedText(current: string | undefined, addition: string, limit: number): string {
  const merged = [current?.trim(), addition.trim()].filter(Boolean).join('\n');
  if (merged.length <= limit) return merged;
  return merged.slice(merged.length - limit).replace(/^[^\n]*\n?/, '').trim();
}
