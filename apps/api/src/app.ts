import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { FastifyReply } from 'fastify';
import { AgentEvent, ArticleArtifact, ArticleBlock, DialogueContextKind, EventSubscriptionFilter, newId, nowIso, OutlineItem, RevisionOperation, RevisionProposal, Unsubscribe, WritingTaskCard, WritingWorkspace } from '@wa/core';
import type { DialogueCoordinatorInput, DialogueCoordinatorOutput, OutlineItemReviserOutput, OutlineReviserOutput, TaskCardReviserOutput } from '@wa/skills';
import { AppConfig } from './config';
import { AppContainer } from './bootstrap';
import { DomainProfileSelectionRequest, getDomainProfileSummary, listDomainProfileSummaries, recommendDomainProfiles, resolveDomainProfileSelection } from './domainProfiles';
import { getWritingStandardDisplaySummary, getWritingStandardSummary, resolveWritingStandardSelection, WritingStandardSelectionRequest } from './writingStandards';

export function createApp(config: AppConfig, container: AppContainer) {
  const app = Fastify({ logger: true });
  void app.register(cors, { origin: [config.webOrigin, 'http://localhost:5173', 'http://127.0.0.1:5173'] });
  void app.register(websocket);
  app.addHook('onClose', async () => { await container.close(); });

  app.get('/health', async () => ({ ok: true, service: 'writing-assistant-api', store: 'sqlite', workflowExecutionMode: config.workflowExecutionMode, workflowQueueDriver: config.workflowExecutionMode === 'async' ? config.workflowQueueDriver : 'disabled', runnerConcurrency: config.workflowExecutionMode === 'async' ? config.runnerConcurrency : 0, ragProvider: config.ragProvider }));
  app.get('/api/workflows', async () => container.engine.listWorkflows());
  app.get('/api/skills', async () => container.skills.list());
  app.get('/api/queue/status', async () => ({ executionMode: config.workflowExecutionMode, queueDriver: config.workflowExecutionMode === 'async' ? config.workflowQueueDriver : 'disabled', runnerConcurrency: config.workflowExecutionMode === 'async' ? config.runnerConcurrency : 0, depth: container.queue?.getDepth ? await container.queue.getDepth() : 0 }));

  app.post('/api/sessions', async (request, reply) => {
    const body = request.body as { userId?: string };
    const userId = readUserId(body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const workspace = await ensureDefaultWorkspace(container, userId);
    const session = await container.stores.sessionStore.createSession(userId);
    return container.stores.sessionStore.updateSession(session.id, { currentWorkspaceId: workspace.id });
  });
  app.get('/api/workspaces', async (request, reply) => {
    const query = request.query as { userId?: string; includeDeleted?: string };
    const userId = readUserId(query.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    await ensureDefaultWorkspace(container, userId);
    return sortWorkspaces(await container.stores.workspaceStore.listWorkspaces(userId, { includeDeleted: query.includeDeleted === 'true' }));
  });
  app.post('/api/workspaces', async (request, reply) => {
    const body = request.body as { userId?: string; name?: string; memberUserIds?: string[] };
    const userId = readUserId(body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const name = body.name?.trim();
    if (!name) return reply.code(400).send({ error: 'Workspace name is required.' });
    const memberUserIds = [...new Set((body.memberUserIds ?? []).map((item) => item.trim()).filter((item) => item && item !== userId))];
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId, name, memberUserIds });
    return reply.code(201).send(workspace);
  });
  app.delete('/api/workspaces/:workspaceId', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = (request.body ?? {}) as { userId?: string };
    const userId = readUserId(body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const workspace = await container.stores.workspaceStore.getWorkspace(workspaceId);
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found.' });
    if (workspace.userId !== userId) return reply.code(403).send({ error: 'Workspace owner required.' });
    if (workspace.isDefault) return reply.code(400).send({ error: 'Default workspace cannot be deleted.' });
    return container.stores.workspaceStore.updateWorkspace({ ...workspace, deletedAt: workspace.deletedAt ?? nowIso() });
  });
  app.get('/api/domain-profiles', async () => listDomainProfileSummaries());
  app.get('/api/writing-standards', async () => getWritingStandardSummary());
  app.post('/api/domain-profiles/recommend', async (request) => {
    const body = request.body as { rawRequirement?: string; limit?: number };
    return recommendDomainProfiles(body.rawRequirement ?? '', body.limit);
  });
  app.get('/api/domain-profiles/:profileId', async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    const profile = getDomainProfileSummary(profileId);
    if (!profile) return reply.code(404).send({ error: 'Domain profile not found' });
    return profile;
  });
  app.get('/api/articles', async (request, reply) => {
    const query = request.query as { userId?: string; view?: string; includeDeleted?: string; workspaceId?: string };
    const userId = readUserId(query.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const workspaceId = query.workspaceId?.trim() || (await ensureDefaultWorkspace(container, userId)).id;
    const workspace = await requireWorkspaceAccess(container, userId, workspaceId);
    if (!workspace) return reply.code(403).send({ error: 'Workspace access required.' });
    const articles = await container.stores.artifactStore.listArticles(workspace.id, { includeDeleted: query.includeDeleted === 'true' });
    return query.view === 'summary' ? articles.map(articleSummary) : articles.map(withWritingStandardSummary);
  });
  app.get('/api/articles/:articleId', async (request, reply) => { const { articleId } = request.params as { articleId: string }; const query = request.query as { userId?: string }; const userId = readUserId(query.userId); if (!userId) return reply.code(400).send({ error: 'userId is required.' }); const access = await requireArticleAccess(container, userId, articleId); if (!access.ok) return reply.code(access.statusCode).send({ error: access.error }); return withWritingStandardSummary(access.article); });
  app.delete('/api/articles/:articleId', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const body = (request.body ?? {}) as { userId?: string };
    const userId = readUserId(body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const article = access.article;
    await container.stores.artifactStore.commitVersion(article.id, '删除任务', 'user');
    const deleted = await container.stores.artifactStore.deleteArticle(article.id);
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, reason: 'article-deleted', userId }, createdAt: nowIso() });
    return articleSummary(deleted);
  });
  app.post('/api/articles/:articleId/task-card/revise', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const body = request.body as { instruction?: string; userId?: string; sessionId?: string };
    const instruction = body.instruction?.trim();
    if (!instruction) return reply.code(400).send({ error: 'Task card revision instruction is required.' });
    const article = await container.stores.artifactStore.getArticle(articleId);
    if (!article) return reply.code(404).send({ error: 'Article not found' });
    const userId = readUserId(body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    if (!(await canAccessArticle(container, userId, article))) return reply.code(403).send({ error: 'Workspace access required.' });
    if (!article.taskCard) return reply.code(400).send({ error: 'Article has no task card to revise.' });
    const result = await container.runtime.invokeSkill<{ articleId: string; instruction: string; currentTaskCard: WritingTaskCard }, TaskCardReviserOutput>(
      'task-card-reviser',
      { articleId: article.id, instruction, currentTaskCard: article.taskCard },
      { userId, sessionId: body.sessionId, articleId: article.id },
    );
    article.taskCard = result.taskCard;
    article.title = result.taskCard.topic;
    const updated = await container.stores.artifactStore.updateArticle(article);
    const reason = `修订任务卡：${result.summary.slice(0, 80)}`;
    await container.stores.artifactStore.commitVersion(article.id, reason, 'user');
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, reason: 'task-card-revised', changedFields: result.changedFields, userId }, createdAt: nowIso() });
    const updatedArticle = await container.stores.artifactStore.getArticle(updated.id);
    return { article: updatedArticle ? withWritingStandardSummary(updatedArticle) : updatedArticle, summary: result.summary, changedFields: result.changedFields };
  });
  app.post('/api/articles/:articleId/task-card/confirm', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const body = (request.body ?? {}) as { userId?: string; sessionId?: string };
    const userId = readUserId(body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const article = access.article;
    if (!article.taskCard) return reply.code(400).send({ error: 'Article has no task card to confirm.' });
    if (article.taskCard.status !== 'confirmed') {
      article.taskCard = { ...article.taskCard, status: 'confirmed', updatedAt: nowIso() };
      await container.stores.artifactStore.updateArticle(article);
      await container.stores.artifactStore.commitVersion(article.id, '确认任务卡', 'user');
      await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, reason: 'task-card-confirmed', userId }, createdAt: nowIso() });
    }
    if (body.sessionId) await container.stores.sessionStore.updateSession(body.sessionId, { currentArticleId: article.id, currentWorkspaceId: article.workspaceId });
    const updatedArticle = await container.stores.artifactStore.getArticle(article.id);
    return updatedArticle ? withWritingStandardSummary(updatedArticle) : updatedArticle;
  });
  app.patch('/api/articles/:articleId/outline/:sectionId', async (request, reply) => {
    const { articleId, sectionId } = request.params as { articleId: string; sectionId: string };
    const body = request.body as { title?: string; goal?: string; userId?: string };
    const title = body.title?.trim();
    const goal = body.goal?.trim();
    if (!title || !goal) return reply.code(400).send({ error: 'Outline title and goal are required.' });
    const article = await container.stores.artifactStore.getArticle(articleId);
    if (!article) return reply.code(404).send({ error: 'Article not found' });
    const userId = readUserId(body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    if (!(await canAccessArticle(container, userId, article))) return reply.code(403).send({ error: 'Workspace access required.' });
    const existing = article.outline.find((item) => item.id === sectionId);
    if (!existing) return reply.code(404).send({ error: 'Outline section not found' });
    article.outline = article.outline.map((item) => item.id === sectionId ? { ...item, title, goal } : item);
    const updated = await container.stores.artifactStore.updateArticle(article);
    await container.stores.artifactStore.commitVersion(article.id, `编辑大纲章节：${title}`, 'user');
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, sectionId, reason: 'outline-section-edited', userId }, createdAt: nowIso() });
    const updatedArticle = await container.stores.artifactStore.getArticle(updated.id);
    return updatedArticle ? withWritingStandardSummary(updatedArticle) : updatedArticle;
  });
  app.post('/api/articles/:articleId/outline/:sectionId/revise', async (request, reply) => {
    const { articleId, sectionId } = request.params as { articleId: string; sectionId: string };
    const body = request.body as { instruction?: string; userId?: string; sessionId?: string };
    const instruction = body.instruction?.trim();
    if (!instruction) return reply.code(400).send({ error: 'Outline revision instruction is required.' });
    const article = await container.stores.artifactStore.getArticle(articleId);
    if (!article) return reply.code(404).send({ error: 'Article not found' });
    const userId = readUserId(body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    if (!(await canAccessArticle(container, userId, article))) return reply.code(403).send({ error: 'Workspace access required.' });
    const existing = article.outline.find((item) => item.id === sectionId);
    if (!existing) return reply.code(404).send({ error: 'Outline section not found' });
    const result = await container.runtime.invokeSkill<{ articleId: string; instruction: string; currentOutlineItem: typeof existing; taskCard?: WritingTaskCard; articleOutline: typeof article.outline }, OutlineItemReviserOutput>(
      'outline-item-reviser',
      { articleId: article.id, instruction, currentOutlineItem: existing, taskCard: article.taskCard, articleOutline: article.outline },
      { userId, sessionId: body.sessionId, articleId: article.id },
    );
    article.outline = article.outline.map((item) => item.id === sectionId ? result.outlineItem : item);
    const updated = await container.stores.artifactStore.updateArticle(article);
    const reason = `修订大纲章节：${result.summary.slice(0, 80)}`;
    await container.stores.artifactStore.commitVersion(article.id, reason, 'user');
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, sectionId, reason: 'outline-section-revised', changedFields: result.changedFields, userId }, createdAt: nowIso() });
    const updatedArticle = await container.stores.artifactStore.getArticle(updated.id);
    return { article: updatedArticle ? withWritingStandardSummary(updatedArticle) : updatedArticle, outlineItem: result.outlineItem, summary: result.summary, changedFields: result.changedFields };
  });
  app.post('/api/articles/:articleId/dialogue', async (request, reply) => {
    const articleId = ((request.params as { articleId?: string }).articleId ?? '').trim();
    if (!articleId) return reply.code(400).send({ error: 'articleId is required.' });
    const body = (request.body ?? {}) as { message?: string; userId?: string; sessionId?: string; context?: DialogueContextRequest; pendingProposalId?: string };
    const message = body.message?.trim();
    if (!message) return reply.code(400).send({ error: 'Dialogue message is required.' });
    const userId = readUserId(body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    if (body.pendingProposalId && isApplyConfirmation(message)) return applyRevisionProposal(container, body.pendingProposalId, userId, body.sessionId);
    const context = resolveDialogueContext(access.article, body.context);
    if (!context.ok) return reply.code(context.statusCode).send({ error: context.error });
    const result = await container.runtime.invokeSkill<DialogueCoordinatorInput, DialogueCoordinatorOutput>(
      'dialogue-coordinator',
      {
        articleId: access.article.id,
        message,
        context: context.value.context,
        taskCard: access.article.taskCard,
        outline: access.article.outline,
        selectedOutlineItem: context.value.selectedOutlineItem,
        selectedBlock: context.value.selectedBlock,
      },
      { userId, sessionId: body.sessionId, articleId: access.article.id },
    );
    if (result.mode !== 'proposal') return { mode: result.mode, message: result.message };
    const proposal = await container.stores.revisionProposalStore.createProposal({
      articleId: access.article.id,
      userId,
      contextKind: context.value.context.kind,
      summary: result.summary ?? result.message,
      message: result.message,
      operations: result.operations,
      warnings: result.warnings,
    });
    return { mode: 'proposal', message: result.message, proposal };
  });
  app.get('/api/articles/:articleId/dialogue/proposals', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const query = request.query as { userId?: string };
    const userId = readUserId(query.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    return container.stores.revisionProposalStore.listPendingProposals(articleId, userId);
  });
  app.post('/api/articles/:articleId/dialogue/:proposalId/apply', async (request, reply) => {
    const { articleId, proposalId } = request.params as { articleId: string; proposalId: string };
    const body = (request.body ?? {}) as { userId?: string; sessionId?: string };
    const userId = readUserId(body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const proposal = await container.stores.revisionProposalStore.getProposal(proposalId);
    if (!proposal || proposal.articleId !== articleId) return reply.code(404).send({ error: 'Revision proposal not found.' });
    return applyRevisionProposal(container, proposal.id, userId, body.sessionId);
  });
  app.post('/api/articles/:articleId/dialogue/:proposalId/dismiss', async (request, reply) => {
    const { articleId, proposalId } = request.params as { articleId: string; proposalId: string };
    const body = (request.body ?? {}) as { userId?: string };
    const userId = readUserId(body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const proposal = await container.stores.revisionProposalStore.getProposal(proposalId);
    if (!proposal || proposal.articleId !== articleId) return reply.code(404).send({ error: 'Revision proposal not found.' });
    if (proposal.userId !== userId) return reply.code(403).send({ error: 'Revision proposal belongs to another user.' });
    return container.stores.revisionProposalStore.updateProposal({ ...proposal, status: 'dismissed' });
  });
  app.post('/api/articles/:articleId/outline/confirm', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const body = (request.body ?? {}) as { userId?: string; sessionId?: string };
    const userId = readUserId(body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const article = access.article;
    if (!article.outline.length) return reply.code(400).send({ error: 'Article has no outline to confirm.' });
    if (article.outline.some((item) => item.status !== 'confirmed')) {
      article.outline = article.outline.map((item) => ({ ...item, status: 'confirmed' as const }));
      await container.stores.artifactStore.updateArticle(article);
      await container.stores.artifactStore.commitVersion(article.id, '确认大纲', 'user');
      await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, reason: 'outline-confirmed', userId }, createdAt: nowIso() });
    }
    if (body.sessionId) await container.stores.sessionStore.updateSession(body.sessionId, { currentArticleId: article.id, currentWorkspaceId: article.workspaceId });
    const updatedArticle = await container.stores.artifactStore.getArticle(article.id);
    return updatedArticle ? withWritingStandardSummary(updatedArticle) : updatedArticle;
  });
  app.post('/api/knowledge/search', async (request) => { const body = request.body as { query: string; limit?: number; themeTags?: string[] }; return container.stores.knowledgeStore.search(body.query, { limit: body.limit, themeTags: body.themeTags }); });

  app.post('/api/workflows/task-card/start', async (request, reply) => {
    const body = request.body as { rawRequirement: string; userId?: string; sessionId?: string; workspaceId?: string; domainProfile?: DomainProfileSelectionRequest; writingStandard?: WritingStandardSelectionRequest };
    const userId = readUserId(body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const workspaceId = body.workspaceId?.trim() || (await ensureDefaultWorkspace(container, userId)).id;
    const workspace = await requireWorkspaceAccess(container, userId, workspaceId);
    if (!workspace) return reply.code(403).send({ error: 'Workspace access required.' });
    let domainContext: ReturnType<typeof resolveDomainProfileSelection>;
    let writingStandard: ReturnType<typeof resolveWritingStandardSelection>;
    try {
      domainContext = resolveDomainProfileSelection(body.domainProfile);
      writingStandard = resolveWritingStandardSelection(body.writingStandard);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    const run = await container.engine.startWorkflow('task-card-workflow', { rawRequirement: body.rawRequirement, userId, sessionId: body.sessionId, workspaceId, domainContext, writingStandard }, { userId, sessionId: body.sessionId, workspaceId });
    return enrichRun(container, run.id);
  });
  app.post('/api/workflows/outline/start', async (request, reply) => { const body = request.body as { articleId: string; userId?: string; sessionId?: string }; const userId = readUserId(body.userId); if (!userId) return reply.code(400).send({ error: 'userId is required.' }); const access = await requireArticleAccess(container, userId, body.articleId); if (!access.ok) return reply.code(access.statusCode).send({ error: access.error }); if (body.sessionId) await container.stores.sessionStore.updateSession(body.sessionId, { currentArticleId: body.articleId, currentWorkspaceId: access.article.workspaceId }); const run = await container.engine.startWorkflow('outline-workflow', { articleId: body.articleId }, { userId, sessionId: body.sessionId, articleId: body.articleId, workspaceId: access.article.workspaceId }); return enrichRun(container, run.id); });
  app.post('/api/workflows/section/start', async (request, reply) => { const body = request.body as { articleId: string; sectionId: string; userId?: string; sessionId?: string }; const userId = readUserId(body.userId); if (!userId) return reply.code(400).send({ error: 'userId is required.' }); const access = await requireArticleAccess(container, userId, body.articleId); if (!access.ok) return reply.code(access.statusCode).send({ error: access.error }); const run = await container.engine.startWorkflow('section-writing-workflow', { articleId: body.articleId, sectionId: body.sectionId }, { userId, sessionId: body.sessionId, articleId: body.articleId, workspaceId: access.article.workspaceId }); return enrichRun(container, run.id); });
  app.post('/api/workflows/patch/start', async (request, reply) => { const body = request.body as { articleId: string; blockId: string; instruction: string; userId?: string; sessionId?: string }; const userId = readUserId(body.userId); if (!userId) return reply.code(400).send({ error: 'userId is required.' }); const access = await requireArticleAccess(container, userId, body.articleId); if (!access.ok) return reply.code(access.statusCode).send({ error: access.error }); if (body.sessionId) await container.stores.sessionStore.updateSession(body.sessionId, { currentArticleId: body.articleId, currentWorkspaceId: access.article.workspaceId, currentBlockId: body.blockId }); const run = await container.engine.startWorkflow('patch-workflow', { articleId: body.articleId, blockId: body.blockId, instruction: body.instruction }, { userId, sessionId: body.sessionId, articleId: body.articleId, workspaceId: access.article.workspaceId }); return enrichRun(container, run.id); });
  app.post('/api/workflows/:runId/resume', async (request) => { const { runId } = request.params as { runId: string }; await container.engine.resumeWorkflow(runId, request.body ?? {}); return enrichRun(container, runId); });
  app.post('/api/workflows/:runId/cancel', async (request) => { const { runId } = request.params as { runId: string }; await container.engine.cancelWorkflow(runId); return enrichRun(container, runId); });
  app.get('/api/runs/:runId', async (request, reply) => { const { runId } = request.params as { runId: string }; const run = await container.engine.getRun(runId); if (!run) return reply.code(404).send({ error: 'Run not found' }); return enrichRun(container, runId); });
  app.get('/api/runs/:runId/events', async (request) => { const { runId } = request.params as { runId: string }; return container.stores.eventTraceStore.listByRun(runId); });
  app.get('/api/runs/:runId/stream', async (request, reply) => { const { runId } = request.params as { runId: string }; await openSseStream(container, reply, { runId }); });
  app.get('/api/events/stream', async (request, reply) => { const query = request.query as { runId?: string; userId?: string }; await openSseStream(container, reply, { runId: query.runId, userId: query.userId }); });
  app.get('/api/events/ws', { websocket: true }, (socket, request) => { const query = request.query as { runId?: string; userId?: string }; let unsubscribe: Unsubscribe | undefined; void Promise.resolve(container.eventBus.subscribe({ runId: query.runId, userId: query.userId }, (event) => socket.send(JSON.stringify({ type: 'event', event })))).then((value) => { unsubscribe = value; }); socket.send(JSON.stringify({ type: 'connected' })); socket.on('close', () => unsubscribe?.()); });
  return app;
}

type DialogueContextRequest = { kind?: string; outlineItemId?: string; blockId?: string };

type ResolvedDialogueContext = {
  context: DialogueCoordinatorInput['context'];
  selectedOutlineItem?: OutlineItem;
  selectedBlock?: ArticleBlock;
};

function resolveDialogueContext(article: ArticleArtifact, request?: DialogueContextRequest): { ok: true; value: ResolvedDialogueContext } | { ok: false; statusCode: number; error: string } {
  const kind = normalizeDialogueKind(request?.kind);
  if (kind === 'outline-item') {
    const outlineItemId = request?.outlineItemId?.trim();
    if (!outlineItemId) return { ok: false, statusCode: 400, error: 'outlineItemId is required for outline item dialogue.' };
    const selectedOutlineItem = article.outline.find((item) => item.id === outlineItemId);
    if (!selectedOutlineItem) return { ok: false, statusCode: 404, error: 'Outline section not found.' };
    return {
      ok: true,
      value: {
        context: { kind, title: selectedOutlineItem.title, detail: selectedOutlineItem.goal, outlineItemId },
        selectedOutlineItem,
      },
    };
  }
  if (kind === 'block') {
    const blockId = request?.blockId?.trim();
    if (!blockId) return { ok: false, statusCode: 400, error: 'blockId is required for block dialogue.' };
    const selectedBlock = article.blocks.find((block) => block.id === blockId);
    if (!selectedBlock) return { ok: false, statusCode: 404, error: 'Article block not found.' };
    return {
      ok: true,
      value: {
        context: { kind, title: selectedBlock.title || selectedBlock.id, detail: selectedBlock.text.slice(0, 180), blockId },
        selectedBlock,
      },
    };
  }
  if (kind === 'outline') {
    return {
      ok: true,
      value: {
        context: {
          kind,
          title: '大纲整体',
          detail: article.outline.map((item) => `${item.order}. ${item.title}`).join('\n'),
        },
      },
    };
  }
  return {
    ok: true,
    value: {
      context: {
        kind: 'task-card',
        title: article.taskCard?.topic ?? article.title,
        detail: article.taskCard?.writingGoal,
      },
    },
  };
}

function normalizeDialogueKind(value: string | undefined): DialogueContextKind {
  if (value === 'outline' || value === 'outline-item' || value === 'block' || value === 'task-card') return value;
  if (value === 'paragraph') return 'block';
  return 'task-card';
}

function isApplyConfirmation(message: string): boolean {
  return /^(确认|应用|执行|就这样|可以|同意|按这个改|直接改|改吧|ok|OK)$/i.test(message.trim());
}

async function applyRevisionProposal(container: AppContainer, proposalId: string, userId: string, sessionId?: string) {
  const proposal = await container.stores.revisionProposalStore.getProposal(proposalId);
  if (!proposal) throw new Error('Revision proposal not found.');
  if (proposal.userId !== userId) throw new Error('Revision proposal belongs to another user.');
  if (proposal.status !== 'pending') throw new Error(`Revision proposal is already ${proposal.status}.`);
  const access = await requireArticleAccess(container, userId, proposal.articleId);
  if (!access.ok) throw new Error(access.error);
  let article = access.article;
  let runPayload: Awaited<ReturnType<typeof enrichRun>> | undefined;
  for (const operation of proposal.operations) {
    const result = await applyRevisionOperation(container, article, operation, userId, sessionId);
    if (result.runPayload) runPayload = result.runPayload;
    article = result.article;
  }
  const applied = await container.stores.revisionProposalStore.updateProposal({ ...proposal, status: 'applied' });
  const articlePayload = await container.stores.artifactStore.getArticle(article.id);
  return {
    mode: 'applied',
    message: runPayload ? '已进入修改预览流程，确认后才会写入正文。' : '修改已应用。',
    proposal: applied,
    article: articlePayload ? withWritingStandardSummary(articlePayload) : articlePayload,
    ...(runPayload ?? {}),
  };
}

async function applyRevisionOperation(container: AppContainer, article: ArticleArtifact, operation: RevisionOperation, userId: string, sessionId?: string): Promise<{ article: ArticleArtifact; runPayload?: Awaited<ReturnType<typeof enrichRun>> }> {
  if (operation.type === 'revise-task-card') {
    if (!article.taskCard) throw new Error('Article has no task card to revise.');
    const result = await container.runtime.invokeSkill<{ articleId: string; instruction: string; currentTaskCard: WritingTaskCard }, TaskCardReviserOutput>(
      'task-card-reviser',
      { articleId: article.id, instruction: operation.instruction, currentTaskCard: article.taskCard },
      { userId, sessionId, articleId: article.id },
    );
    article.taskCard = result.taskCard;
    article.title = result.taskCard.topic;
    const updated = await container.stores.artifactStore.updateArticle(article);
    await container.stores.artifactStore.commitVersion(article.id, `修订任务卡：${result.summary.slice(0, 80)}`, 'user');
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, reason: 'task-card-revised', changedFields: result.changedFields, userId }, createdAt: nowIso() });
    return { article: (await container.stores.artifactStore.getArticle(updated.id)) ?? updated };
  }
  if (operation.type === 'revise-outline-item') {
    const existing = article.outline.find((item) => item.id === operation.outlineItemId);
    if (!existing) throw new Error(`Outline section not found: ${operation.outlineItemId}`);
    const result = await container.runtime.invokeSkill<{ articleId: string; instruction: string; currentOutlineItem: typeof existing; taskCard?: WritingTaskCard; articleOutline: typeof article.outline }, OutlineItemReviserOutput>(
      'outline-item-reviser',
      { articleId: article.id, instruction: operation.instruction, currentOutlineItem: existing, taskCard: article.taskCard, articleOutline: article.outline },
      { userId, sessionId, articleId: article.id },
    );
    article.outline = article.outline.map((item) => item.id === operation.outlineItemId ? result.outlineItem : item);
    const updated = await container.stores.artifactStore.updateArticle(article);
    await container.stores.artifactStore.commitVersion(article.id, `修订大纲章节：${result.summary.slice(0, 80)}`, 'user');
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, sectionId: operation.outlineItemId, reason: 'outline-section-revised', changedFields: result.changedFields, userId }, createdAt: nowIso() });
    return { article: (await container.stores.artifactStore.getArticle(updated.id)) ?? updated };
  }
  if (operation.type === 'revise-outline') {
    const writtenSectionIds = [...new Set(article.blocks.map((block) => block.sectionId).filter((id): id is string => Boolean(id)))];
    const result = await container.runtime.invokeSkill<{ articleId: string; instruction: string; taskCard?: WritingTaskCard; currentOutline: OutlineItem[]; writtenSectionIds: string[] }, OutlineReviserOutput>(
      'outline-reviser',
      { articleId: article.id, instruction: operation.instruction, taskCard: article.taskCard, currentOutline: article.outline, writtenSectionIds },
      { userId, sessionId, articleId: article.id },
    );
    const nextIds = new Set(result.outline.map((item) => item.id));
    const removedWrittenTitles = article.outline.filter((item) => !nextIds.has(item.id) && writtenSectionIds.includes(item.id)).map((item) => item.title);
    if (removedWrittenTitles.length) throw new Error(`Cannot remove outline sections with generated text: ${removedWrittenTitles.join(', ')}`);
    article.outline = result.outline;
    const updated = await container.stores.artifactStore.updateArticle(article);
    await container.stores.artifactStore.commitVersion(article.id, `修订大纲：${result.summary.slice(0, 80)}`, 'user');
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, reason: 'outline-revised', changedFields: result.changedFields, warnings: result.warnings, userId }, createdAt: nowIso() });
    return { article: (await container.stores.artifactStore.getArticle(updated.id)) ?? updated };
  }
  const run = await container.engine.startWorkflow('patch-workflow', { articleId: article.id, blockId: operation.blockId, instruction: operation.instruction }, { userId, sessionId, articleId: article.id, workspaceId: article.workspaceId });
  if (sessionId) await container.stores.sessionStore.updateSession(sessionId, { currentArticleId: article.id, currentWorkspaceId: article.workspaceId, currentBlockId: operation.blockId });
  return { article, runPayload: await enrichRun(container, run.id) };
}

function defaultWorkspaceId(userId: string): string {
  return `wsp_default_${userId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function readUserId(value: string | undefined): string | undefined {
  const userId = value?.trim();
  return userId || undefined;
}

async function ensureDefaultWorkspace(container: AppContainer, userId: string): Promise<WritingWorkspace> {
  const id = defaultWorkspaceId(userId);
  const existing = await container.stores.workspaceStore.getWorkspace(id);
  if (existing) return existing;
  return container.stores.workspaceStore.createWorkspace({ id, userId, name: '默认工作台', isDefault: true });
}

async function requireWorkspaceAccess(container: AppContainer, userId: string, workspaceId: string): Promise<WritingWorkspace | undefined> {
  const workspace = await container.stores.workspaceStore.getWorkspace(workspaceId);
  if (!workspace) return undefined;
  return workspace.userId === userId || workspace.memberUserIds.includes(userId) ? workspace : undefined;
}

async function canAccessArticle(container: AppContainer, userId: string, article: ArticleArtifact): Promise<boolean> {
  return Boolean(await requireWorkspaceAccess(container, userId, article.workspaceId));
}

async function requireArticleAccess(container: AppContainer, userId: string, articleId: string): Promise<{ ok: true; article: ArticleArtifact } | { ok: false; statusCode: number; error: string }> {
  const article = await container.stores.artifactStore.getArticle(articleId);
  if (!article) return { ok: false, statusCode: 404, error: 'Article not found' };
  if (!(await canAccessArticle(container, userId, article))) return { ok: false, statusCode: 403, error: 'Workspace access required.' };
  return { ok: true, article };
}

function sortWorkspaces(workspaces: WritingWorkspace[]): WritingWorkspace[] {
  return workspaces.slice().sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.updatedAt.localeCompare(a.updatedAt));
}

function articleSummary(article: ArticleArtifact) {
  return {
    id: article.id,
    workspaceId: article.workspaceId,
    title: article.title,
    taskStatus: article.taskCard?.status,
    outlineCount: article.outline.length,
    blockCount: article.blocks.length,
    updatedAt: article.updatedAt,
    deletedAt: article.deletedAt,
  };
}

function withWritingStandardSummary(article: ArticleArtifact): ArticleArtifact {
  const topRules = article.taskCard?.topRules;
  if (!article.taskCard || !topRules || topRules.summary?.trim()) return article;
  const summary = getWritingStandardDisplaySummary(topRules.languageEra);
  if (!summary) return article;
  return {
    ...article,
    taskCard: {
      ...article.taskCard,
      topRules: { ...topRules, summary },
    },
  };
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
  return { run, article: article ? withWritingStandardSummary(article) : article, events };
}
