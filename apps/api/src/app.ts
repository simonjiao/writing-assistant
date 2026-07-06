import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { FastifyReply } from 'fastify';
import { AgentEvent, ArticleArtifact, ArticleBlock, DialogueContextKind, DialogueMessage, EventSubscriptionFilter, KnowledgeItem, KnowledgeSearchOptions, newId, nowIso, OutlineItem, RevisionOperation, RevisionProposal, Unsubscribe, WritingTaskCard, WritingWorkspace } from '@wa/core';
import type { DialogueCoordinatorInput, DialogueCoordinatorOutput, DialogueRouterInput, DialogueRouterOutput, OutlineItemReviserOutput, OutlineReviserOutput, TaskCardReviserOutput } from '@wa/skills';
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
    const invalidation = clearDownstreamForTaskCardChange(article);
    article.taskCard = result.taskCard;
    article.title = result.taskCard.topic;
    const updated = await container.stores.artifactStore.updateArticle(article);
    const reason = invalidation.outlineCount || invalidation.blockCount ? `修订任务卡并清空下游内容：${result.summary.slice(0, 80)}` : `修订任务卡：${result.summary.slice(0, 80)}`;
    await container.stores.artifactStore.commitVersion(article.id, reason, 'user');
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, reason: 'task-card-revised', changedFields: result.changedFields, invalidated: invalidation, userId }, createdAt: nowIso() });
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
    const invalidation = clearBlocksForOutlineSections(article, [sectionId]);
    article.outline = article.outline.map((item) => item.id === sectionId ? { ...item, title, goal, status: item.status === 'written' ? 'confirmed' : item.status } : item);
    const updated = await container.stores.artifactStore.updateArticle(article);
    await container.stores.artifactStore.commitVersion(article.id, invalidation.blockCount ? `编辑大纲章节并清空本节正文：${title}` : `编辑大纲章节：${title}`, 'user');
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, sectionId, reason: 'outline-section-edited', invalidated: invalidation, userId }, createdAt: nowIso() });
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
    const invalidation = clearBlocksForOutlineSections(article, [sectionId]);
    const revisedItem = { ...result.outlineItem, status: result.outlineItem.status === 'written' ? 'confirmed' as const : result.outlineItem.status };
    article.outline = article.outline.map((item) => item.id === sectionId ? revisedItem : item);
    const updated = await container.stores.artifactStore.updateArticle(article);
    const reason = invalidation.blockCount ? `修订大纲章节并清空本节正文：${result.summary.slice(0, 80)}` : `修订大纲章节：${result.summary.slice(0, 80)}`;
    await container.stores.artifactStore.commitVersion(article.id, reason, 'user');
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, sectionId, reason: 'outline-section-revised', changedFields: result.changedFields, invalidated: invalidation, userId }, createdAt: nowIso() });
    const updatedArticle = await container.stores.artifactStore.getArticle(updated.id);
    return { article: updatedArticle ? withWritingStandardSummary(updatedArticle) : updatedArticle, outlineItem: revisedItem, summary: result.summary, changedFields: result.changedFields };
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
    const pendingProposal = body.pendingProposalId ? await container.stores.revisionProposalStore.getProposal(body.pendingProposalId) : undefined;
    if (body.pendingProposalId && (!pendingProposal || pendingProposal.articleId !== access.article.id)) return reply.code(404).send({ error: 'Revision proposal not found.' });
    if (pendingProposal && pendingProposal.userId !== userId) return reply.code(403).send({ error: 'Revision proposal belongs to another user.' });
    if (pendingProposal && pendingProposal.status !== 'pending') return reply.code(400).send({ error: `Revision proposal is already ${pendingProposal.status}.` });
    let route = routeDialogueMessage(message, pendingProposal);
    if (pendingProposal && route === 'apply') {
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: pendingProposal.contextKind, role: 'user', content: message, proposalId: pendingProposal.id });
      const applied = await applyRevisionProposal(container, pendingProposal.id, userId, body.sessionId);
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: pendingProposal.contextKind, role: 'assistant', content: applied.message, proposalId: pendingProposal.id });
      return { ...applied, messages: await listDialogueMessages(container, access.article.id, userId) };
    }
    if (pendingProposal && route === 'dismiss') {
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: pendingProposal.contextKind, role: 'user', content: message, proposalId: pendingProposal.id });
      const dismissed = await container.stores.revisionProposalStore.updateProposal({ ...pendingProposal, status: 'dismissed' });
      const assistantMessage = '已取消这次修改方案。';
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: pendingProposal.contextKind, role: 'assistant', content: assistantMessage, proposalId: pendingProposal.id });
      return { mode: 'answer', message: assistantMessage, proposal: dismissed, messages: await listDialogueMessages(container, access.article.id, userId) };
    }
    const context = resolveDialogueContext(access.article, body.context);
    if (!context.ok) return reply.code(context.statusCode).send({ error: context.error });
    if (route === 'clarify') route = await refineDialogueRoute(container, access.article, userId, body.sessionId, message, context.value.context, Boolean(pendingProposal));
    await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'user', content: message, proposalId: pendingProposal?.id });
    const conversation = await listDialogueMessages(container, access.article.id, userId, 12);
    if (route === 'answer' || route === 'clarify' || route === 'discuss') {
      const assistantMessage = localDialogueReply(route, context.value.context, pendingProposal);
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'assistant', content: assistantMessage, proposalId: pendingProposal?.id });
      return { mode: route, message: assistantMessage, messages: await listDialogueMessages(container, access.article.id, userId) };
    }
    if (route === 'needs-rag') {
      const assistantMessage = await answerWithKnowledge(container, access.article, context.value.context, message);
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'assistant', content: assistantMessage, proposalId: pendingProposal?.id });
      return { mode: 'answer', message: assistantMessage, messages: await listDialogueMessages(container, access.article.id, userId) };
    }
    const result = await container.runtime.invokeSkill<DialogueCoordinatorInput, DialogueCoordinatorOutput>(
      'dialogue-coordinator',
      {
        articleId: access.article.id,
        message,
        skipKnowledge: true,
        conversation: conversation.map((item) => ({ role: item.role, content: item.content, proposalId: item.proposalId, createdAt: item.createdAt })),
        pendingProposal: pendingProposal ? proposalForDialogue(pendingProposal) : undefined,
        context: context.value.context,
        taskCard: access.article.taskCard,
        outline: access.article.outline,
        selectedOutlineItem: context.value.selectedOutlineItem,
        selectedBlock: context.value.selectedBlock,
      },
      { userId, sessionId: body.sessionId, articleId: access.article.id },
    );
    if (result.mode !== 'proposal') {
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'assistant', content: result.message, proposalId: pendingProposal?.id });
      return { mode: result.mode, message: result.message, messages: await listDialogueMessages(container, access.article.id, userId) };
    }
    if (pendingProposal) await container.stores.revisionProposalStore.updateProposal({ ...pendingProposal, status: 'dismissed' });
    const proposal = await container.stores.revisionProposalStore.createProposal({
      articleId: access.article.id,
      userId,
      contextKind: context.value.context.kind,
      summary: result.summary ?? result.message,
      message: result.message,
      operations: result.operations,
      warnings: result.warnings,
    });
    await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'assistant', content: result.message, proposalId: proposal.id });
    return { mode: 'proposal', message: result.message, proposal, messages: await listDialogueMessages(container, access.article.id, userId) };
  });
  app.get('/api/articles/:articleId/dialogue/messages', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const query = request.query as { userId?: string; limit?: string };
    const userId = readUserId(query.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;
    return listDialogueMessages(container, articleId, userId, Number.isFinite(limit) ? limit : undefined);
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
    const applied = await applyRevisionProposal(container, proposal.id, userId, body.sessionId);
    await appendDialogueMessage(container, { articleId, userId, contextKind: proposal.contextKind, role: 'assistant', content: applied.message, proposalId: proposal.id });
    return { ...applied, messages: await listDialogueMessages(container, articleId, userId) };
  });
  app.post('/api/articles/:articleId/dialogue/:proposalId/dismiss', async (request, reply) => {
    const { articleId, proposalId } = request.params as { articleId: string; proposalId: string };
    const body = (request.body ?? {}) as { userId?: string };
    const userId = readUserId(body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const proposal = await container.stores.revisionProposalStore.getProposal(proposalId);
    if (!proposal || proposal.articleId !== articleId) return reply.code(404).send({ error: 'Revision proposal not found.' });
    if (proposal.userId !== userId) return reply.code(403).send({ error: 'Revision proposal belongs to another user.' });
    const dismissed = await container.stores.revisionProposalStore.updateProposal({ ...proposal, status: 'dismissed' });
    await appendDialogueMessage(container, { articleId, userId, contextKind: proposal.contextKind, role: 'assistant', content: '已取消这次修改提案。', proposalId: proposal.id });
    return dismissed;
  });
  app.post('/api/articles/:articleId/writing/start', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const body = (request.body ?? {}) as { userId?: string; sessionId?: string };
    const userId = readUserId(body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const article = access.article;
    if (!article.outline.length) return reply.code(400).send({ error: 'Article has no outline to start writing.' });
    if (article.outline.some((item) => item.status !== 'confirmed')) {
      article.outline = article.outline.map((item) => ({ ...item, status: 'confirmed' as const }));
      await container.stores.artifactStore.updateArticle(article);
      await container.stores.artifactStore.commitVersion(article.id, '开始写作', 'user');
      await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, reason: 'writing-started', userId }, createdAt: nowIso() });
    }
    if (body.sessionId) await container.stores.sessionStore.updateSession(body.sessionId, { currentArticleId: article.id, currentWorkspaceId: article.workspaceId });
    const updatedArticle = await container.stores.artifactStore.getArticle(article.id);
    return updatedArticle ? withWritingStandardSummary(updatedArticle) : updatedArticle;
  });
  app.post('/api/knowledge/search', async (request) => {
    const body = request.body as { query: string } & KnowledgeSearchOptions;
    return container.stores.knowledgeStore.search(body.query, {
      limit: body.limit,
      themeTags: body.themeTags,
      structuredTerms: body.structuredTerms,
      requiredEvidenceTypes: body.requiredEvidenceTypes,
      routes: body.routes,
      keywordQueries: body.keywordQueries,
      semanticQueries: body.semanticQueries,
      rerank: body.rerank,
    });
  });

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
  app.post('/api/workflows/outline/start', async (request, reply) => { const body = request.body as { articleId: string; userId?: string; sessionId?: string }; const userId = readUserId(body.userId); if (!userId) return reply.code(400).send({ error: 'userId is required.' }); const access = await requireArticleAccess(container, userId, body.articleId); if (!access.ok) return reply.code(access.statusCode).send({ error: access.error }); if (access.article.taskCard?.status !== 'confirmed') return reply.code(400).send({ error: 'Task card must be confirmed before outlining.' }); if (body.sessionId) await container.stores.sessionStore.updateSession(body.sessionId, { currentArticleId: body.articleId, currentWorkspaceId: access.article.workspaceId }); const run = await container.engine.startWorkflow('outline-workflow', { articleId: body.articleId }, { userId, sessionId: body.sessionId, articleId: body.articleId, workspaceId: access.article.workspaceId }); return enrichRun(container, run.id); });
  app.post('/api/workflows/section/start', async (request, reply) => { const body = request.body as { articleId: string; sectionId: string; userId?: string; sessionId?: string }; const userId = readUserId(body.userId); if (!userId) return reply.code(400).send({ error: 'userId is required.' }); const access = await requireArticleAccess(container, userId, body.articleId); if (!access.ok) return reply.code(access.statusCode).send({ error: access.error }); if (access.article.taskCard?.status !== 'confirmed') return reply.code(400).send({ error: 'Task card must be confirmed before writing.' }); const section = access.article.outline.find((item) => item.id === body.sectionId); if (!section) return reply.code(404).send({ error: 'Outline section not found.' }); if (section.status === 'draft') return reply.code(400).send({ error: 'Outline must be ready before writing.' }); const run = await container.engine.startWorkflow('section-writing-workflow', { articleId: body.articleId, sectionId: body.sectionId }, { userId, sessionId: body.sessionId, articleId: body.articleId, workspaceId: access.article.workspaceId }); return enrichRun(container, run.id); });
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
type DialogueRoute = 'apply' | 'dismiss' | 'answer' | 'clarify' | 'discuss' | 'needs-rag' | 'propose';

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

function routeDialogueMessage(message: string, pendingProposal?: RevisionProposal): DialogueRoute {
  if (pendingProposal && isApplyConfirmation(message)) return 'apply';
  if (pendingProposal && isDismissal(message)) return 'dismiss';
  if (pendingProposal && isProposalRefreshRequest(message)) return 'propose';
  if (needsKnowledgeSearch(message)) return 'needs-rag';
  if (isQuestionLike(message)) return 'answer';
  if (pendingProposal) return 'discuss';
  if (isModificationIntent(message)) return 'propose';
  return 'clarify';
}

function localDialogueReply(route: DialogueRoute, context: DialogueCoordinatorInput['context'], pendingProposal?: RevisionProposal): string {
  if (route === 'answer') return `这是关于「${context.title}」的只读说明，不会修改当前任务。若要改动，请直接说明要改成什么。`;
  if (route === 'discuss' && pendingProposal) return '已记录这条意见，暂不刷新当前修改方案。需要合并这些意见时，可以点击“更新方案”，或直接说“按以上意见更新方案”。';
  return `我还不能判断要修改「${context.title}」的哪一部分。请说明要修改、添加、删除，还是只是讨论想法。`;
}

async function answerWithKnowledge(container: AppContainer, article: ArticleArtifact, context: DialogueCoordinatorInput['context'], message: string): Promise<string> {
  const spec = knowledgeSearchSpec(article, message);
  const items = await container.stores.knowledgeStore.search(spec.query, spec.options);
  if (!items.length) return '没有查到足够相关的资料。可以换一种问法，或明确要查的原文、脂批、章节或人物。';
  const lines = items.map((item, index) => `${index + 1}. ${knowledgeItemLabel(item)}`);
  return [`查到 ${items.length} 条相关资料，可以作为后续修改或写作依据：`, ...lines, '如果要把这些资料合并进当前修改方案，请说“按这些资料更新方案”。'].join('\n');
}

function knowledgeSearchSpec(article: ArticleArtifact, message: string): { query: string; options: KnowledgeSearchOptions } {
  if (isCommentaryKnowledgeRequest(message)) {
    const terms = extractKnowledgeTerms(message, article);
    const query = [...terms, '脂批', '批语'].join(' ').trim() || message;
    return {
      query,
      options: {
        limit: 4,
        structuredTerms: terms,
        keywordQueries: [query],
        semanticQueries: [`脂批中关于${terms.join('、') || '当前对象'}的批语`],
        requiredEvidenceTypes: ['commentary'],
        routes: ['bm25', 'vector', 'commentary'],
      },
    };
  }
  return { query: message, options: { limit: 4 } };
}

function isCommentaryKnowledgeRequest(message: string): boolean {
  return /(脂批|批语|批注|评语)/.test(message);
}

function extractKnowledgeTerms(message: string, article: ArticleArtifact): string[] {
  const cleaned = message.replace(/脂批|批语|批注|评语|有哪些|有哪|关于|查|检索|搜索|一下|请|资料|原文|出处|引用|证据|中|的|和|与|及|以及|第[一二三四五六七八九十百0-9]+回/g, ' ');
  const messageTerms = cleaned.split(/[\s，,。.!！?？、；;：:《》“”"']+/).map((item) => item.trim()).filter((item) => item.length >= 2 && item.length <= 12);
  const scopedTerms = article.taskCard?.scope.characters?.filter(Boolean) ?? [];
  const topicTerm = article.taskCard?.topic
    ?.replace(/人物文章|文章|介绍|综合|全面|关于|写一篇|赏析|分析|评论/g, '')
    .trim();
  return [...new Set([...messageTerms, ...scopedTerms, ...(topicTerm ? [topicTerm] : [])])].filter((item) => item.length >= 2 && item.length <= 12).slice(0, 4);
}

async function refineDialogueRoute(container: AppContainer, article: ArticleArtifact, userId: string, sessionId: string | undefined, message: string, context: DialogueCoordinatorInput['context'], hasPendingProposal: boolean): Promise<DialogueRoute> {
  const result = await container.runtime.invokeSkill<DialogueRouterInput, DialogueRouterOutput>(
    'dialogue-router',
    {
      message,
      skipKnowledge: true,
      hasPendingProposal,
      context: { kind: context.kind, title: context.title },
    },
    { userId, sessionId, articleId: article.id },
  );
  return result.route;
}

function knowledgeItemLabel(item: KnowledgeItem): string {
  const source = item.sourceRef ? `（${item.sourceRef}）` : '';
  const snippet = item.content ? `：${item.content.replace(/\s+/g, ' ').slice(0, 90)}` : '';
  return `${item.title}${source}${snippet}`;
}

async function appendDialogueMessage(container: AppContainer, input: Omit<DialogueMessage, 'id' | 'createdAt'>): Promise<DialogueMessage> {
  return container.stores.dialogueMessageStore.createMessage(input);
}

function listDialogueMessages(container: AppContainer, articleId: string, userId: string, limit = 24): Promise<DialogueMessage[]> {
  return container.stores.dialogueMessageStore.listMessages(articleId, userId, { limit });
}

function proposalForDialogue(proposal: RevisionProposal): DialogueCoordinatorInput['pendingProposal'] {
  return {
    id: proposal.id,
    summary: proposal.summary,
    message: proposal.message,
    operations: proposal.operations,
    warnings: proposal.warnings,
  };
}

function isApplyConfirmation(message: string): boolean {
  return /^(确认|应用|执行|就这样|可以|同意|按这个改|直接改|改吧|ok|OK)$/i.test(message.trim());
}

function isDismissal(message: string): boolean {
  return /^(取消|不用了|不要了|先不要|放弃|撤销|算了|忽略|取消方案)$/i.test(message.trim());
}

function isQuestionLike(message: string): boolean {
  return /[?？]|为什么|为何|解释|说明|怎么|是否|吗|是什么|什么意思/.test(message);
}

function needsKnowledgeSearch(message: string): boolean {
  const hasKnowledgeTarget = /(资料|文本|原文|出处|引用|脂批|批语|批注|评语|第[一二三四五六七八九十百0-9几哪]+回|哪[一几]回|证据|知识库|来源|根据文本)/.test(message);
  const hasExplicitSearchIntent = /(查|查找|检索|搜索|找|找出|列出|给出|有哪些|有哪|哪里|在哪|哪[一几]回|第几回|第[一二三四五六七八九十百0-9]+回)/.test(message);
  return hasKnowledgeTarget && hasExplicitSearchIntent;
}

function isProposalRefreshRequest(message: string): boolean {
  return /(更新|刷新|重新|重做|合并|吸收|按.*(意见|资料|这些).*(方案|改|调整)|方案.*(更新|调整|刷新|重做)|重新给.*方案|按以上意见|按这些资料)/.test(message);
}

function isModificationIntent(message: string): boolean {
  return /(改|修改|调整|删|删除|加|添加|新增|重写|扩写|压缩|不要|避免|改成|改为|换成|补充|合并|拆分|包含|纳入|加入|写进|放进|体现|保留|漏掉|遗漏|参考|使用|采用|沿用|突出|强调|弱化|去掉|移除)/.test(message);
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
    const invalidation = clearDownstreamForTaskCardChange(article);
    article.taskCard = result.taskCard;
    article.title = result.taskCard.topic;
    const updated = await container.stores.artifactStore.updateArticle(article);
    await container.stores.artifactStore.commitVersion(article.id, invalidation.outlineCount || invalidation.blockCount ? `修订任务卡并清空下游内容：${result.summary.slice(0, 80)}` : `修订任务卡：${result.summary.slice(0, 80)}`, 'user');
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, reason: 'task-card-revised', changedFields: result.changedFields, invalidated: invalidation, userId }, createdAt: nowIso() });
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
    const invalidation = clearBlocksForOutlineSections(article, [operation.outlineItemId]);
    const revisedItem = { ...result.outlineItem, status: result.outlineItem.status === 'written' ? 'confirmed' as const : result.outlineItem.status };
    article.outline = article.outline.map((item) => item.id === operation.outlineItemId ? revisedItem : item);
    const updated = await container.stores.artifactStore.updateArticle(article);
    await container.stores.artifactStore.commitVersion(article.id, invalidation.blockCount ? `修订大纲章节并清空本节正文：${result.summary.slice(0, 80)}` : `修订大纲章节：${result.summary.slice(0, 80)}`, 'user');
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, sectionId: operation.outlineItemId, reason: 'outline-section-revised', changedFields: result.changedFields, invalidated: invalidation, userId }, createdAt: nowIso() });
    return { article: (await container.stores.artifactStore.getArticle(updated.id)) ?? updated };
  }
  if (operation.type === 'revise-outline') {
    const writtenSectionIds = [...new Set(article.blocks.map((block) => block.sectionId).filter((id): id is string => Boolean(id)))];
    const result = await container.runtime.invokeSkill<{ articleId: string; instruction: string; taskCard?: WritingTaskCard; currentOutline: OutlineItem[]; writtenSectionIds: string[] }, OutlineReviserOutput>(
      'outline-reviser',
      { articleId: article.id, instruction: operation.instruction, taskCard: article.taskCard, currentOutline: article.outline, writtenSectionIds },
      { userId, sessionId, articleId: article.id },
    );
    const invalidation = clearAllBlocks(article);
    article.outline = result.outline.map((item) => ({ ...item, status: item.status === 'written' ? 'confirmed' as const : item.status }));
    const updated = await container.stores.artifactStore.updateArticle(article);
    await container.stores.artifactStore.commitVersion(article.id, invalidation.blockCount ? `修订大纲并清空正文：${result.summary.slice(0, 80)}` : `修订大纲：${result.summary.slice(0, 80)}`, 'user');
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, reason: 'outline-revised', changedFields: result.changedFields, warnings: result.warnings, invalidated: invalidation, userId }, createdAt: nowIso() });
    return { article: (await container.stores.artifactStore.getArticle(updated.id)) ?? updated };
  }
  const run = await container.engine.startWorkflow('patch-workflow', { articleId: article.id, blockId: operation.blockId, instruction: operation.instruction }, { userId, sessionId, articleId: article.id, workspaceId: article.workspaceId });
  if (sessionId) await container.stores.sessionStore.updateSession(sessionId, { currentArticleId: article.id, currentWorkspaceId: article.workspaceId, currentBlockId: operation.blockId });
  return { article, runPayload: await enrichRun(container, run.id) };
}

function defaultWorkspaceId(userId: string): string {
  return `wsp_default_${userId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function clearDownstreamForTaskCardChange(article: ArticleArtifact): { outlineCount: number; blockCount: number; citationCount: number; themeTagCount: number } {
  const invalidation = {
    outlineCount: article.outline.length,
    blockCount: article.blocks.length,
    citationCount: article.citations.length,
    themeTagCount: article.themeTags.length,
  };
  article.outline = [];
  article.blocks = [];
  article.citations = [];
  article.themeTags = [];
  return invalidation;
}

function clearAllBlocks(article: ArticleArtifact): { blockCount: number } {
  const invalidation = { blockCount: article.blocks.length };
  article.blocks = [];
  return invalidation;
}

function clearBlocksForOutlineSections(article: ArticleArtifact, sectionIds: string[]): { blockCount: number } {
  const targets = new Set(sectionIds);
  const blockCount = article.blocks.filter((block) => block.sectionId && targets.has(block.sectionId)).length;
  if (!blockCount) return { blockCount: 0 };
  article.blocks = article.blocks.filter((block) => !block.sectionId || !targets.has(block.sectionId));
  return { blockCount };
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
  const articleId = (run.state.draftArticle as { articleId?: string } | undefined)?.articleId ?? (run.state.finalizedTaskCard as { articleId?: string } | undefined)?.articleId ?? (run.state.outlineDraft as { articleId?: string } | undefined)?.articleId ?? (run.state.writingStarted as { articleId?: string } | undefined)?.articleId ?? (run.state.finalizedOutline as { articleId?: string } | undefined)?.articleId ?? (run.state.committedSection as { articleId?: string } | undefined)?.articleId ?? (run.state.appliedPatch as { articleId?: string } | undefined)?.articleId ?? (typeof run.metadata.articleId === 'string' ? run.metadata.articleId : undefined);
  const article = articleId ? await container.stores.artifactStore.getArticle(articleId) : undefined;
  const events = await container.stores.eventTraceStore.listByRun(run.id);
  return { run, article: article ? withWritingStandardSummary(article) : article, events };
}
