import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { FastifyReply } from 'fastify';
import { AgentEvent, EventSubscriptionFilter, Unsubscribe } from '@wa/core';
import { AppConfig } from './config';
import { AppContainer } from './bootstrap';

export function createApp(config: AppConfig, container: AppContainer) {
  const app = Fastify({ logger: true });
  void app.register(cors, { origin: [config.webOrigin, 'http://localhost:5173', 'http://127.0.0.1:5173'] });
  void app.register(websocket);
  app.addHook('onClose', async () => { await container.close(); });

  app.get('/health', async () => ({ ok: true, service: 'writing-assistant-api', store: 'sqlite', workflowExecutionMode: config.workflowExecutionMode, workflowQueueDriver: config.workflowExecutionMode === 'async' ? config.workflowQueueDriver : 'disabled', runnerConcurrency: config.workflowExecutionMode === 'async' ? config.runnerConcurrency : 0, ragProvider: config.ragProvider }));
  app.get('/api/workflows', async () => container.engine.listWorkflows());
  app.get('/api/skills', async () => container.skills.list());
  app.get('/api/queue/status', async () => ({ executionMode: config.workflowExecutionMode, queueDriver: config.workflowExecutionMode === 'async' ? config.workflowQueueDriver : 'disabled', runnerConcurrency: config.workflowExecutionMode === 'async' ? config.runnerConcurrency : 0, depth: container.queue?.getDepth ? await container.queue.getDepth() : 0 }));

  app.post('/api/sessions', async (request) => { const body = request.body as { userId?: string }; return container.stores.sessionStore.createSession(body.userId ?? 'demo-user'); });
  app.get('/api/articles', async (request) => { const query = request.query as { userId?: string }; return container.stores.artifactStore.listArticles(query.userId ?? 'demo-user'); });
  app.get('/api/articles/:articleId', async (request, reply) => { const { articleId } = request.params as { articleId: string }; const article = await container.stores.artifactStore.getArticle(articleId); if (!article) return reply.code(404).send({ error: 'Article not found' }); return article; });
  app.post('/api/knowledge/search', async (request) => { const body = request.body as { query: string; limit?: number; themeTags?: string[] }; return container.stores.knowledgeStore.search(body.query, { limit: body.limit, themeTags: body.themeTags }); });

  app.post('/api/workflows/task-card/start', async (request) => { const body = request.body as { rawRequirement: string; userId?: string; sessionId?: string }; const userId = body.userId ?? 'demo-user'; const run = await container.engine.startWorkflow('task-card-workflow', { rawRequirement: body.rawRequirement, userId, sessionId: body.sessionId }, { userId, sessionId: body.sessionId }); return enrichRun(container, run.id); });
  app.post('/api/workflows/outline/start', async (request) => { const body = request.body as { articleId: string; userId?: string; sessionId?: string }; const userId = body.userId ?? 'demo-user'; const run = await container.engine.startWorkflow('outline-workflow', { articleId: body.articleId }, { userId, sessionId: body.sessionId, articleId: body.articleId }); return enrichRun(container, run.id); });
  app.post('/api/workflows/section/start', async (request) => { const body = request.body as { articleId: string; sectionId: string; userId?: string; sessionId?: string }; const userId = body.userId ?? 'demo-user'; const run = await container.engine.startWorkflow('section-writing-workflow', { articleId: body.articleId, sectionId: body.sectionId }, { userId, sessionId: body.sessionId, articleId: body.articleId }); return enrichRun(container, run.id); });
  app.post('/api/workflows/patch/start', async (request) => { const body = request.body as { articleId: string; blockId: string; instruction: string; userId?: string; sessionId?: string }; const userId = body.userId ?? 'demo-user'; if (body.sessionId) await container.stores.sessionStore.updateSession(body.sessionId, { currentArticleId: body.articleId, currentBlockId: body.blockId }); const run = await container.engine.startWorkflow('patch-workflow', { articleId: body.articleId, blockId: body.blockId, instruction: body.instruction }, { userId, sessionId: body.sessionId, articleId: body.articleId }); return enrichRun(container, run.id); });
  app.post('/api/workflows/:runId/resume', async (request) => { const { runId } = request.params as { runId: string }; await container.engine.resumeWorkflow(runId, request.body ?? {}); return enrichRun(container, runId); });
  app.post('/api/workflows/:runId/cancel', async (request) => { const { runId } = request.params as { runId: string }; await container.engine.cancelWorkflow(runId); return enrichRun(container, runId); });
  app.get('/api/runs/:runId', async (request, reply) => { const { runId } = request.params as { runId: string }; const run = await container.engine.getRun(runId); if (!run) return reply.code(404).send({ error: 'Run not found' }); return enrichRun(container, runId); });
  app.get('/api/runs/:runId/events', async (request) => { const { runId } = request.params as { runId: string }; return container.stores.eventTraceStore.listByRun(runId); });
  app.get('/api/runs/:runId/stream', async (request, reply) => { const { runId } = request.params as { runId: string }; await openSseStream(container, reply, { runId }); });
  app.get('/api/events/stream', async (request, reply) => { const query = request.query as { runId?: string; userId?: string }; await openSseStream(container, reply, { runId: query.runId, userId: query.userId }); });
  app.get('/api/events/ws', { websocket: true }, (socket, request) => { const query = request.query as { runId?: string; userId?: string }; let unsubscribe: Unsubscribe | undefined; void Promise.resolve(container.eventBus.subscribe({ runId: query.runId, userId: query.userId }, (event) => socket.send(JSON.stringify({ type: 'event', event })))).then((value) => { unsubscribe = value; }); socket.send(JSON.stringify({ type: 'connected' })); socket.on('close', () => unsubscribe?.()); });
  return app;
}

async function openSseStream(container: AppContainer, reply: FastifyReply, filter: EventSubscriptionFilter) {
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event: AgentEvent) => { reply.raw.write(`id: ${event.id}\n`); reply.raw.write(`event: ${event.type}\n`); reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); };
  reply.raw.write('event: connected\n'); reply.raw.write(`data: ${JSON.stringify({ ok: true })}\n\n`);
  if (filter.runId) for (const event of await container.stores.eventTraceStore.listByRun(filter.runId)) send(event);
  const unsubscribe = await container.eventBus.subscribe(filter, send);
  const heartbeat = setInterval(() => { reply.raw.write('event: ping\n'); reply.raw.write(`data: ${JSON.stringify({ t: Date.now() })}\n\n`); }, 15_000);
  reply.raw.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
}

async function enrichRun(container: AppContainer, runId: string) {
  const run = await container.engine.getRun(runId);
  if (!run) throw new Error('Run not found after execution.');
  const articleId = (run.state.draftArticle as { articleId?: string } | undefined)?.articleId ?? (run.state.finalizedTaskCard as { articleId?: string } | undefined)?.articleId ?? (run.state.outlineDraft as { articleId?: string } | undefined)?.articleId ?? (run.state.finalizedOutline as { articleId?: string } | undefined)?.articleId ?? (run.state.committedSection as { articleId?: string } | undefined)?.articleId ?? (run.state.appliedPatch as { articleId?: string } | undefined)?.articleId ?? (typeof run.metadata.articleId === 'string' ? run.metadata.articleId : undefined);
  const article = articleId ? await container.stores.artifactStore.getArticle(articleId) : undefined;
  const events = await container.stores.eventTraceStore.listByRun(run.id);
  return { run, article, events };
}
