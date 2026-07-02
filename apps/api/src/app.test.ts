import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { createContainer } from './bootstrap';
import { AppConfig } from './config';

let dataDir: string | undefined;
afterEach(async () => { if (dataDir) await rm(dataDir, { recursive: true, force: true }); dataDir = undefined; });

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  dataDir = join(tmpdir(), `wa-api-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return { host: '127.0.0.1', port: 0, dataDir, webOrigin: 'http://localhost:5173', llmProvider: 'mock', openaiBaseURL: 'https://api.openai.com/v1', openaiApiKey: '', openaiModel: 'mock', workflowExecutionMode: 'inline', workflowQueueDriver: 'local', enableWorkers: true, runnerConcurrency: 2, redisUrl: 'redis://localhost:6379', ragProvider: 'local', ragBaseURL: '', ragApiKey: '', ragSearchPath: '/search', ragRefsPath: '/refs', ragTimeoutMs: 1000, ragFallbackToLocal: true, ...overrides };
}

async function waitForRun(container: ReturnType<typeof createContainer>, runId: string, statuses: string[]) {
  for (let i = 0; i < 40; i += 1) {
    const run = await container.engine.getRun(runId);
    if (run && statuses.includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Run did not reach statuses: ${statuses.join(',')}`);
}

async function startRagServer(): Promise<{ baseURL: string; close: () => Promise<void> }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/search') { res.writeHead(404); res.end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}') as { query?: string };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: [{ id: 'rag-item-1', title: 'HTTP RAG 命中', content: `检索词：${body.query}`, sourceType: 'external', sourceRef: 'http-rag-1', themeTags: ['rag'], createdAt: new Date().toISOString() }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start RAG test server.');
  return { baseURL: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())) };
}

async function startTonglingyuRetrieverServer(): Promise<{ baseURL: string; lastRequest: () => Record<string, unknown> | undefined; close: () => Promise<void> }> {
  let lastRequest: Record<string, unknown> | undefined;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/retrieve') { res.writeHead(404); res.end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    lastRequest = JSON.parse(raw || '{}') as Record<string, unknown>;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      evidence_pack: {
        docs: [{
          doc_id: 'doc-bd-1',
          route: 'vector',
          content: '宝黛关系的精神相通证据。',
          score: 0.91,
          source: { citation_hint: '第三十二回' },
          metadata: { chunk_kind: 'passage_segment', evidence_projection: 'answer_basis', evidence_types: ['base_text'] },
          refs: { segment_ids: ['seg-32-1'] },
          display: { title: '第三十二回：诉肺腑' },
          source_scope: { chapter_no: 32 },
          usage_policy: { cite_allowed: true },
        }],
        sufficiency: { sufficient: true },
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start Tonglingyu retriever test server.');
  return { baseURL: `http://127.0.0.1:${address.port}`, lastRequest: () => lastRequest, close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())) };
}

describe('api app', () => {
  it('responds to health and creates task-card run inline', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    const response = await app.inject({ method: 'POST', url: '/api/workflows/task-card/start', payload: { userId: 'test-user', rawRequirement: '写一篇关于宝黛关系的长文，半文半白' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.run.status).toBe('waiting');
    expect(body.article.taskCard.topic).toContain('宝黛');
    await app.close();
  });

  it('runs workflows through the local async queue', async () => {
    const config = testConfig({ workflowExecutionMode: 'async' });
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({ method: 'POST', url: '/api/workflows/task-card/start', payload: { userId: 'test-user', rawRequirement: '写一篇关于宝黛关系的长文，半文半白' } });
    const body = response.json();
    expect(['queued', 'running', 'waiting']).toContain(body.run.status);
    const run = await waitForRun(container, body.run.id, ['waiting']);
    expect(run.status).toBe('waiting');
    await app.close();
  });

  it('uses sqlite as the persistent store', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: { userId: 'persistent-user' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().userId).toBe('persistent-user');
    await app.close();
  });

  it('queries an HTTP RAG provider through the knowledge API', async () => {
    const rag = await startRagServer();
    const config = testConfig({ ragProvider: 'http', ragBaseURL: rag.baseURL, ragFallbackToLocal: false });
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({ method: 'POST', url: '/api/knowledge/search', payload: { query: '宝黛关系', limit: 1 } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body[0].sourceRef).toBe('http-rag-1');
    expect(body[0].content).toContain('宝黛关系');
    await app.close();
    await rag.close();
  });

  it('maps Tonglingyu retriever evidence packs into knowledge items', async () => {
    const retriever = await startTonglingyuRetrieverServer();
    const config = testConfig({ ragProvider: 'tonglingyu', ragBaseURL: retriever.baseURL, ragSearchPath: '/retrieve', ragFallbackToLocal: false });
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({ method: 'POST', url: '/api/knowledge/search', payload: { query: '宝黛关系', limit: 1, themeTags: ['宝黛'] } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(retriever.lastRequest()?.top_k).toBe(1);
    expect(retriever.lastRequest()?.structured_terms).toEqual(['宝黛']);
    expect(body[0].id).toBe('doc-bd-1');
    expect(body[0].sourceType).toBe('retriever');
    expect(body[0].sourceRef).toBe('tonglingyu:doc-bd-1');
    expect(body[0].title).toBe('第三十二回：诉肺腑');
    expect(body[0].content).toContain('精神相通');
    expect(body[0].themeTags).toContain('vector');
    expect(body[0].metadata.refs.segment_ids).toEqual(['seg-32-1']);
    await app.close();
    await retriever.close();
  });
});
