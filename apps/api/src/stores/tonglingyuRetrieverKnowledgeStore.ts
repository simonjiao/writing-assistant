import { AgentEvent, EventTraceStore, KnowledgeItem, KnowledgeStore, newId, nowIso } from '@wa/core';

export interface TonglingyuRetrieverKnowledgeStoreConfig {
  baseURL: string;
  apiKey?: string;
  retrievePath?: string;
  timeoutMs?: number;
  fallback?: KnowledgeStore;
  eventTraceStore?: EventTraceStore;
}

type JsonRecord = Record<string, unknown>;

interface TonglingyuEvidenceDoc {
  schema_version?: string;
  doc_id?: string;
  route?: string;
  content?: string;
  score?: number;
  source?: JsonRecord;
  metadata?: JsonRecord;
  refs?: Record<string, string[]>;
  routes?: JsonRecord[];
  display?: JsonRecord;
  source_scope?: JsonRecord;
  usage_policy?: JsonRecord;
}

interface TonglingyuRetrieveResponse {
  ok?: boolean;
  error?: { code?: string; message?: string };
  evidence_pack?: {
    docs?: TonglingyuEvidenceDoc[];
    diagnostics?: JsonRecord;
    sufficiency?: JsonRecord;
  };
}

export class TonglingyuRetrieverKnowledgeStore implements KnowledgeStore {
  constructor(private readonly config: TonglingyuRetrieverKnowledgeStoreConfig) {}

  async search(query: string, options?: { limit?: number; themeTags?: string[] }): Promise<KnowledgeItem[]> {
    const limit = options?.limit ?? 6;
    const eventBase = { runId: undefined, payload: { query, limit, themeTags: options?.themeTags ?? [], provider: 'tonglingyu' }, createdAt: nowIso() };
    await this.emit({ ...eventBase, id: newId('evt'), type: 'rag.http.started' });
    try {
      const response = await this.post<TonglingyuRetrieveResponse>(this.config.retrievePath ?? '/retrieve', {
        query,
        top_k: limit,
        ...(options?.themeTags?.length ? { structured_terms: options.themeTags } : {}),
      });
      const items = this.normalizeResponse(response).slice(0, limit);
      await this.emit({ ...eventBase, id: newId('evt'), type: 'rag.http.completed', payload: { ...eventBase.payload, count: items.length }, createdAt: nowIso() });
      return items;
    } catch (error) {
      await this.emit({ ...eventBase, id: newId('evt'), type: 'rag.http.failed', payload: { ...eventBase.payload, error: error instanceof Error ? error.message : String(error) }, createdAt: nowIso() });
      if (this.config.fallback) return this.config.fallback.search(query, options);
      throw error;
    }
  }

  async listByRefs(sourceRefs: string[]): Promise<KnowledgeItem[]> {
    if (this.config.fallback) return this.config.fallback.listByRefs(sourceRefs);
    throw new Error('Tonglingyu retriever HTTP adapter does not expose a refs lookup endpoint.');
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.config.baseURL.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 10_000);
    try {
      const response = await fetch(url, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`Tonglingyu retriever request failed: ${response.status} ${await response.text()}`);
      return (await response.json()) as T;
    } finally { clearTimeout(timeout); }
  }

  private normalizeResponse(response: TonglingyuRetrieveResponse): KnowledgeItem[] {
    if (response.ok === false) {
      const message = response.error?.message ?? response.error?.code ?? 'unknown retriever error';
      throw new Error(`Tonglingyu retriever failed: ${message}`);
    }
    const docs = response.evidence_pack?.docs ?? [];
    return docs.map((doc, index) => this.normalizeDoc(doc, index, response.evidence_pack?.sufficiency));
  }

  private normalizeDoc(doc: TonglingyuEvidenceDoc, index: number, sufficiency?: JsonRecord): KnowledgeItem {
    const sourceRef = doc.doc_id ? `tonglingyu:${doc.doc_id}` : `tonglingyu:${index}`;
    const display = doc.display ?? {};
    const source = doc.source ?? {};
    const metadata = doc.metadata ?? {};
    return {
      id: doc.doc_id ?? sourceRef,
      title: firstString(display.title, display.citation_hint, source.citation_hint, source.source_label, doc.route, sourceRef),
      content: doc.content ?? '',
      sourceType: 'retriever',
      sourceRef,
      themeTags: compactStrings([doc.route, metadata.chunk_kind, metadata.evidence_projection, metadata.basis_status, ...arrayOfStrings(metadata.evidence_types)]),
      metadata: {
        provider: 'tonglingyu',
        schemaVersion: doc.schema_version,
        route: doc.route,
        score: doc.score,
        source,
        refs: doc.refs ?? {},
        routes: doc.routes ?? [],
        display,
        sourceScope: doc.source_scope ?? {},
        usagePolicy: doc.usage_policy ?? {},
        sufficiency,
      },
      createdAt: nowIso(),
    };
  }

  private async emit(event: AgentEvent): Promise<void> { await this.config.eventTraceStore?.append(event); }
}

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value;
  return 'Tonglingyu evidence';
}
function arrayOfStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []; }
function compactStrings(values: unknown[]): string[] { return [...new Set(values.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))]; }
