import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import { AgentEvent, ArticleArtifact, ArticleBlock, ArticleComment, DialogueContextKind, DialogueMessage, EventSubscriptionFilter, KnowledgeItem, KnowledgeSearchOptions, mergeDeep, newId, nowIso, OutlineItem, RevisionOperation, RevisionProposal, Unsubscribe, WorkflowRun, WRITING_AUTOPILOT_POLICY, WritingTaskCard, WritingWorkspace } from '@wa/core';
import { normalizeTaskCardPolicies } from '@wa/skills';
import type { ArticleCommentResolverInput, ArticleCommentResolverOutput, DialogueCoordinatorInput, DialogueCoordinatorOutput, DialogueRouterInput, DialogueRouterOutput, OutlineItemReviserOutput, OutlineReviserOutput, PatchEditorInput, PatchEditorOutput, TaskCardReviserOutput } from '@wa/skills';
import { AppConfig } from './config';
import { AppContainer } from './bootstrap';
import { addKnowledgeEvidenceToBrief, buildCompactDialogueConversation, compactDialogueBriefForPrompt, enqueueDialogueBriefUpdate, ensureDialogueBriefSettled, getDialogueBriefStatus, getOrCreateDialogueBrief } from './dialogueBrief';
import { DomainProfileSelectionRequest, getDomainProfileSummary, listDomainProfileSummaries, recommendDomainProfiles, resolveDomainProfileSelection } from './domainProfiles';
import { getWritingStandardDisplaySummary, getWritingStandardSummary, resolveWritingStandardSelection, WritingStandardSelectionRequest } from './writingStandards';
import { resolveUserContext } from './userContext';

export function createApp(config: AppConfig, container: AppContainer) {
  const app = Fastify({ logger: true });
  void app.register(cors, { origin: [config.webOrigin, 'http://localhost:5173', 'http://127.0.0.1:5173'] });
  void app.register(websocket);
  app.addHook('onClose', async () => { await container.close(); });

  app.get('/health', async () => ({ ok: true, service: 'writing-assistant-api', store: 'sqlite', workflowRuntime: 'pi-agent', ragProvider: config.ragProvider }));
  app.get('/api/workflows', async () => [{ id: WRITING_AUTOPILOT_POLICY.id, name: '写作自动流程', description: WRITING_AUTOPILOT_POLICY.goal }]);
  app.get('/api/skills', async () => container.skills.list());

  app.post('/api/sessions', async (request, reply) => {
    const body = request.body as { userId?: string };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const workspace = await ensureDefaultWorkspace(container, userId);
    const session = await container.stores.sessionStore.createSession(userId);
    return container.stores.sessionStore.updateSession(session.id, { currentWorkspaceId: workspace.id });
  });
  app.get('/api/workspaces', async (request, reply) => {
    const query = request.query as { userId?: string; includeDeleted?: string };
    const userId = readRequestUserId(request, query.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    await ensureDefaultWorkspace(container, userId);
    return sortWorkspaces(await container.stores.workspaceStore.listWorkspaces(userId, { includeDeleted: query.includeDeleted === 'true' }));
  });
  app.post('/api/workspaces', async (request, reply) => {
    const body = request.body as { userId?: string; name?: string; memberUserIds?: string[] };
    const userId = readRequestUserId(request, body.userId);
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
    const userId = readRequestUserId(request, body.userId);
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
    const userId = readRequestUserId(request, query.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const workspaceId = query.workspaceId?.trim() || (await ensureDefaultWorkspace(container, userId)).id;
    const workspace = await requireWorkspaceAccess(container, userId, workspaceId);
    if (!workspace) return reply.code(403).send({ error: 'Workspace access required.' });
    const articles = await container.stores.artifactStore.listArticles(workspace.id, { includeDeleted: query.includeDeleted === 'true' });
    return query.view === 'summary' ? articles.map(articleSummary) : articles.map(withWritingStandardSummary);
  });
  app.get('/api/articles/:articleId', async (request, reply) => { const { articleId } = request.params as { articleId: string }; const query = request.query as { userId?: string }; const userId = readRequestUserId(request, query.userId); if (!userId) return reply.code(400).send({ error: 'userId is required.' }); const access = await requireArticleAccess(container, userId, articleId); if (!access.ok) return reply.code(access.statusCode).send({ error: access.error }); return withWritingStandardSummary(access.article); });
  app.post('/api/articles/:articleId/comments', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const body = (request.body ?? {}) as { userId?: string; blockId?: string; selectedText?: string; comment?: string };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const blockId = body.blockId?.trim();
    const selectedText = body.selectedText?.trim();
    const note = body.comment?.trim();
    if (!blockId) return reply.code(400).send({ error: 'blockId is required.' });
    if (!selectedText) return reply.code(400).send({ error: 'selectedText is required.' });
    if (!note) return reply.code(400).send({ error: 'comment is required.' });
    const block = access.article.blocks.find((item) => item.id === blockId);
    if (!block) return reply.code(404).send({ error: 'Article block not found.' });
    const selectionStart = block.text.indexOf(selectedText);
    if (selectionStart < 0) return reply.code(400).send({ error: 'Selected text is no longer present in the block.' });
    const now = nowIso();
    const comment: ArticleComment = {
      id: newId('cmt'),
      articleId: access.article.id,
      blockId,
      selectedText,
      comment: note,
      selectionStart,
      selectionEnd: selectionStart + selectedText.length,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };
    access.article.comments = [...(access.article.comments ?? []), comment];
    const updated = await container.stores.artifactStore.updateArticle(access.article);
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: access.article.id, blockId, commentId: comment.id, reason: 'article-comment-created', userId }, createdAt: nowIso() });
    return withWritingStandardSummary(updated);
  });
  app.post('/api/articles/:articleId/comments/:commentId/replies', async (request, reply) => {
    const { articleId, commentId } = request.params as { articleId: string; commentId: string };
    const body = (request.body ?? {}) as { userId?: string; content?: string };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const content = body.content?.trim();
    if (!content) return reply.code(400).send({ error: 'content is required.' });
    const comment = (access.article.comments ?? []).find((item) => item.id === commentId);
    if (!comment) return reply.code(404).send({ error: 'Article comment not found.' });
    appendCommentReply(comment, 'user', content);
    updateComment(comment, { status: 'open', resolutionKind: undefined, resolvedAt: undefined });
    const updated = await container.stores.artifactStore.updateArticle(access.article);
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: access.article.id, blockId: comment.blockId, commentId: comment.id, reason: 'article-comment-replied', userId }, createdAt: nowIso() });
    return withWritingStandardSummary(updated);
  });
  app.delete('/api/articles/:articleId/comments/:commentId', async (request, reply) => {
    const { articleId, commentId } = request.params as { articleId: string; commentId: string };
    const body = (request.body ?? {}) as { userId?: string };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const comments = access.article.comments ?? [];
    const comment = comments.find((item) => item.id === commentId);
    if (!comment) return withWritingStandardSummary(access.article);
    if (!canDeleteUnprocessedComment(comment)) return reply.code(409).send({ error: 'Only unprocessed comments can be deleted.' });
    access.article.comments = comments.filter((item) => item.id !== commentId);
    const updated = await container.stores.artifactStore.updateArticle(access.article);
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: access.article.id, blockId: comment.blockId, commentId: comment.id, reason: 'article-comment-deleted', userId }, createdAt: nowIso() });
    return withWritingStandardSummary(updated);
  });
  app.delete('/api/articles/:articleId/comments/:commentId/replies/:replyId', async (request, reply) => {
    const { articleId, commentId, replyId } = request.params as { articleId: string; commentId: string; replyId: string };
    const body = (request.body ?? {}) as { userId?: string };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const comments = access.article.comments ?? [];
    const comment = comments.find((item) => item.id === commentId);
    if (!comment) return withWritingStandardSummary(access.article);
    const replies = comment.replies ?? [];
    const targetReply = replies.find((item) => item.id === replyId);
    if (!targetReply) return withWritingStandardSummary(access.article);
    if (!canDeleteUnprocessedReply(comment, targetReply)) return reply.code(409).send({ error: 'Only unprocessed user replies can be deleted.' });
    comment.replies = replies.filter((item) => item.id !== replyId);
    if (targetReply.role === 'assistant' && comment.response?.trim() === targetReply.content.trim()) {
      comment.response = undefined;
    }
    reconcileCommentAfterReplyDeletion(comment);
    const updated = await container.stores.artifactStore.updateArticle(access.article);
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: access.article.id, blockId: comment.blockId, commentId: comment.id, replyId: targetReply.id, reason: 'article-comment-reply-deleted', userId }, createdAt: nowIso() });
    return withWritingStandardSummary(updated);
  });
  app.post('/api/articles/:articleId/comments/process', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const body = (request.body ?? {}) as { userId?: string; sessionId?: string; commentIds?: string[] };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const result = await processArticleComments(container, access.article, userId, body.sessionId, body.commentIds);
    return { article: withWritingStandardSummary(result.article), results: result.results };
  });
  app.delete('/api/articles/:articleId', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const body = (request.body ?? {}) as { userId?: string };
    const userId = readRequestUserId(request, body.userId);
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
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    if (!(await canAccessArticle(container, userId, article))) return reply.code(403).send({ error: 'Workspace access required.' });
    if (!article.taskCard) return reply.code(400).send({ error: 'Article has no task card to revise.' });
    const result = await container.runtime.invokeSkill<{ articleId: string; instruction: string; currentTaskCard: WritingTaskCard; skipKnowledge: boolean }, TaskCardReviserOutput>(
      'task-card-reviser',
      { articleId: article.id, instruction, currentTaskCard: article.taskCard, skipKnowledge: true },
      { userId, sessionId: body.sessionId, articleId: article.id },
    );
    const invalidation = clearDownstreamForTaskCardChange(article);
    article.taskCard = normalizeTaskCardPolicies(result.taskCard, instruction).taskCard;
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
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const article = access.article;
    if (!article.taskCard) return reply.code(400).send({ error: 'Article has no task card to confirm.' });
    const taskCardForConfirm = article.taskCard.status === 'confirmed' ? article.taskCard : { ...article.taskCard, status: 'confirmed' as const, updatedAt: nowIso() };
    const normalized = normalizeTaskCardPolicies(taskCardForConfirm);
    if (article.taskCard.status !== 'confirmed' || normalized.changed) {
      article.taskCard = normalized.taskCard;
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
    const userId = readRequestUserId(request, body.userId);
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
    const userId = readRequestUserId(request, body.userId);
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
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    try {
      await ensureDialogueBriefSettled(container, access.article.id, userId);
    } catch (error) {
      return reply.code(409).send({ error: dialogueBriefBarrierError(error), briefStatus: await getDialogueBriefStatus(container, access.article.id, userId) });
    }
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
      const { proposal: dismissed, runPayload } = await dismissRevisionProposal(container, pendingProposal, userId);
      const assistantMessage = '已取消这次修改方案。';
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: pendingProposal.contextKind, role: 'assistant', content: assistantMessage, proposalId: pendingProposal.id });
      return { mode: 'answer', message: assistantMessage, proposal: dismissed, ...(runPayload ?? {}), messages: await listDialogueMessages(container, access.article.id, userId) };
    }
    const context = resolveDialogueContext(access.article, body.context);
    if (!context.ok) return reply.code(context.statusCode).send({ error: context.error });
    if (route === 'clarify') route = await refineDialogueRoute(container, access.article, userId, body.sessionId, message, context.value.context, Boolean(pendingProposal));
    const userMessage = await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'user', content: message, proposalId: pendingProposal?.id });
    const conversation = await listDialogueMessages(container, access.article.id, userId, 24);
    if (route === 'answer' || route === 'clarify' || route === 'discuss') {
      if (shouldUpdateDialogueBrief(route, message, pendingProposal)) {
        await enqueueDialogueBriefUpdate({ container, article: access.article, userId, sessionId: body.sessionId, message: userMessage, context: { kind: context.value.context.kind, title: context.value.context.title } });
      }
      const assistantMessage = localDialogueReply(route, context.value.context, access.article, message, pendingProposal);
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'assistant', content: assistantMessage, proposalId: pendingProposal?.id });
      return { mode: route, message: assistantMessage, messages: await listDialogueMessages(container, access.article.id, userId) };
    }
    if (route === 'needs-rag') {
      const knowledgeAnswer = await answerWithKnowledge(container, access.article, context.value.context, message);
      await addKnowledgeEvidenceToBrief({ container, articleId: access.article.id, userId, query: knowledgeAnswer.query, items: knowledgeAnswer.items });
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'assistant', content: knowledgeAnswer.message, proposalId: pendingProposal?.id });
      return { mode: 'answer', message: knowledgeAnswer.message, messages: await listDialogueMessages(container, access.article.id, userId) };
    }
    const conversationBrief = await getOrCreateDialogueBrief(container, access.article.id, userId);
    await enqueueDialogueBriefUpdate({ container, article: access.article, userId, sessionId: body.sessionId, message: userMessage, context: { kind: context.value.context.kind, title: context.value.context.title } });
    let result: DialogueCoordinatorOutput;
    try {
      result = await container.runtime.invokeSkill<DialogueCoordinatorInput, DialogueCoordinatorOutput>(
        'dialogue-coordinator',
        {
          articleId: access.article.id,
          message,
          skipKnowledge: true,
          conversation: buildCompactDialogueConversation(conversation),
          conversationBrief: compactDialogueBriefForPrompt(conversationBrief),
          pendingProposal: pendingProposal ? proposalForDialogue(pendingProposal) : undefined,
          context: context.value.context,
          taskCard: access.article.taskCard,
          outline: access.article.outline,
          selectedOutlineItem: context.value.selectedOutlineItem,
          selectedBlock: context.value.selectedBlock,
        },
        { userId, sessionId: body.sessionId, articleId: access.article.id },
      );
    } catch (error) {
      if (!isDialogueCoordinatorRecoverableFailure(error)) throw error;
      const assistantMessage = '这次修改范围较大，方案没有生成成功。请把要改的大纲项、要新增的情节或要删除的部分拆成更明确的一两条再发。';
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'assistant', content: assistantMessage, proposalId: pendingProposal?.id });
      return { mode: 'clarify', message: assistantMessage, messages: await listDialogueMessages(container, access.article.id, userId) };
    }
    if (result.mode !== 'proposal') {
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'assistant', content: result.message, proposalId: pendingProposal?.id });
      return { mode: result.mode, message: result.message, messages: await listDialogueMessages(container, access.article.id, userId) };
    }
    if (pendingProposal) await container.stores.revisionProposalStore.updateProposal({ ...pendingProposal, status: 'dismissed' });
    const proposal = await container.stores.revisionProposalStore.createProposal({
      articleId: access.article.id,
      userId,
      runId: pendingProposal?.runId,
      authorUserId: userId,
      baseRevision: access.article.revision,
      contextKind: context.value.context.kind,
      summary: result.summary ?? result.message,
      message: result.message,
      operations: result.operations,
      warnings: result.warnings,
    });
    if (pendingProposal?.runId) await syncWorkflowRunToRefreshedProposal(container, pendingProposal, proposal);
    await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'assistant', content: result.message, proposalId: proposal.id });
    return { mode: 'proposal', message: result.message, proposal, messages: await listDialogueMessages(container, access.article.id, userId) };
  });
  app.get('/api/articles/:articleId/dialogue/brief', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const query = request.query as { userId?: string };
    const userId = readRequestUserId(request, query.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    return getDialogueBriefStatus(container, articleId, userId);
  });
  app.get('/api/articles/:articleId/dialogue/messages', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const query = request.query as { userId?: string; limit?: string };
    const userId = readRequestUserId(request, query.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;
    return listDialogueMessages(container, articleId, userId, Number.isFinite(limit) ? limit : undefined);
  });
  app.get('/api/articles/:articleId/dialogue/proposals', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const query = request.query as { userId?: string };
    const userId = readRequestUserId(request, query.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    return container.stores.revisionProposalStore.listPendingProposals(articleId, userId);
  });
  app.post('/api/articles/:articleId/dialogue/:proposalId/apply', async (request, reply) => {
    const { articleId, proposalId } = request.params as { articleId: string; proposalId: string };
    const body = (request.body ?? {}) as { userId?: string; sessionId?: string };
    const userId = readRequestUserId(request, body.userId);
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
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const proposal = await container.stores.revisionProposalStore.getProposal(proposalId);
    if (!proposal || proposal.articleId !== articleId) return reply.code(404).send({ error: 'Revision proposal not found.' });
    if (proposal.userId !== userId) return reply.code(403).send({ error: 'Revision proposal belongs to another user.' });
    const { proposal: dismissed, runPayload } = await dismissRevisionProposal(container, proposal, userId);
    await appendDialogueMessage(container, { articleId, userId, contextKind: proposal.contextKind, role: 'assistant', content: '已取消这次修改提案。', proposalId: proposal.id });
    return { mode: 'answer', message: '已取消这次修改提案。', proposal: dismissed, ...(runPayload ?? {}), messages: await listDialogueMessages(container, articleId, userId) };
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

  app.post('/api/workflows/writing/start', async (request, reply) => {
    const body = (request.body ?? {}) as { userId?: string; sessionId?: string; workspaceId?: string; articleId?: string; message?: string; sectionId?: string; targetStage?: string; replaceExisting?: boolean; domainProfile?: DomainProfileSelectionRequest; writingStandard?: WritingStandardSelectionRequest };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const articleId = body.articleId?.trim();
    const articleAccess = articleId ? await requireArticleAccess(container, userId, articleId) : undefined;
    if (articleAccess && !articleAccess.ok) return reply.code(articleAccess.statusCode).send({ error: articleAccess.error });
    const workspaceId = articleAccess?.article.workspaceId ?? body.workspaceId?.trim() ?? (await ensureDefaultWorkspace(container, userId)).id;
    const workspace = await requireWorkspaceAccess(container, userId, workspaceId);
    if (!workspace) return reply.code(403).send({ error: 'Workspace access required.' });
    let domainContext: ReturnType<typeof resolveDomainProfileSelection> | undefined;
    let writingStandard: ReturnType<typeof resolveWritingStandardSelection> | undefined;
    try {
      domainContext = body.domainProfile ? resolveDomainProfileSelection(body.domainProfile) : undefined;
      writingStandard = body.writingStandard ? resolveWritingStandardSelection(body.writingStandard) : undefined;
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    const now = nowIso();
    const run: WorkflowRun = {
      id: newId('run'),
      workflowId: WRITING_AUTOPILOT_POLICY.id,
      status: 'running',
      input: { message: body.message?.trim() || undefined, articleId, workspaceId, sectionId: body.sectionId?.trim() || undefined, targetStage: normalizeWorkflowTargetStage(body.targetStage), replaceExisting: body.replaceExisting === true, domainContext, writingStandard },
      state: {},
      metadata: { userId, sessionId: body.sessionId, articleId, workspaceId, sectionId: body.sectionId?.trim() || undefined },
      createdAt: now,
      updatedAt: now,
    };
    await container.stores.stateStore.saveRun(run);
    await container.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'workflow.started', payload: { workflowId: run.workflowId, metadata: run.metadata, userId, executionMode: 'pi-agent' }, createdAt: nowIso() });
    if (body.sessionId) await container.stores.sessionStore.updateSession(body.sessionId, { currentArticleId: articleId, currentWorkspaceId: workspaceId, currentRunId: run.id });
    await container.piRunner.runUntilBlocked(run.id);
    return enrichRun(container, run.id);
  });

  app.get('/api/workflows/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = await container.stores.stateStore.getRun(runId);
    if (!run) return reply.code(404).send({ error: 'Run not found.' });
    return enrichRun(container, runId);
  });

  app.post('/api/workflows/:runId/human-gates/:gateId/resolve', async (request, reply) => {
    const { runId, gateId } = request.params as { runId: string; gateId: string };
    const body = (request.body ?? {}) as { userId?: string; decision?: string; payload?: Record<string, unknown> };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const run = await container.stores.stateStore.getRun(runId);
    if (!run) return reply.code(404).send({ error: 'Run not found.' });
    const gate = await container.stores.humanGateStore.getGate(gateId);
    if (!gate || gate.runId !== runId) return reply.code(404).send({ error: 'Human gate not found.' });
    if (gate.userId !== userId) return reply.code(403).send({ error: 'Human gate belongs to another user.' });
    if (gate.status !== 'pending') return reply.code(400).send({ error: `Human gate is already ${gate.status}.` });
    if (body.decision !== 'accept' && body.decision !== 'reject') return reply.code(400).send({ error: 'decision must be accept or reject.' });
    const resolvedGate = await container.stores.humanGateStore.updateGate({ ...gate, status: body.decision === 'accept' ? 'accepted' : 'rejected', resolvedByUserId: userId });
    await container.stores.eventTraceStore.append({ id: newId('evt'), runId, type: 'human_gate.resolved', payload: { userId, gateId, decision: body.decision, articleId: gate.articleId, actionType: gate.actionType }, createdAt: nowIso() });
    if (body.decision === 'reject') {
      await container.stores.stateStore.updateRun(runId, { status: 'waiting', waitingFor: { nodeId: 'human-gate', reason: '用户拒绝了当前确认项，需要新的指令。' }, state: { ...run.state, pendingHumanGateId: undefined, lastResolvedHumanGateId: resolvedGate.id }, updatedAt: nowIso() });
      return enrichRun(container, runId);
    }
    const gateResult = await applyAcceptedHumanGate(container, resolvedGate, body.payload ?? {});
    const statePatch = readObject(gateResult.statePatch) ?? {};
    await container.stores.stateStore.updateRun(runId, { status: 'running', waitingFor: undefined, state: { ...run.state, ...statePatch, pendingHumanGateId: undefined, lastResolvedHumanGateId: resolvedGate.id, humanGateResult: gateResult }, updatedAt: nowIso() });
    await container.piRunner.runUntilBlocked(runId);
    return enrichRun(container, runId);
  });

  app.post('/api/workflows/:runId/message', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body = (request.body ?? {}) as { userId?: string; message?: string; targetStage?: string; sectionId?: string; replaceExisting?: boolean };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const message = body.message?.trim();
    if (!message) return reply.code(400).send({ error: 'message is required.' });
    const run = await container.stores.stateStore.getRun(runId);
    if (!run) return reply.code(404).send({ error: 'Run not found.' });
    if (run.metadata.userId !== userId) return reply.code(403).send({ error: 'Run belongs to another user.' });
    if (run.status === 'completed' || run.status === 'cancelled') return reply.code(400).send({ error: `Run is already ${run.status}.` });
    const pendingGates = await container.stores.humanGateStore.listGates({ runId, userId, statuses: ['pending'] });
    if (pendingGates.length) return reply.code(409).send({ error: 'Resolve pending HumanGate before sending a workflow message.', gateId: pendingGates[0].id });
    await appendWorkflowUserMessage(container, run, message);
    await container.stores.eventTraceStore.append({ id: newId('evt'), runId, type: 'pi.session.updated', payload: { userId, reason: 'workflow-user-message' }, createdAt: nowIso() });
    const pendingProposalRun = await handleWorkflowPendingProposalMessage(container, run, message, userId);
    if (pendingProposalRun) return pendingProposalRun;
    const existingInput = readObject(run.input) ?? {};
    const targetStage = normalizeWorkflowTargetStage(body.targetStage);
    const sectionId = body.sectionId?.trim() || (typeof run.metadata.sectionId === 'string' ? run.metadata.sectionId : undefined);
    const updatedInput = { ...existingInput, message, targetStage, sectionId, replaceExisting: body.replaceExisting === true };
    await container.stores.stateStore.updateRun(runId, {
      status: 'running',
      input: updatedInput,
      waitingFor: undefined,
      metadata: { ...run.metadata, sectionId },
      state: { ...run.state, lastUserMessage: message, pendingHumanGateId: undefined },
      updatedAt: nowIso(),
    });
    await container.piRunner.runUntilBlocked(runId);
    return enrichRun(container, runId);
  });

  app.post('/api/workflows/:runId/cancel', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = await container.stores.stateStore.getRun(runId);
    if (!run) return reply.code(404).send({ error: 'Run not found.' });
    await container.stores.stateStore.updateRun(runId, { status: 'cancelled', updatedAt: nowIso() });
    await container.stores.eventTraceStore.append({ id: newId('evt'), runId, type: 'workflow.failed', payload: { workflowId: run.workflowId, cancelled: true, userId: run.metadata.userId }, createdAt: nowIso() });
    return enrichRun(container, runId);
  });
  app.get('/api/workflows/:runId/events', async (request) => { const { runId } = request.params as { runId: string }; return container.stores.eventTraceStore.listByRun(runId); });
  app.get('/api/workflows/:runId/stream', async (request, reply) => { const { runId } = request.params as { runId: string }; await openSseStream(container, reply, { runId }); });
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

function shouldUpdateDialogueBrief(route: DialogueRoute, message: string, pendingProposal?: RevisionProposal): boolean {
  if (route === 'propose') return true;
  if (route === 'discuss' && pendingProposal && isModificationIntent(message)) return true;
  return false;
}

function localDialogueReply(route: DialogueRoute, context: DialogueCoordinatorInput['context'], article: ArticleArtifact, message: string, pendingProposal?: RevisionProposal): string {
  if (route === 'answer') return localDialogueAnswer(context, article, message);
  if (route === 'discuss' && pendingProposal) return '已记录这条意见，暂不刷新当前修改方案。需要合并这些意见时，可以点击“更新方案”，或直接说“按以上意见更新方案”。';
  return `我还不能判断要修改「${context.title}」的哪一部分。请说明要修改、添加、删除，还是只是讨论想法。`;
}

function localDialogueAnswer(context: DialogueCoordinatorInput['context'], article: ArticleArtifact, message: string): string {
  const taskCard = article.taskCard;
  if (taskCard && context.kind === 'task-card') {
    const normalized = normalizeQuestionText(message);
    const citationQuestion = classifyCitationQuestion(normalized);
    if (citationQuestion) return explainCitationRule(taskCard, citationQuestion);
    if (/来源策略|资料|材料/.test(normalized)) return explainSourcePolicy(taskCard);
    if (/写作标准|语言时代感|自然传统/.test(normalized)) return explainWritingStandard(taskCard);
    if (/必须包含|包含项|包含/.test(normalized)) return explainTaskCardList('必须包含', taskCard.constraints.mustInclude);
    if (/避免|不要|禁用词|禁用/.test(normalized)) return explainTaskCardList('避免', taskCard.constraints.mustAvoid);
  }
  if (context.kind === 'outline-item') {
    return `这是对大纲项「${context.title}」的解释：${context.detail || '当前大纲项用于限定这一节要证明的判断或分析角度。'} 这条回复不会修改大纲。`;
  }
  if (context.kind === 'outline') return '这是对整体大纲的只读解释。大纲用于组织文章的论证顺序；如需改动，请说明要新增、删除、合并或调整哪些大纲项。';
  if (context.kind === 'block') return `这是对当前段落「${context.title}」的只读解释。当前问题不会修改正文；如需改写，请说明希望改成什么效果。`;
  return `这是关于「${context.title}」的只读解释，不会修改当前任务。`;
}

function classifyCitationQuestion(normalized: string): 'citation' | 'application-typo' | undefined {
  if (/不强制应用|应用不强制/.test(normalized)) return 'application-typo';
  if (/不强制引用|引用不强制|引用/.test(normalized)) return 'citation';
  return undefined;
}

function explainCitationRule(taskCard: WritingTaskCard, kind: 'citation' | 'application-typo'): string {
  if (taskCard.constraints.citationRequired) {
    return '任务卡中的「需要可追溯引用」意思是：正文使用关键原文、脂批或资料判断时，需要能追到来源；引用仍然只作论据，不能用大段原文替代自己的分析。';
  }
  return [
    ...(kind === 'application-typo' ? ['这里按任务卡字段理解为「不强制引用」。'] : []),
    '任务卡中的「不强制引用」意思是：正文不要求每个观点都附原文、脂批或出处。',
    '它不是禁止引用。可以引用原文或脂批作证，但引用应当短、准，只服务于分析，不能把资料摘要或原文搬运当成正文主体。',
    `当前来源策略是：${taskCard.constraints.sourcePolicy}`,
  ].join('\n');
}

function explainSourcePolicy(taskCard: WritingTaskCard): string {
  return `当前来源策略是：${taskCard.constraints.sourcePolicy} 也就是说，资料用于支撑判断和校正事实，正文仍要以自己的分析、过渡和解释为主。`;
}

function explainWritingStandard(taskCard: WritingTaskCard): string {
  const summary = taskCard.topRules?.summary || taskCard.topRules?.writingStandards.join('；') || '未指定额外写作标准。';
  return `当前写作标准是：${summary} 它会约束正文语言和表达方式，优先级高于普通风格描述。`;
}

function explainTaskCardList(label: string, items: string[]): string {
  if (!items.length) return `当前任务卡没有设置「${label}」条目。`;
  return `当前任务卡的「${label}」条目是：${items.join('；')}。这些条目会约束后续大纲、正文生成和局部修改。`;
}

function dialogueBriefBarrierError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `上一轮对话上下文尚未更新完成或更新失败，已停止继续处理。${detail}`;
}

async function answerWithKnowledge(container: AppContainer, article: ArticleArtifact, context: DialogueCoordinatorInput['context'], message: string): Promise<{ message: string; query: string; items: KnowledgeItem[] }> {
  const spec = knowledgeSearchSpec(article, message);
  const items = await container.stores.knowledgeStore.search(spec.query, spec.options);
  if (!items.length) return { message: '没有查到足够相关的资料。可以换一种问法，或明确要查的原文、脂批、章节或人物。', query: spec.query, items };
  const lines = items.map((item, index) => `${index + 1}. ${knowledgeItemLabel(item)}`);
  return { message: [`查到 ${items.length} 条相关资料，可以作为后续修改或写作依据：`, ...lines, '如果要把这些资料合并进当前修改方案，请说“按这些资料更新方案”。'].join('\n'), query: spec.query, items };
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

async function handleWorkflowPendingProposalMessage(container: AppContainer, run: WorkflowRun, message: string, userId: string): Promise<Awaited<ReturnType<typeof enrichRun>> | undefined> {
  const pendingProposalId = typeof run.state.pendingRevisionProposalId === 'string' ? run.state.pendingRevisionProposalId : undefined;
  if (!pendingProposalId) return undefined;
  const proposal = await container.stores.revisionProposalStore.getProposal(pendingProposalId);
  if (!proposal || proposal.runId !== run.id) throw new Error('Pending workflow revision proposal not found.');
  if (proposal.userId !== userId || run.metadata.userId !== userId) throw new Error('Revision proposal belongs to another user.');
  if (proposal.status !== 'pending') throw new Error(`Revision proposal is already ${proposal.status}.`);

  const route = routeDialogueMessage(message, proposal);
  if (route === 'apply') {
    await applyRevisionProposal(container, proposal.id, userId, typeof run.metadata.sessionId === 'string' ? run.metadata.sessionId : undefined);
    return enrichRun(container, run.id);
  }
  if (route === 'dismiss') {
    const { runPayload } = await dismissRevisionProposal(container, proposal, userId);
    return runPayload ?? enrichRun(container, run.id);
  }
  if (route !== 'propose' && !(route === 'discuss' && isModificationIntent(message))) {
    return enrichRun(container, run.id);
  }

  const access = await requireArticleAccess(container, userId, proposal.articleId);
  if (!access.ok) throw new Error(access.error);
  const context = resolveDialogueContext(access.article, dialogueContextRequestForProposal(proposal));
  if (!context.ok) throw new Error(context.error);
  const now = nowIso();
  const existingConversation = await listDialogueMessages(container, access.article.id, userId, 24);
  const conversation = buildCompactDialogueConversation([
    ...existingConversation,
    { id: newId('dlg'), articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'user', content: message, proposalId: proposal.id, createdAt: now },
  ]);
  const conversationBrief = await getOrCreateDialogueBrief(container, access.article.id, userId);
  const result = await container.runtime.invokeSkill<DialogueCoordinatorInput, DialogueCoordinatorOutput>(
    'dialogue-coordinator',
    {
      articleId: access.article.id,
      message,
      skipKnowledge: true,
      conversation,
      conversationBrief: compactDialogueBriefForPrompt(conversationBrief),
      pendingProposal: proposalForDialogue(proposal),
      context: context.value.context,
      taskCard: access.article.taskCard,
      outline: access.article.outline,
      selectedOutlineItem: context.value.selectedOutlineItem,
      selectedBlock: context.value.selectedBlock,
    },
    { userId, sessionId: typeof run.metadata.sessionId === 'string' ? run.metadata.sessionId : undefined, runId: run.id, articleId: access.article.id },
  );
  if (result.mode !== 'proposal') {
    throw new Error(`Workflow proposal refresh did not return a proposal: ${result.mode}`);
  }
  await container.stores.revisionProposalStore.updateProposal({ ...proposal, status: 'dismissed' });
  const nextProposal = await container.stores.revisionProposalStore.createProposal({
    articleId: access.article.id,
    userId,
    runId: run.id,
    authorUserId: userId,
    baseRevision: access.article.revision,
    contextKind: context.value.context.kind,
    summary: result.summary ?? result.message,
    message: result.message,
    operations: result.operations,
    warnings: result.warnings,
  });
  await syncWorkflowRunToRefreshedProposal(container, proposal, nextProposal);
  return enrichRun(container, run.id);
}

function dialogueContextRequestForProposal(proposal: RevisionProposal): DialogueContextRequest {
  const blockOperation = proposal.operations.find((operation): operation is Extract<RevisionOperation, { type: 'patch-block' }> => operation.type === 'patch-block');
  const outlineItemOperation = proposal.operations.find((operation): operation is Extract<RevisionOperation, { type: 'revise-outline-item' }> => operation.type === 'revise-outline-item');
  if (proposal.contextKind === 'block') return { kind: 'block', blockId: blockOperation?.blockId };
  if (proposal.contextKind === 'outline-item') return { kind: 'outline-item', outlineItemId: outlineItemOperation?.outlineItemId };
  return { kind: proposal.contextKind };
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

function normalizeQuestionText(message: string): string {
  return message.replace(/\s+/g, '').toLowerCase();
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
  return /(改|修改|调整|删|删除|加|添加|新增|重写|扩写|压缩|不要|避免|改成|改为|换成|补充|合并|拆分|包含|纳入|加入|写进|放进|体现|保留|漏掉|遗漏|参考|使用|采用|沿用|突出|强调|弱化|去掉|移除|需要|必须|重点)/.test(message);
}

function isDialogueCoordinatorRecoverableFailure(error: unknown): boolean {
  return error instanceof Error && /Dialogue coordinator (did not return valid JSON|returned invalid|returned empty|returned unsupported|returned proposal without operations)/.test(error.message);
}

async function applyRevisionProposal(container: AppContainer, proposalId: string, userId: string, sessionId?: string) {
  const proposal = await container.stores.revisionProposalStore.getProposal(proposalId);
  if (!proposal) throw new Error('Revision proposal not found.');
  if (proposal.userId !== userId) throw new Error('Revision proposal belongs to another user.');
  if (proposal.status !== 'pending') throw new Error(`Revision proposal is already ${proposal.status}.`);
  const access = await requireArticleAccess(container, userId, proposal.articleId);
  if (!access.ok) throw new Error(access.error);
  let article = access.article;
  if (typeof proposal.baseRevision === 'number' && article.revision !== proposal.baseRevision) {
    throw new Error(`Revision proposal is stale: article revision is ${article.revision}, proposal was created at ${proposal.baseRevision}.`);
  }
  let runPayload: Awaited<ReturnType<typeof enrichRun>> | undefined;
  for (const operation of proposal.operations) {
    const result = await applyRevisionOperation(container, article, operation, userId, sessionId);
    if (result.runPayload) runPayload = result.runPayload;
    article = result.article;
  }
  const applied = await container.stores.revisionProposalStore.updateProposal({ ...proposal, status: 'applied' });
  const articlePayload = await container.stores.artifactStore.getArticle(article.id);
  const workflowRunPayload = await syncWorkflowRunAfterProposal(container, applied, 'applied');
  const finalRunPayload = workflowRunPayload ?? runPayload;
  return {
    mode: 'applied',
    message: finalRunPayload ? '修改已应用，工作流已继续推进。' : '修改已应用。',
    proposal: applied,
    article: articlePayload ? withWritingStandardSummary(articlePayload) : articlePayload,
    ...(finalRunPayload ?? {}),
  };
}

async function dismissRevisionProposal(container: AppContainer, proposal: RevisionProposal, userId: string): Promise<{ proposal: RevisionProposal; runPayload?: Awaited<ReturnType<typeof enrichRun>> }> {
  if (proposal.userId !== userId) throw new Error('Revision proposal belongs to another user.');
  if (proposal.status !== 'pending') throw new Error(`Revision proposal is already ${proposal.status}.`);
  const dismissed = await container.stores.revisionProposalStore.updateProposal({ ...proposal, status: 'dismissed' });
  const runPayload = await syncWorkflowRunAfterProposal(container, dismissed, 'dismissed');
  return { proposal: dismissed, runPayload };
}

async function syncWorkflowRunToRefreshedProposal(container: AppContainer, previousProposal: RevisionProposal, nextProposal: RevisionProposal): Promise<void> {
  if (!previousProposal.runId || previousProposal.runId !== nextProposal.runId) return;
  const run = await container.stores.stateStore.getRun(previousProposal.runId);
  if (!run) return;
  if (run.metadata.userId !== nextProposal.userId) throw new Error('Workflow proposal belongs to another user.');
  if (run.state.pendingRevisionProposalId !== previousProposal.id) return;
  await container.stores.stateStore.updateRun(run.id, {
    status: 'waiting',
    waitingFor: { nodeId: 'revision-proposal', reason: '已刷新待确认修改方案，请先应用或取消后再继续写作。' },
    state: {
      ...run.state,
      pendingRevisionProposalId: nextProposal.id,
      pendingRevisionProposalRevision: nextProposal.baseRevision,
      pendingReviewProposal: undefined,
    },
    updatedAt: nowIso(),
  });
  await container.stores.eventTraceStore.append({
    id: newId('evt'),
    runId: run.id,
    type: 'revision_proposal.created',
    payload: {
      articleId: nextProposal.articleId,
      proposalId: nextProposal.id,
      replacedProposalId: previousProposal.id,
      userId: nextProposal.userId,
    },
    createdAt: nowIso(),
  });
}

async function syncWorkflowRunAfterProposal(container: AppContainer, proposal: RevisionProposal, resolution: 'applied' | 'dismissed'): Promise<Awaited<ReturnType<typeof enrichRun>> | undefined> {
  if (!proposal.runId) return undefined;
  const run = await container.stores.stateStore.getRun(proposal.runId);
  if (!run) return undefined;
  if (run.metadata.userId !== proposal.userId) throw new Error('Workflow proposal belongs to another user.');
  if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed') return enrichRun(container, run.id);
  if (run.state.pendingRevisionProposalId !== proposal.id) return enrichRun(container, run.id);
  const shouldClearBlocking = resolution === 'applied';
  await container.stores.stateStore.updateRun(run.id, {
    status: 'running',
    waitingFor: undefined,
    state: {
      ...run.state,
      pendingRevisionProposalId: undefined,
      pendingRevisionProposalRevision: undefined,
      pendingReviewProposal: undefined,
      ...(shouldClearBlocking ? { consistencyBlockingReviewId: undefined, consistencyBlockingRevision: undefined } : {}),
      revisionProposalResult: { proposalId: proposal.id, status: resolution },
    },
    updatedAt: nowIso(),
  });
  await container.stores.eventTraceStore.append({
    id: newId('evt'),
    runId: run.id,
    type: 'revision_proposal.resolved',
    payload: { articleId: proposal.articleId, proposalId: proposal.id, status: resolution, userId: proposal.userId },
    createdAt: nowIso(),
  });
  await container.piRunner.runUntilBlocked(run.id);
  return enrichRun(container, run.id);
}

async function applyRevisionOperation(container: AppContainer, article: ArticleArtifact, operation: RevisionOperation, userId: string, sessionId?: string): Promise<{ article: ArticleArtifact; runPayload?: Awaited<ReturnType<typeof enrichRun>> }> {
  if (operation.type === 'revise-task-card') {
    if (!article.taskCard) throw new Error('Article has no task card to revise.');
    const result = await container.runtime.invokeSkill<{ articleId: string; instruction: string; currentTaskCard: WritingTaskCard; skipKnowledge: boolean }, TaskCardReviserOutput>(
      'task-card-reviser',
      { articleId: article.id, instruction: operation.instruction, currentTaskCard: article.taskCard, skipKnowledge: true },
      { userId, sessionId, articleId: article.id },
    );
    const invalidation = clearDownstreamForTaskCardChange(article);
    article.taskCard = normalizeTaskCardPolicies(result.taskCard, operation.instruction).taskCard;
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
  const patchResult = await container.runtime.invokeSkill<PatchEditorInput, PatchEditorOutput>(
    'patch-editor',
    { articleId: article.id, blockId: operation.blockId, instruction: operation.instruction },
    { userId, sessionId, articleId: article.id, blockId: operation.blockId },
  );
  const updated = await container.stores.artifactStore.applyPatch(patchResult.patch);
  await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, blockId: operation.blockId, reason: 'dialogue-patch-applied', userId }, createdAt: nowIso() });
  if (sessionId) await container.stores.sessionStore.updateSession(sessionId, { currentArticleId: article.id, currentWorkspaceId: article.workspaceId, currentBlockId: operation.blockId });
  return { article: updated };
}

type ArticleCommentProcessResult = {
  commentId: string;
  blockId: string;
  action: ArticleCommentResolverOutput['action'];
  status: ArticleComment['status'];
  message: string;
  changed: boolean;
};

async function processArticleComments(container: AppContainer, article: ArticleArtifact, userId: string, sessionId?: string, commentIds?: string[]): Promise<{ article: ArticleArtifact; results: ArticleCommentProcessResult[] }> {
  const targetIds = new Set((commentIds ?? []).map((id) => id.trim()).filter(Boolean));
  const comments = article.comments ?? [];
  const targets = comments.filter((comment) => (targetIds.size ? targetIds.has(comment.id) : comment.status === 'open'));
  if (!targets.length) return { article, results: [] };
  let revisedCount = 0;
  const results: ArticleCommentProcessResult[] = [];
  for (const comment of targets) {
    const block = article.blocks.find((item) => item.id === comment.blockId);
    if (!block) {
      updateComment(comment, { status: 'needs_input', resolutionKind: 'question', response: '这条批注关联的段落已经不存在，需要重新选择正文后再批注。' });
      results.push({ commentId: comment.id, blockId: comment.blockId, action: 'ask', status: comment.status, message: comment.response ?? '', changed: false });
      continue;
    }
    try {
      const output = await container.runtime.invokeSkill<ArticleCommentResolverInput, ArticleCommentResolverOutput>(
        'article-comment-resolver',
        {
          articleId: article.id,
          comment,
          block,
          taskCard: article.taskCard,
          adjacentBlocks: adjacentBlocksForArticle(article.blocks, block.id),
        },
        { userId, sessionId, articleId: article.id, blockId: block.id },
      );
      const applied = applyArticleCommentResolution(article, comment, output);
      if (applied.changed) revisedCount += 1;
      results.push({ commentId: comment.id, blockId: comment.blockId, action: output.action, status: comment.status, message: comment.response ?? output.response, changed: applied.changed });
    } catch (error) {
      updateComment(comment, { status: 'needs_input', resolutionKind: 'question', response: `这条批注没有处理成功，需要人工确认：${error instanceof Error ? error.message : String(error)}` });
      results.push({ commentId: comment.id, blockId: comment.blockId, action: 'ask', status: comment.status, message: comment.response ?? '', changed: false });
    }
  }
  const updated = await container.stores.artifactStore.updateArticle(article);
  if (revisedCount) {
    await container.stores.artifactStore.commitVersion(article.id, `处理正文批注：${revisedCount} 处修订`, 'agent');
  }
  await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, reason: 'article-comments-processed', processedCount: results.length, revisedCount, userId }, createdAt: nowIso() });
  return { article: (await container.stores.artifactStore.getArticle(updated.id)) ?? updated, results };
}

function applyArticleCommentResolution(article: ArticleArtifact, comment: ArticleComment, output: ArticleCommentResolverOutput): { changed: boolean } {
  if (output.action === 'explain') {
    updateComment(comment, { status: 'resolved', resolutionKind: 'explanation', response: output.response });
    return { changed: false };
  }
  if (output.action === 'ask') {
    updateComment(comment, { status: 'needs_input', resolutionKind: 'question', response: output.response });
    return { changed: false };
  }
  const replacementText = output.replacementText?.trim();
  if (!replacementText) {
    updateComment(comment, { status: 'needs_input', resolutionKind: 'question', response: '处理器没有给出可替换文本，需要人工确认。' });
    return { changed: false };
  }
  const block = article.blocks.find((item) => item.id === comment.blockId);
  if (!block) {
    updateComment(comment, { status: 'needs_input', resolutionKind: 'question', response: '这条批注关联的段落已经不存在，需要重新选择正文后再批注。' });
    return { changed: false };
  }
  const range = locateCommentSelection(block.text, comment);
  if (!range) {
    updateComment(comment, { status: 'needs_input', resolutionKind: 'question', response: '选中文本已经变化，无法自动替换；请重新选择最新正文添加批注。' });
    return { changed: false };
  }
  const text = `${block.text.slice(0, range.start)}${replacementText}${block.text.slice(range.end)}`;
  article.blocks = article.blocks.map((item) => item.id === block.id ? { ...item, text, status: 'draft', updatedAt: nowIso() } : item);
  updateComment(comment, { status: 'resolved', resolutionKind: 'revision', response: output.response, replacementText });
  return { changed: true };
}

function updateComment(comment: ArticleComment, patch: Partial<ArticleComment>): void {
  const now = nowIso();
  Object.assign(comment, {
    ...patch,
    updatedAt: now,
    resolvedAt: patch.status === 'resolved' ? now : comment.resolvedAt,
  });
  if (typeof patch.response === 'string' && patch.response.trim()) appendCommentReply(comment, 'assistant', patch.response, now);
}

function appendCommentReply(comment: ArticleComment, role: 'user' | 'assistant' | 'system', content: string, createdAt = nowIso()): void {
  const text = content.trim();
  if (!text) return;
  const existingReplies = comment.replies ?? [];
  const replies = existingReplies.length ? existingReplies : legacyResponseReply(comment);
  const last = replies[replies.length - 1];
  comment.replies = last?.role === role && last.content === text ? replies : [...replies, { id: newId('crp'), role, content: text, createdAt }];
  comment.updatedAt = createdAt;
}

function canDeleteUnprocessedComment(comment: ArticleComment): boolean {
  return comment.status === 'open'
    && !(comment.replies ?? []).length
    && !comment.response?.trim()
    && !comment.replacementText?.trim()
    && !comment.resolvedAt;
}

function canDeleteUnprocessedReply(comment: ArticleComment, reply: NonNullable<ArticleComment['replies']>[number]): boolean {
  if (comment.status !== 'open' || reply.role !== 'user') return false;
  const replies = comment.replies ?? [];
  const replyIndex = replies.findIndex((item) => item.id === reply.id);
  if (replyIndex < 0) return false;
  return replies.slice(replyIndex + 1).every((item) => item.role === 'user');
}

function reconcileCommentAfterReplyDeletion(comment: ArticleComment): void {
  const now = nowIso();
  const replies = comment.replies ?? [];
  const latestReply = replies[replies.length - 1];
  if (latestReply?.role === 'user') {
    comment.status = 'open';
    comment.resolutionKind = undefined;
    comment.updatedAt = now;
    return;
  }
  if (comment.response?.trim()) {
    if (comment.replacementText?.trim() || comment.resolvedAt) {
      comment.status = 'resolved';
      comment.resolutionKind = comment.replacementText?.trim() ? 'revision' : 'explanation';
      comment.resolvedAt = comment.resolvedAt ?? now;
    } else {
      comment.status = 'needs_input';
      comment.resolutionKind = 'question';
    }
    comment.updatedAt = now;
    return;
  }
  if (comment.replacementText?.trim()) {
    comment.status = 'resolved';
    comment.resolutionKind = 'revision';
    comment.resolvedAt = comment.resolvedAt ?? now;
  } else {
    comment.status = 'open';
    comment.resolutionKind = undefined;
    comment.resolvedAt = undefined;
  }
  comment.updatedAt = now;
}

function legacyResponseReply(comment: ArticleComment): NonNullable<ArticleComment['replies']> {
  const response = comment.response?.trim();
  return response ? [{ id: newId('crp'), role: 'assistant', content: response, createdAt: comment.resolvedAt ?? comment.updatedAt }] : [];
}

function locateCommentSelection(text: string, comment: ArticleComment): { start: number; end: number } | undefined {
  const directIndex = text.indexOf(comment.selectedText);
  if (directIndex >= 0) return { start: directIndex, end: directIndex + comment.selectedText.length };
  if (typeof comment.selectionStart === 'number' && typeof comment.selectionEnd === 'number' && text.slice(comment.selectionStart, comment.selectionEnd) === comment.selectedText) {
    return { start: comment.selectionStart, end: comment.selectionEnd };
  }
  return undefined;
}

function adjacentBlocksForArticle(blocks: ArticleBlock[], blockId: string): Array<Pick<ArticleBlock, 'id' | 'title' | 'text'>> {
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index < 0) return [];
  return blocks.slice(Math.max(0, index - 1), index + 2).filter((block) => block.id !== blockId).map((block) => ({ id: block.id, title: block.title, text: block.text.slice(0, 600) }));
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

function readRequestUserId(request: FastifyRequest, explicitUserId?: string): string | undefined {
  return resolveUserContext(request, explicitUserId)?.userId;
}

function normalizeWorkflowTargetStage(value: string | undefined): 'task-card' | 'outline' | 'section' | 'article' {
  if (value === 'task-card' || value === 'outline' || value === 'section' || value === 'article') return value;
  return 'article';
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

async function applyAcceptedHumanGate(container: AppContainer, gate: Awaited<ReturnType<AppContainer['stores']['humanGateStore']['getGate']>>, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!gate) throw new Error('Human gate not found.');
  if (!gate.articleId) throw new Error('HumanGate is missing articleId.');
  const article = await container.stores.artifactStore.getArticle(gate.articleId);
  if (!article) throw new Error('Article not found for HumanGate.');
  if (typeof gate.baseRevision === 'number' && article.revision !== gate.baseRevision) {
    throw new Error(`HumanGate is stale: article revision is ${article.revision}, gate was created at ${gate.baseRevision}.`);
  }
  if (gate.targetKind === 'outline') {
    return {
      articleId: article.id,
      revision: article.revision,
      targetKind: gate.targetKind,
      statePatch: { outlineReplacementApprovedRevision: article.revision },
    };
  }
  if (gate.targetKind !== 'task-card') throw new Error(`Unsupported accepted HumanGate target: ${gate.targetKind}`);
  if (!article.taskCard) throw new Error('Article task card not found for HumanGate.');
  const taskCardPatch = readObject(payload.taskCardPatch) ?? readObject(payload.taskCard);
  const mergedTaskCard = taskCardPatch
    ? mergeDeep(article.taskCard as unknown as Record<string, unknown>, taskCardPatch) as unknown as WritingTaskCard
    : article.taskCard;
  mergedTaskCard.status = 'confirmed';
  mergedTaskCard.updatedAt = nowIso();
  article.taskCard = normalizeTaskCardPolicies(mergedTaskCard).taskCard;
  const updated = await container.stores.artifactStore.updateArticle(article);
  await container.stores.artifactStore.commitVersion(article.id, 'HumanGate 确认任务卡', 'user');
  await container.stores.eventTraceStore.append({ id: newId('evt'), runId: gate.runId, type: 'artifact.updated', payload: { articleId: article.id, reason: 'human-gate-task-card-confirmed', userId: gate.userId, gateId: gate.id }, createdAt: nowIso() });
  return { articleId: updated.id, revision: updated.revision, taskCardStatus: updated.taskCard?.status };
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function appendWorkflowUserMessage(container: AppContainer, run: WorkflowRun, message: string): Promise<void> {
  const existing = await container.stores.piAgentSessionStore.getWorkflowSession(run.id);
  const now = nowIso();
  const userMessage = { role: 'user', content: message, timestamp: Date.now() };
  if (existing) {
    await container.stores.piAgentSessionStore.saveSession({
      ...existing,
      messages: [...existing.messages, userMessage],
      lockVersion: existing.lockVersion + 1,
      updatedAt: now,
    });
    return;
  }
  await container.stores.piAgentSessionStore.saveSession({
    id: newId('pi_ses'),
    runId: run.id,
    userId: run.metadata.userId,
    workspaceId: typeof run.metadata.workspaceId === 'string' ? run.metadata.workspaceId : undefined,
    articleId: typeof run.metadata.articleId === 'string' ? run.metadata.articleId : undefined,
    contextKind: 'workflow',
    messages: [userMessage],
    lockVersion: 0,
    createdAt: now,
    updatedAt: now,
  });
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
  const run = await container.stores.stateStore.getRun(runId);
  if (!run) throw new Error('Run not found after execution.');
  const articleId = (run.state.draftArticle as { articleId?: string } | undefined)?.articleId ?? (run.state.finalizedTaskCard as { articleId?: string } | undefined)?.articleId ?? (run.state.outlineDraft as { articleId?: string } | undefined)?.articleId ?? (run.state.writingStarted as { articleId?: string } | undefined)?.articleId ?? (run.state.finalizedOutline as { articleId?: string } | undefined)?.articleId ?? (run.state.committedSection as { articleId?: string } | undefined)?.articleId ?? (run.state.appliedPatch as { articleId?: string } | undefined)?.articleId ?? (typeof run.metadata.articleId === 'string' ? run.metadata.articleId : undefined);
  const article = articleId ? await container.stores.artifactStore.getArticle(articleId) : undefined;
  const [events, humanGates, operations, reviewArtifacts, revisionProposals] = await Promise.all([
    container.stores.eventTraceStore.listByRun(run.id),
    container.stores.humanGateStore.listGates({ runId: run.id }),
    container.stores.workflowOperationStore.listOperations({ runId: run.id }),
    container.stores.reviewArtifactStore.listReviewArtifacts({ runId: run.id }),
    article ? container.stores.revisionProposalStore.listPendingProposals(article.id, run.metadata.userId) : Promise.resolve([]),
  ]);
  return { run, article: article ? withWritingStandardSummary(article) : article, events, humanGates, operations, reviewArtifacts, revisionProposals };
}
