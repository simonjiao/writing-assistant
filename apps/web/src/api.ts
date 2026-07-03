import { AgentEvent, ArticleArtifact, RunResponse } from './types';
const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787';
export interface TaskCardRevisionResponse { article: ArticleArtifact; summary: string; changedFields: string[] }
async function request<T>(path: string, options?: RequestInit): Promise<T> { const response = await fetch(`${API_BASE}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } }); if (!response.ok) throw new Error(`${response.status} ${await response.text()}`); return response.json() as Promise<T>; }
function wsBase() { return API_BASE.replace(/^http/, 'ws'); }
export const api = {
  createSession(userId = 'demo-user') { return request<{ id: string; userId: string }>('/api/sessions', { method: 'POST', body: JSON.stringify({ userId }) }); },
  startTaskCard(rawRequirement: string, userId: string, sessionId?: string) { return request<RunResponse>('/api/workflows/task-card/start', { method: 'POST', body: JSON.stringify({ rawRequirement, userId, sessionId }) }); },
  startOutline(articleId: string, userId: string, sessionId?: string) { return request<RunResponse>('/api/workflows/outline/start', { method: 'POST', body: JSON.stringify({ articleId, userId, sessionId }) }); },
  startSection(articleId: string, sectionId: string, userId: string, sessionId?: string) { return request<RunResponse>('/api/workflows/section/start', { method: 'POST', body: JSON.stringify({ articleId, sectionId, userId, sessionId }) }); },
  startPatch(articleId: string, blockId: string, instruction: string, userId: string, sessionId?: string) { return request<RunResponse>('/api/workflows/patch/start', { method: 'POST', body: JSON.stringify({ articleId, blockId, instruction, userId, sessionId }) }); },
  resume(runId: string, input: unknown) { return request<RunResponse>(`/api/workflows/${runId}/resume`, { method: 'POST', body: JSON.stringify(input) }); },
  getRun(runId: string) { return request<RunResponse>(`/api/runs/${runId}`); },
  getArticle(articleId: string) { return request<ArticleArtifact>(`/api/articles/${articleId}`); },
  reviseTaskCard(articleId: string, input: { instruction: string; userId?: string; sessionId?: string }) { return request<TaskCardRevisionResponse>(`/api/articles/${articleId}/task-card/revise`, { method: 'POST', body: JSON.stringify(input) }); },
  updateOutlineItem(articleId: string, sectionId: string, input: { title: string; goal: string; userId?: string }) { return request<ArticleArtifact>(`/api/articles/${articleId}/outline/${sectionId}`, { method: 'PATCH', body: JSON.stringify(input) }); },
  streamRunEvents(runId: string, onEvent: (event: AgentEvent) => void, onError?: (error: Event) => void) { const source = new EventSource(`${API_BASE}/api/runs/${runId}/stream`); const eventTypes = ['workflow.started','workflow.queued','workflow.resumed','workflow.completed','workflow.failed','workflow.waiting','review.required','node.started','node.completed','skill.started','skill.completed','artifact.updated','queue.enqueued','queue.dequeued','queue.completed','queue.failed','rag.http.started','rag.http.completed','rag.http.failed']; for (const type of eventTypes) source.addEventListener(type, (message) => onEvent(JSON.parse((message as MessageEvent).data) as AgentEvent)); if (onError) source.onerror = onError; return () => source.close(); },
  openEventWebSocket(runId: string, onEvent: (event: AgentEvent) => void) { const socket = new WebSocket(`${wsBase()}/api/events/ws?runId=${encodeURIComponent(runId)}`); socket.onmessage = (message) => { const payload = JSON.parse(message.data as string) as { type: string; event?: AgentEvent }; if (payload.type === 'event' && payload.event) onEvent(payload.event); }; return () => socket.close(); },
};
