import { AgentEvent, EventTraceStore, KnowledgeItem, KnowledgeStore, newId, nowIso } from '@wa/core';

export interface HttpRagKnowledgeStoreConfig { baseURL: string; apiKey?: string; searchPath?: string; refsPath?: string; timeoutMs?: number; fallback?: KnowledgeStore; eventTraceStore?: EventTraceStore }

type RawRagItem = Partial<KnowledgeItem> & { text?: string; source?: string; metadata?: Record<string, unknown> };
type RagResponse = RawRagItem[] | { items?: RawRagItem[]; results?: RawRagItem[]; data?: RawRagItem[] };

export class HttpRagKnowledgeStore implements KnowledgeStore {
  constructor(private readonly config: HttpRagKnowledgeStoreConfig) {}

  async search(query: string, options?: { limit?: number; themeTags?: string[] }): Promise<KnowledgeItem[]> {
    const eventBase = { runId: undefined, payload: { query, limit: options?.limit ?? 6, themeTags: options?.themeTags ?? [] }, createdAt: nowIso() };
    await this.emit({ ...eventBase, id: newId('evt'), type: 'rag.http.started' });
    try {
      const response = await this.post<RagResponse>(this.config.searchPath ?? '/search', { query, limit: options?.limit ?? 6, themeTags: options?.themeTags ?? [] });
      const items = this.normalizeResponse(response).slice(0, options?.limit ?? 6);
      await this.emit({ ...eventBase, id: newId('evt'), type: 'rag.http.completed', payload: { ...eventBase.payload, count: items.length }, createdAt: nowIso() });
      return items;
    } catch (error) {
      await this.emit({ ...eventBase, id: newId('evt'), type: 'rag.http.failed', payload: { ...eventBase.payload, error: error instanceof Error ? error.message : String(error) }, createdAt: nowIso() });
      if (this.config.fallback) return this.config.fallback.search(query, options);
      throw error;
    }
  }

  async listByRefs(sourceRefs: string[]): Promise<KnowledgeItem[]> {
    try {
      const response = await this.post<RagResponse>(this.config.refsPath ?? '/refs', { sourceRefs });
      const refs = new Set(sourceRefs);
      return this.normalizeResponse(response).filter((item) => refs.has(item.sourceRef));
    } catch (error) {
      if (this.config.fallback) return this.config.fallback.listByRefs(sourceRefs);
      throw error;
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.config.baseURL.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 10_000);
    try {
      const response = await fetch(url, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`HTTP RAG request failed: ${response.status} ${await response.text()}`);
      return (await response.json()) as T;
    } finally { clearTimeout(timeout); }
  }

  private normalizeResponse(response: RagResponse): KnowledgeItem[] {
    const rawItems = Array.isArray(response) ? response : response.items ?? response.results ?? response.data ?? [];
    return rawItems.map((item, index) => this.normalizeItem(item, index));
  }

  private normalizeItem(item: RawRagItem, index: number): KnowledgeItem {
    const metadata = item.metadata ?? {};
    const sourceRef = item.sourceRef ?? item.source ?? str(metadata.sourceRef) ?? str(metadata.source) ?? `rag:${index}`;
    const themeTags = Array.isArray(item.themeTags) ? item.themeTags.map(String) : Array.isArray(metadata.themeTags) ? metadata.themeTags.map(String) : [];
    return { id: item.id ?? newId('rag'), title: item.title ?? str(metadata.title) ?? sourceRef, content: item.content ?? item.text ?? str(metadata.content) ?? '', sourceType: item.sourceType ?? 'manual', sourceRef, themeTags, createdAt: item.createdAt ?? nowIso() };
  }

  private async emit(event: AgentEvent): Promise<void> { await this.config.eventTraceStore?.append(event); }
}
function str(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
