import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import { AgentEvent, ArticleArtifact, ArticleBlock, ArticleComment, ArticleRevisionConflictError, DialogueContextKind, DialogueMessage, EventSubscriptionFilter, hashOperationArgs, HumanGate, KnowledgeItem, KnowledgeSearchOptions, mergeDeep, newId, nowIso, OutlineItem, RevisionOperation, RevisionProposal, Unsubscribe, WorkflowRun, WRITING_AUTOPILOT_POLICY, WritingTaskCard, WritingWorkspace } from '@wa/core';
import { normalizeTaskCardPolicies } from '@wa/skills';
import type { DialogueCoordinatorInput, DialogueCoordinatorOutput, DialogueRouterInput, DialogueRouterOutput, OutlineItemReviserOutput, OutlineReviserOutput, PatchEditorInput, PatchEditorOutput, TaskCardReviserOutput } from '@wa/skills';
import { AppConfig } from './config';
import { AppContainer } from './bootstrap';
import { appendCommentReply, canDeleteUnprocessedComment, canDeleteUnprocessedReply, reconcileCommentAfterReplyDeletion, updateComment } from './articleComments';
import { addKnowledgeEvidenceToBrief, buildCompactDialogueConversation, compactDialogueBriefForPrompt, enqueueDialogueBriefUpdate, ensureDialogueBriefSettled, getDialogueBriefStatus, getOrCreateDialogueBrief } from './dialogueBrief';
import { DomainProfileSelectionRequest, getDomainProfileSummary, listDomainProfileSummaries, recommendDomainProfiles, resolveDomainProfileSelection } from './domainProfiles';
import { getWritingStandardDisplaySummary, getWritingStandardSummary, resolveWritingStandardSelection, WritingStandardSelectionRequest } from './writingStandards';
import { resolveUserContext } from './userContext';

class RevisionProposalStaleError extends Error {
  constructor(currentRevision: number, proposalRevision: number) {
    super(`Revision proposal is stale: article revision is ${currentRevision}, proposal was created at ${proposalRevision}.`);
  }
}

class HumanGateStaleError extends Error {
  constructor(readonly currentRevision: number, readonly gateRevision: number) {
    super(`HumanGate is stale: article revision is ${currentRevision}, gate was created at ${gateRevision}.`);
  }
}

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
    const body = (request.body ?? {}) as { userId?: string; blockId?: string; selectedText?: string; comment?: string; baseRevision?: number };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const baseRevision = parseBaseRevision(body.baseRevision);
    if (baseRevision === undefined) return reply.code(400).send({ error: 'baseRevision is required.' });
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
    const result = await applyAuditedArticleMutation(container, {
      article: access.article,
      userId,
      baseRevision,
      operationId: articleMutationOperationId('comment_create', { articleId: access.article.id, blockId, selectedText, note, baseRevision }),
      toolName: 'create_article_comment',
      allowedActionId: `article-comment-create:${access.article.id}:${blockId}`,
      argsHash: hashOperationArgs({ articleId: access.article.id, blockId, selectedText, note, baseRevision }),
      resultRef: comment.id,
      eventPayload: { articleId: access.article.id, blockId, commentId: comment.id, reason: 'article-comment-created', userId },
      mutate: (article) => {
        article.comments = [...(article.comments ?? []), comment];
      },
    });
    if (!result.ok) return reply.code(result.statusCode).send({ error: result.error });
    return withWritingStandardSummary(result.article);
  });
  app.post('/api/articles/:articleId/comments/:commentId/replies', async (request, reply) => {
    const { articleId, commentId } = request.params as { articleId: string; commentId: string };
    const body = (request.body ?? {}) as { userId?: string; content?: string; baseRevision?: number };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const baseRevision = parseBaseRevision(body.baseRevision);
    if (baseRevision === undefined) return reply.code(400).send({ error: 'baseRevision is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const content = body.content?.trim();
    if (!content) return reply.code(400).send({ error: 'content is required.' });
    const comment = (access.article.comments ?? []).find((item) => item.id === commentId);
    if (!comment) return reply.code(404).send({ error: 'Article comment not found.' });
    const result = await applyAuditedArticleMutation(container, {
      article: access.article,
      userId,
      baseRevision,
      operationId: articleMutationOperationId('comment_reply_create', { articleId: access.article.id, commentId, content, baseRevision }),
      toolName: 'create_article_comment_reply',
      allowedActionId: `article-comment-reply-create:${access.article.id}:${commentId}`,
      argsHash: hashOperationArgs({ articleId: access.article.id, commentId, content, baseRevision }),
      resultRef: comment.id,
      eventPayload: { articleId: access.article.id, blockId: comment.blockId, commentId: comment.id, reason: 'article-comment-replied', userId },
      mutate: () => {
        appendCommentReply(comment, 'user', content);
        updateComment(comment, { status: 'open', resolutionKind: undefined, resolvedAt: undefined });
      },
    });
    if (!result.ok) return reply.code(result.statusCode).send({ error: result.error });
    return withWritingStandardSummary(result.article);
  });
  app.delete('/api/articles/:articleId/comments/:commentId', async (request, reply) => {
    const { articleId, commentId } = request.params as { articleId: string; commentId: string };
    const body = (request.body ?? {}) as { userId?: string; baseRevision?: number };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const baseRevision = parseBaseRevision(body.baseRevision);
    if (baseRevision === undefined) return reply.code(400).send({ error: 'baseRevision is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const comments = access.article.comments ?? [];
    const comment = comments.find((item) => item.id === commentId);
    if (!comment) return withWritingStandardSummary(access.article);
    if (!canDeleteUnprocessedComment(comment)) return reply.code(409).send({ error: 'Only unprocessed comments can be deleted.' });
    const result = await applyAuditedArticleMutation(container, {
      article: access.article,
      userId,
      baseRevision,
      operationId: articleMutationOperationId('comment_delete', { articleId: access.article.id, commentId, baseRevision }),
      toolName: 'delete_article_comment',
      allowedActionId: `article-comment-delete:${access.article.id}:${commentId}`,
      argsHash: hashOperationArgs({ articleId: access.article.id, commentId, baseRevision }),
      resultRef: comment.id,
      eventPayload: { articleId: access.article.id, blockId: comment.blockId, commentId: comment.id, reason: 'article-comment-deleted', userId },
      mutate: (article) => {
        article.comments = comments.filter((item) => item.id !== commentId);
      },
    });
    if (!result.ok) return reply.code(result.statusCode).send({ error: result.error });
    return withWritingStandardSummary(result.article);
  });
  app.delete('/api/articles/:articleId/comments/:commentId/replies/:replyId', async (request, reply) => {
    const { articleId, commentId, replyId } = request.params as { articleId: string; commentId: string; replyId: string };
    const body = (request.body ?? {}) as { userId?: string; baseRevision?: number };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const baseRevision = parseBaseRevision(body.baseRevision);
    if (baseRevision === undefined) return reply.code(400).send({ error: 'baseRevision is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const comments = access.article.comments ?? [];
    const comment = comments.find((item) => item.id === commentId);
    if (!comment) return withWritingStandardSummary(access.article);
    const replies = comment.replies ?? [];
    const targetReply = replies.find((item) => item.id === replyId);
    if (!targetReply) return withWritingStandardSummary(access.article);
    if (!canDeleteUnprocessedReply(comment, targetReply)) return reply.code(409).send({ error: 'Only unprocessed user replies can be deleted.' });
    const result = await applyAuditedArticleMutation(container, {
      article: access.article,
      userId,
      baseRevision,
      operationId: articleMutationOperationId('comment_reply_delete', { articleId: access.article.id, commentId, replyId, baseRevision }),
      toolName: 'delete_article_comment_reply',
      allowedActionId: `article-comment-reply-delete:${access.article.id}:${commentId}:${replyId}`,
      argsHash: hashOperationArgs({ articleId: access.article.id, commentId, replyId, baseRevision }),
      resultRef: targetReply.id,
      eventPayload: { articleId: access.article.id, blockId: comment.blockId, commentId: comment.id, replyId: targetReply.id, reason: 'article-comment-reply-deleted', userId },
      mutate: () => {
        comment.replies = replies.filter((item) => item.id !== replyId);
        if (targetReply.role === 'assistant' && comment.response?.trim() === targetReply.content.trim()) {
          comment.response = undefined;
        }
        reconcileCommentAfterReplyDeletion(comment);
      },
    });
    if (!result.ok) return reply.code(result.statusCode).send({ error: result.error });
    return withWritingStandardSummary(result.article);
  });
  app.delete('/api/articles/:articleId', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const body = (request.body ?? {}) as { userId?: string; baseRevision?: number };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const baseRevision = parseBaseRevision(body.baseRevision);
    if (baseRevision === undefined) return reply.code(400).send({ error: 'baseRevision is required.' });
    const operationId = articleMutationOperationId('delete', { articleId, baseRevision });
    const existingOperation = await container.stores.workflowOperationStore.getOperation(operationId);
    if (existingOperation?.status === 'completed') {
      const deletedArticle = await container.stores.artifactStore.getArticleIncludingDeleted(articleId);
      if (!deletedArticle) return reply.code(404).send({ error: 'Article not found' });
      if (!(await canAccessArticle(container, userId, deletedArticle))) return reply.code(403).send({ error: 'Workspace access required.' });
      return articleSummary(deletedArticle);
    }
    if (existingOperation?.status === 'running') return reply.code(409).send({ error: `Workflow operation is already running: ${operationId}` });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const article = access.article;
    const deletedAt = nowIso();
    const deleteVersion = {
      id: newId('ver'),
      reason: '删除任务',
      author: 'user' as const,
      snapshot: { taskCard: article.taskCard, outline: article.outline, blocks: article.blocks, citations: article.citations, themeTags: article.themeTags, comments: article.comments ?? [] },
      createdAt: deletedAt,
    };
    const result = await applyAuditedArticleMutation(container, {
      article,
      userId,
      baseRevision,
      operationId,
      toolName: 'delete_article',
      allowedActionId: `article-delete:${article.id}`,
      argsHash: hashOperationArgs({ articleId: article.id, baseRevision }),
      resultRef: article.id,
      eventPayload: { articleId: article.id, reason: 'article-deleted', userId },
      mutate: (target) => {
        target.versions = [...target.versions, deleteVersion];
        target.deletedAt = target.deletedAt ?? deletedAt;
      },
    });
    if (!result.ok) return reply.code(result.statusCode).send({ error: result.error });
    return articleSummary(result.article);
  });
  app.patch('/api/articles/:articleId/outline/:sectionId', async (request, reply) => {
    const { articleId, sectionId } = request.params as { articleId: string; sectionId: string };
    const body = request.body as { title?: string; goal?: string; userId?: string; baseRevision?: number };
    const title = body.title?.trim();
    const goal = body.goal?.trim();
    const baseRevision = typeof body.baseRevision === 'number' && Number.isInteger(body.baseRevision) ? body.baseRevision : undefined;
    if (!title || !goal) return reply.code(400).send({ error: 'Outline title and goal are required.' });
    if (baseRevision === undefined) return reply.code(400).send({ error: 'baseRevision is required.' });
    const article = await container.stores.artifactStore.getArticle(articleId);
    if (!article) return reply.code(404).send({ error: 'Article not found' });
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    if (!(await canAccessArticle(container, userId, article))) return reply.code(403).send({ error: 'Workspace access required.' });
    const existing = article.outline.find((item) => item.id === sectionId);
    if (!existing) return reply.code(404).send({ error: 'Outline section not found' });
    const operationId = manualOutlineEditOperationId(article.id, sectionId, baseRevision, title, goal);
    const existingOperation = await container.stores.workflowOperationStore.getOperation(operationId);
    if (existingOperation?.status === 'completed') {
      const currentArticle = await container.stores.artifactStore.getArticle(article.id);
      return currentArticle ? withWritingStandardSummary(currentArticle) : currentArticle;
    }
    if (existingOperation?.status === 'running') return reply.code(409).send({ error: `Workflow operation is already running: ${operationId}` });
    const operationInput = {
      operationId,
      userId,
      articleId: article.id,
      toolName: 'manual_edit_outline_item',
      allowedActionId: `manual-outline-edit:${article.id}:${sectionId}`,
      argsHash: hashOperationArgs({ articleId: article.id, sectionId, title, goal, baseRevision }),
      articleRevisionBefore: baseRevision,
    };
    const runningOperation = existingOperation?.status === 'failed'
      ? await container.stores.workflowOperationStore.updateOperation({ ...existingOperation, ...operationInput, status: 'running', error: undefined })
      : await container.stores.workflowOperationStore.startOperation(operationInput);
    let updated: ArticleArtifact;
    let invalidation: ReturnType<typeof clearBlocksForOutlineSections>;
    try {
      invalidation = clearBlocksForOutlineSections(article, [sectionId]);
      article.outline = article.outline.map((item) => item.id === sectionId ? { ...item, title, goal, status: item.status === 'written' ? 'confirmed' : item.status } : item);
      updated = await container.stores.artifactStore.updateArticleWithRevision({ article, baseRevision, operationId });
      await container.stores.artifactStore.commitVersion(article.id, invalidation.blockCount ? `编辑大纲章节并清空本节正文：${title}` : `编辑大纲章节：${title}`, 'user');
      await container.stores.workflowOperationStore.updateOperation({ ...runningOperation, status: 'completed', error: undefined, articleRevisionAfter: updated.revision, resultRef: updated.id });
      await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, sectionId, reason: 'outline-section-edited', invalidated: invalidation, userId, operationId }, createdAt: nowIso() });
    } catch (error) {
      await container.stores.workflowOperationStore.updateOperation({ ...runningOperation, status: 'failed', error: error instanceof Error ? error.message : String(error) });
      if (error instanceof ArticleRevisionConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
    const updatedArticle = await container.stores.artifactStore.getArticle(updated.id);
    return updatedArticle ? withWritingStandardSummary(updatedArticle) : updatedArticle;
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
      let applied: Awaited<ReturnType<typeof applyRevisionProposal>>;
      try {
        applied = await applyRevisionProposal(container, pendingProposal.id, userId, body.sessionId);
      } catch (error) {
        if (error instanceof RevisionProposalStaleError) return reply.code(409).send({ error: error.message });
        throw error;
      }
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: pendingProposal.contextKind, role: 'assistant', content: applied.message, proposalId: pendingProposal.id });
      await appendDialoguePiMessages(container, applied.article ?? access.article, userId, dialogueSessionTargetFromProposal(pendingProposal), [
        { role: 'user', content: message, proposalId: pendingProposal.id },
        { role: 'assistant', content: applied.message, proposalId: pendingProposal.id },
      ]);
      return { ...applied, messages: await listDialogueMessages(container, access.article.id, userId) };
    }
    if (pendingProposal && route === 'dismiss') {
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: pendingProposal.contextKind, role: 'user', content: message, proposalId: pendingProposal.id });
      const { proposal: dismissed, runPayload } = await dismissRevisionProposal(container, pendingProposal, userId);
      const assistantMessage = '已取消这次修改方案。';
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: pendingProposal.contextKind, role: 'assistant', content: assistantMessage, proposalId: pendingProposal.id });
      await appendDialoguePiMessages(container, access.article, userId, dialogueSessionTargetFromProposal(pendingProposal), [
        { role: 'user', content: message, proposalId: pendingProposal.id },
        { role: 'assistant', content: assistantMessage, proposalId: pendingProposal.id },
      ]);
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
      await appendDialoguePiMessages(container, access.article, userId, dialogueSessionTargetFromContext(context.value.context), [
        { role: 'user', content: message, proposalId: pendingProposal?.id },
        { role: 'assistant', content: assistantMessage, proposalId: pendingProposal?.id },
      ]);
      return { mode: route, message: assistantMessage, messages: await listDialogueMessages(container, access.article.id, userId) };
    }
    if (route === 'needs-rag') {
      const knowledgeAnswer = await answerWithKnowledge(container, access.article, context.value.context, message);
      await addKnowledgeEvidenceToBrief({ container, articleId: access.article.id, userId, query: knowledgeAnswer.query, items: knowledgeAnswer.items });
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'assistant', content: knowledgeAnswer.message, proposalId: pendingProposal?.id });
      await appendDialoguePiMessages(container, access.article, userId, dialogueSessionTargetFromContext(context.value.context), [
        { role: 'user', content: message, proposalId: pendingProposal?.id },
        { role: 'assistant', content: knowledgeAnswer.message, proposalId: pendingProposal?.id },
      ]);
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
      await appendDialoguePiMessages(container, access.article, userId, dialogueSessionTargetFromContext(context.value.context), [
        { role: 'user', content: message, proposalId: pendingProposal?.id },
        { role: 'assistant', content: assistantMessage, proposalId: pendingProposal?.id },
      ]);
      return { mode: 'clarify', message: assistantMessage, messages: await listDialogueMessages(container, access.article.id, userId) };
    }
    if (result.mode !== 'proposal') {
      await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'assistant', content: result.message, proposalId: pendingProposal?.id });
      await appendDialoguePiMessages(container, access.article, userId, dialogueSessionTargetFromContext(context.value.context), [
        { role: 'user', content: message, proposalId: pendingProposal?.id },
        { role: 'assistant', content: result.message, proposalId: pendingProposal?.id },
      ]);
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
    await appendDialoguePiMessages(container, access.article, userId, dialogueSessionTargetFromContext(context.value.context), [
      { role: 'user', content: message, proposalId: pendingProposal?.id },
      { role: 'assistant', content: result.message, proposalId: proposal.id },
    ]);
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
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const proposal = await container.stores.revisionProposalStore.getProposal(proposalId);
    if (!proposal || proposal.articleId !== articleId) return reply.code(404).send({ error: 'Revision proposal not found.' });
    let applied: Awaited<ReturnType<typeof applyRevisionProposal>>;
    try {
      applied = await applyRevisionProposal(container, proposal.id, userId, body.sessionId);
    } catch (error) {
      if (error instanceof RevisionProposalStaleError) return reply.code(409).send({ error: error.message });
      throw error;
    }
    await appendDialogueMessage(container, { articleId, userId, contextKind: proposal.contextKind, role: 'assistant', content: applied.message, proposalId: proposal.id });
    await appendDialoguePiMessages(container, applied.article ?? access.article, userId, dialogueSessionTargetFromProposal(proposal), [
      { role: 'assistant', content: applied.message, proposalId: proposal.id },
    ]);
    return { ...applied, messages: await listDialogueMessages(container, articleId, userId) };
  });
  app.post('/api/articles/:articleId/dialogue/:proposalId/dismiss', async (request, reply) => {
    const { articleId, proposalId } = request.params as { articleId: string; proposalId: string };
    const body = (request.body ?? {}) as { userId?: string };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const proposal = await container.stores.revisionProposalStore.getProposal(proposalId);
    if (!proposal || proposal.articleId !== articleId) return reply.code(404).send({ error: 'Revision proposal not found.' });
    if (proposal.userId !== userId) return reply.code(403).send({ error: 'Revision proposal belongs to another user.' });
    const { proposal: dismissed, runPayload } = await dismissRevisionProposal(container, proposal, userId);
    await appendDialogueMessage(container, { articleId, userId, contextKind: proposal.contextKind, role: 'assistant', content: '已取消这次修改提案。', proposalId: proposal.id });
    await appendDialoguePiMessages(container, access.article, userId, dialogueSessionTargetFromProposal(proposal), [
      { role: 'assistant', content: '已取消这次修改提案。', proposalId: proposal.id },
    ]);
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
    const body = (request.body ?? {}) as { userId?: string; sessionId?: string; workspaceId?: string; articleId?: string; message?: string; sectionId?: string; targetStage?: string; replaceExisting?: boolean; commentIds?: string[]; domainProfile?: DomainProfileSelectionRequest; writingStandard?: WritingStandardSelectionRequest };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const articleId = body.articleId?.trim();
    const articleAccess = articleId ? await requireArticleAccess(container, userId, articleId) : undefined;
    if (articleAccess && !articleAccess.ok) return reply.code(articleAccess.statusCode).send({ error: articleAccess.error });
    const workspaceId = articleAccess?.article.workspaceId ?? body.workspaceId?.trim() ?? (await ensureDefaultWorkspace(container, userId)).id;
    const workspace = await requireWorkspaceAccess(container, userId, workspaceId);
    if (!workspace) return reply.code(403).send({ error: 'Workspace access required.' });
    const pendingGateRun = articleAccess?.article ? await findPendingWorkflowHumanGateRun(container, articleAccess.article.id, userId) : undefined;
    if (pendingGateRun) return enrichRun(container, pendingGateRun.id);
    const pendingProposalRun = articleAccess?.article ? await findPendingWorkflowProposalRun(container, articleAccess.article.id, userId) : undefined;
    if (pendingProposalRun) {
      const message = body.message?.trim();
      if (message) {
        await appendWorkflowUserMessage(container, pendingProposalRun, message);
        await container.stores.eventTraceStore.append({ id: newId('evt'), runId: pendingProposalRun.id, type: 'pi.session.updated', payload: { userId, reason: 'workflow-user-message' }, createdAt: nowIso() });
        let refreshedProposalRun: (Awaited<ReturnType<typeof enrichRun>> & { messages?: DialogueMessage[] }) | undefined;
        try {
          refreshedProposalRun = await handleWorkflowPendingProposalMessage(container, pendingProposalRun, message, userId);
        } catch (error) {
          if (error instanceof RevisionProposalStaleError) return reply.code(409).send({ error: error.message });
          throw error;
        }
        if (refreshedProposalRun) return refreshedProposalRun;
      }
      return enrichRun(container, pendingProposalRun.id);
    }
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
      input: { message: body.message?.trim() || undefined, articleId, workspaceId, sectionId: body.sectionId?.trim() || undefined, targetStage: normalizeWorkflowTargetStage(body.targetStage), replaceExisting: body.replaceExisting === true, commentIds: normalizeCommentIds(body.commentIds), domainContext, writingStandard },
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
    if (body.decision !== 'accept' && body.decision !== 'reject') return reply.code(400).send({ error: 'decision must be accept or reject.' });
    if (gate.status !== 'pending') {
      const requestedStatus = body.decision === 'accept' ? 'accepted' : 'rejected';
      if (gate.status === requestedStatus && gate.resolvedByUserId === userId) return enrichRun(container, runId);
      return reply.code(400).send({ error: `Human gate is already ${gate.status}.` });
    }
    if (body.decision === 'reject') {
      const resolvedGate = await container.stores.humanGateStore.updateGate({ ...gate, status: 'rejected', resolvedByUserId: userId, resolvedAt: nowIso() });
      await container.stores.eventTraceStore.append({ id: newId('evt'), runId, type: 'human_gate.resolved', payload: { userId, gateId, decision: body.decision, articleId: gate.articleId, actionType: gate.actionType }, createdAt: nowIso() });
      await container.stores.stateStore.updateRun(runId, { status: 'waiting', waitingFor: { nodeId: 'human-gate', reason: '用户拒绝了当前确认项，需要新的指令。' }, state: { ...run.state, pendingHumanGateId: undefined, lastResolvedHumanGateId: resolvedGate.id }, updatedAt: nowIso() });
      return enrichRun(container, runId);
    }
    let gateResult: Record<string, unknown>;
    try {
      gateResult = await applyAcceptedHumanGate(container, gate, body.payload ?? {});
    } catch (error) {
      if (error instanceof HumanGateStaleError || error instanceof ArticleRevisionConflictError) {
        return supersedeStaleHumanGate(container, run, gate, userId, error);
      }
      throw error;
    }
    const resolvedGate = await container.stores.humanGateStore.updateGate({ ...gate, status: 'accepted', resolvedByUserId: userId, resolvedAt: nowIso() });
    await container.stores.eventTraceStore.append({ id: newId('evt'), runId, type: 'human_gate.resolved', payload: { userId, gateId, decision: body.decision, articleId: gate.articleId, actionType: gate.actionType }, createdAt: nowIso() });
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
    const body = (request.body ?? {}) as { userId?: string };
    const userId = readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const run = await container.stores.stateStore.getRun(runId);
    if (!run) return reply.code(404).send({ error: 'Run not found.' });
    if (run.metadata.userId !== userId) return reply.code(403).send({ error: 'Run belongs to another user.' });
    if (run.status === 'completed' || run.status === 'cancelled') return reply.code(400).send({ error: `Run is already ${run.status}.` });
    const now = nowIso();
    const pendingGates = await container.stores.humanGateStore.listGates({ runId, userId, statuses: ['pending'] });
    await Promise.all(pendingGates.map((gate) => container.stores.humanGateStore.updateGate({ ...gate, status: 'superseded', updatedAt: now })));
    await container.stores.stateStore.updateRun(runId, { status: 'cancelled', waitingFor: undefined, state: { ...run.state, pendingHumanGateId: undefined }, updatedAt: now });
    await container.stores.eventTraceStore.append({ id: newId('evt'), runId, type: 'workflow.failed', payload: { workflowId: run.workflowId, cancelled: true, userId, supersededGateIds: pendingGates.map((gate) => gate.id) }, createdAt: now });
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

type DialoguePiSessionTarget = { contextKind: DialogueContextKind; targetId?: string };
type DialoguePiMessage = { role: 'user' | 'assistant'; content: string; proposalId?: string };

async function appendDialoguePiMessages(container: AppContainer, article: ArticleArtifact, userId: string, target: DialoguePiSessionTarget, messages: DialoguePiMessage[]): Promise<void> {
  const existing = await container.stores.piAgentSessionStore.findSession({ userId, articleId: article.id, contextKind: target.contextKind, targetId: target.targetId });
  const now = nowIso();
  const serializedMessages = messages.map((message) => {
    const serialized: Record<string, string | number> = { role: message.role, content: message.content, timestamp: Date.now() };
    if (message.proposalId) serialized.proposalId = message.proposalId;
    return serialized;
  });
  const session = existing
    ? await container.stores.piAgentSessionStore.saveSession({
      ...existing,
      workspaceId: article.workspaceId,
      baseArticleRevision: article.revision,
      messages: [...existing.messages, ...serializedMessages],
      lockVersion: existing.lockVersion + 1,
      updatedAt: now,
    })
    : await container.stores.piAgentSessionStore.saveSession({
      id: newId('pi_ses'),
      userId,
      workspaceId: article.workspaceId,
      articleId: article.id,
      contextKind: target.contextKind,
      targetId: target.targetId,
      messages: serializedMessages,
      baseArticleRevision: article.revision,
      lockVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
  await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'pi.session.updated', payload: { userId, articleId: article.id, piAgentSessionId: session.id, contextKind: target.contextKind, targetId: target.targetId, reason: 'dialogue-turn' }, createdAt: nowIso() });
}

function dialogueSessionTargetFromContext(context: DialogueCoordinatorInput['context']): DialoguePiSessionTarget {
  return { contextKind: context.kind, targetId: context.outlineItemId ?? context.blockId };
}

function dialogueSessionTargetFromProposal(proposal: RevisionProposal): DialoguePiSessionTarget {
  return {
    contextKind: proposal.contextKind,
    targetId: proposal.operations.find((operation) => operation.type === 'revise-outline-item')?.outlineItemId
      ?? proposal.operations.find((operation) => operation.type === 'patch-block')?.blockId,
  };
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

async function findPendingWorkflowHumanGateRun(container: AppContainer, articleId: string, userId: string): Promise<WorkflowRun | undefined> {
  const gates = (await container.stores.humanGateStore.listGates({ articleId, userId, statuses: ['pending'] }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const gate of gates) {
    const run = await container.stores.stateStore.getRun(gate.runId);
    if (!run || run.workflowId !== WRITING_AUTOPILOT_POLICY.id) continue;
    if (run.metadata.userId !== userId || run.metadata.articleId !== articleId) continue;
    if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed') continue;
    return run;
  }
  return undefined;
}

async function findPendingWorkflowProposalRun(container: AppContainer, articleId: string, userId: string): Promise<WorkflowRun | undefined> {
  const proposals = (await container.stores.revisionProposalStore.listPendingProposals(articleId, userId))
    .filter((proposal) => proposal.runId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const proposal of proposals) {
    const run = proposal.runId ? await container.stores.stateStore.getRun(proposal.runId) : undefined;
    if (!run || run.metadata.userId !== userId) continue;
    if (run.status === 'completed' || run.status === 'cancelled') continue;
    if (run.state.pendingRevisionProposalId !== proposal.id) continue;
    return run;
  }
  return undefined;
}

async function handleWorkflowPendingProposalMessage(container: AppContainer, run: WorkflowRun, message: string, userId: string): Promise<(Awaited<ReturnType<typeof enrichRun>> & { messages?: DialogueMessage[] }) | undefined> {
  const pendingProposalId = typeof run.state.pendingRevisionProposalId === 'string' ? run.state.pendingRevisionProposalId : undefined;
  if (!pendingProposalId) return undefined;
  const proposal = await container.stores.revisionProposalStore.getProposal(pendingProposalId);
  if (!proposal || proposal.runId !== run.id) throw new Error('Pending workflow revision proposal not found.');
  if (proposal.userId !== userId || run.metadata.userId !== userId) throw new Error('Revision proposal belongs to another user.');
  if (proposal.status !== 'pending') throw new Error(`Revision proposal is already ${proposal.status}.`);

  const access = await requireArticleAccess(container, userId, proposal.articleId);
  if (!access.ok) throw new Error(access.error);
  try {
    await ensureDialogueBriefSettled(container, access.article.id, userId);
  } catch (error) {
    throw new Error(dialogueBriefBarrierError(error));
  }
  const context = resolveDialogueContext(access.article, dialogueContextRequestForProposal(proposal));
  if (!context.ok) throw new Error(context.error);
  const sessionId = typeof run.metadata.sessionId === 'string' ? run.metadata.sessionId : undefined;
  const userMessage = await appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'user', content: message, proposalId: proposal.id });
  await enqueueDialogueBriefUpdate({ container, article: access.article, userId, sessionId, message: userMessage, context: { kind: context.value.context.kind, title: context.value.context.title } });
  await appendDialoguePiMessages(container, access.article, userId, dialogueSessionTargetFromContext(context.value.context), [{ role: 'user', content: message, proposalId: proposal.id }]);

  const route = routeDialogueMessage(message, proposal);
  if (route === 'apply') {
    const applied = await applyRevisionProposal(container, proposal.id, userId, sessionId);
    await appendWorkflowProposalAssistantTurn(container, applied.article ?? access.article, userId, context.value.context, applied.message, proposal.id);
    return enrichRunWithDialogueMessages(container, run.id, access.article.id, userId);
  }
  if (route === 'dismiss') {
    const { runPayload } = await dismissRevisionProposal(container, proposal, userId);
    await appendWorkflowProposalAssistantTurn(container, access.article, userId, context.value.context, '已取消这次修改方案。', proposal.id);
    return { ...(runPayload ?? (await enrichRun(container, run.id))), messages: await listDialogueMessages(container, access.article.id, userId) };
  }
  if (route !== 'propose' && !(route === 'discuss' && isModificationIntent(message))) {
    const assistantMessage = workflowPendingProposalReply(route, context.value.context, proposal);
    await appendWorkflowProposalAssistantTurn(container, access.article, userId, context.value.context, assistantMessage, proposal.id);
    return enrichRunWithDialogueMessages(container, run.id, access.article.id, userId);
  }

  const conversation = buildCompactDialogueConversation(await listDialogueMessages(container, access.article.id, userId, 24));
  const conversationBrief = await getOrCreateDialogueBrief(container, access.article.id, userId);
  let result: DialogueCoordinatorOutput;
  try {
    result = await container.runtime.invokeSkill<DialogueCoordinatorInput, DialogueCoordinatorOutput>(
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
      { userId, sessionId, runId: run.id, articleId: access.article.id },
    );
  } catch (error) {
    if (!isDialogueCoordinatorRecoverableFailure(error)) throw error;
    const assistantMessage = '这次修改方案没有刷新成功，原方案仍保留。请把要合并的意见拆成更明确的一两条再发。';
    await appendWorkflowProposalAssistantTurn(container, access.article, userId, context.value.context, assistantMessage, proposal.id);
    return enrichRunWithDialogueMessages(container, run.id, access.article.id, userId);
  }
  if (result.mode !== 'proposal') {
    const assistantMessage = '这次输入没有形成新的修改方案，原方案仍保留。需要刷新方案时，请明确说明要新增、删除、替换或调整什么。';
    await appendWorkflowProposalAssistantTurn(container, access.article, userId, context.value.context, assistantMessage, proposal.id);
    return enrichRunWithDialogueMessages(container, run.id, access.article.id, userId);
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
  await appendWorkflowProposalAssistantTurn(container, access.article, userId, context.value.context, result.message, nextProposal.id);
  return enrichRunWithDialogueMessages(container, run.id, access.article.id, userId);
}

async function enrichRunWithDialogueMessages(container: AppContainer, runId: string, articleId: string, userId: string): Promise<Awaited<ReturnType<typeof enrichRun>> & { messages: DialogueMessage[] }> {
  return { ...(await enrichRun(container, runId)), messages: await listDialogueMessages(container, articleId, userId) };
}

async function appendWorkflowProposalAssistantTurn(container: AppContainer, article: ArticleArtifact, userId: string, context: DialogueCoordinatorInput['context'], content: string, proposalId: string): Promise<void> {
  await appendDialogueMessage(container, { articleId: article.id, userId, contextKind: context.kind, role: 'assistant', content, proposalId });
  await appendDialoguePiMessages(container, article, userId, dialogueSessionTargetFromContext(context), [{ role: 'assistant', content, proposalId }]);
}

function workflowPendingProposalReply(route: DialogueRoute, context: DialogueCoordinatorInput['context'], proposal: RevisionProposal): string {
  const suffix = route === 'answer' ? `如果只是解释「${context.title}」，请先处理当前方案后再继续。` : '请先应用、取消，或明确说“按以上意见更新方案”。';
  return `当前已有待确认修改方案「${proposal.summary}」，不会继续写入正文。${suffix}`;
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
    throw new RevisionProposalStaleError(article.revision, proposal.baseRevision);
  }
  let runPayload: Awaited<ReturnType<typeof enrichRun>> | undefined;
  for (const [operationIndex, operation] of proposal.operations.entries()) {
    const operationId = revisionProposalOperationId(proposal.id, operationIndex);
    const operationRecord = await container.stores.workflowOperationStore.startOperation({
      operationId,
      runId: proposal.runId,
      userId,
      articleId: article.id,
      toolName: revisionOperationToolName(operation),
      allowedActionId: proposal.id,
      argsHash: hashOperationArgs({ proposalId: proposal.id, operationIndex, operation }),
      articleRevisionBefore: article.revision,
    });
    if (operationRecord.status === 'completed') {
      const currentArticle = await container.stores.artifactStore.getArticle(article.id);
      if (!currentArticle) throw new Error('Article not found after completed revision operation.');
      article = currentArticle;
      continue;
    }
    let result: Awaited<ReturnType<typeof applyRevisionOperation>>;
    try {
      result = await applyRevisionOperation(container, article, operation, userId, sessionId, { baseRevision: article.revision, operationId });
      await container.stores.workflowOperationStore.updateOperation({ ...operationRecord, status: 'completed', error: undefined, articleRevisionAfter: result.article.revision, resultRef: result.article.id });
    } catch (error) {
      await container.stores.workflowOperationStore.updateOperation({ ...operationRecord, status: 'failed', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
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

function revisionProposalOperationId(proposalId: string, operationIndex: number): string {
  return `op_revision_proposal_${proposalId}_${operationIndex + 1}`;
}

function manualOutlineEditOperationId(articleId: string, sectionId: string, baseRevision: number, title: string, goal: string): string {
  return `op_manual_outline_${hashOperationArgs({ articleId, sectionId, baseRevision, title, goal }).slice(0, 24)}`;
}

function articleMutationOperationId(kind: string, args: Record<string, unknown>): string {
  return `op_article_${kind}_${hashOperationArgs(args).slice(0, 24)}`;
}

function parseBaseRevision(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

type AuditedArticleMutationResult =
  | { ok: true; article: ArticleArtifact }
  | { ok: false; statusCode: number; error: string };

async function applyAuditedArticleMutation(
  container: AppContainer,
  input: {
    article: ArticleArtifact;
    userId: string;
    baseRevision: number;
    operationId: string;
    toolName: string;
    allowedActionId: string;
    argsHash: string;
    resultRef?: string;
    eventPayload: Record<string, unknown>;
    mutate: (article: ArticleArtifact) => void;
  },
): Promise<AuditedArticleMutationResult> {
  const existingOperation = await container.stores.workflowOperationStore.getOperation(input.operationId);
  if (existingOperation?.status === 'completed') {
    const currentArticle = await container.stores.artifactStore.getArticle(input.article.id);
    if (!currentArticle) throw new Error('Article not found after completed article mutation.');
    return { ok: true, article: currentArticle };
  }
  if (existingOperation?.status === 'running') {
    return { ok: false, statusCode: 409, error: `Workflow operation is already running: ${input.operationId}` };
  }
  const operationInput = {
    operationId: input.operationId,
    userId: input.userId,
    articleId: input.article.id,
    toolName: input.toolName,
    allowedActionId: input.allowedActionId,
    argsHash: input.argsHash,
    articleRevisionBefore: input.baseRevision,
  };
  const runningOperation = existingOperation?.status === 'failed'
    ? await container.stores.workflowOperationStore.updateOperation({ ...existingOperation, ...operationInput, status: 'running', error: undefined })
    : await container.stores.workflowOperationStore.startOperation(operationInput);
  try {
    input.mutate(input.article);
    const updated = await container.stores.artifactStore.updateArticleWithRevision({ article: input.article, baseRevision: input.baseRevision, operationId: input.operationId });
    await container.stores.workflowOperationStore.updateOperation({ ...runningOperation, status: 'completed', error: undefined, articleRevisionAfter: updated.revision, resultRef: input.resultRef ?? updated.id });
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { ...input.eventPayload, operationId: input.operationId }, createdAt: nowIso() });
    return { ok: true, article: (await container.stores.artifactStore.getArticle(updated.id)) ?? updated };
  } catch (error) {
    await container.stores.workflowOperationStore.updateOperation({ ...runningOperation, status: 'failed', error: error instanceof Error ? error.message : String(error) });
    if (error instanceof ArticleRevisionConflictError) return { ok: false, statusCode: 409, error: error.message };
    throw error;
  }
}

function revisionOperationToolName(operation: RevisionOperation): string {
  return `apply_${operation.type}`;
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
      ...(shouldClearBlocking ? { consistencyBlockingReviewId: undefined, consistencyBlockingRevision: undefined, consistencyBlockingSignature: undefined } : {}),
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

async function applyRevisionOperation(container: AppContainer, article: ArticleArtifact, operation: RevisionOperation, userId: string, sessionId: string | undefined, write: { baseRevision: number; operationId: string }): Promise<{ article: ArticleArtifact; runPayload?: Awaited<ReturnType<typeof enrichRun>> }> {
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
    const updated = await container.stores.artifactStore.updateArticleWithRevision({ article, baseRevision: write.baseRevision, operationId: write.operationId });
    await container.stores.artifactStore.commitVersion(article.id, invalidation.outlineCount || invalidation.blockCount ? `修订任务卡并清空下游内容：${result.summary.slice(0, 80)}` : `修订任务卡：${result.summary.slice(0, 80)}`, 'user');
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, reason: 'task-card-revised', changedFields: result.changedFields, invalidated: invalidation, userId, operationId: write.operationId }, createdAt: nowIso() });
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
    const updated = await container.stores.artifactStore.updateArticleWithRevision({ article, baseRevision: write.baseRevision, operationId: write.operationId });
    await container.stores.artifactStore.commitVersion(article.id, invalidation.blockCount ? `修订大纲章节并清空本节正文：${result.summary.slice(0, 80)}` : `修订大纲章节：${result.summary.slice(0, 80)}`, 'user');
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, sectionId: operation.outlineItemId, reason: 'outline-section-revised', changedFields: result.changedFields, invalidated: invalidation, userId, operationId: write.operationId }, createdAt: nowIso() });
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
    const updated = await container.stores.artifactStore.updateArticleWithRevision({ article, baseRevision: write.baseRevision, operationId: write.operationId });
    await container.stores.artifactStore.commitVersion(article.id, invalidation.blockCount ? `修订大纲并清空正文：${result.summary.slice(0, 80)}` : `修订大纲：${result.summary.slice(0, 80)}`, 'user');
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, reason: 'outline-revised', changedFields: result.changedFields, warnings: result.warnings, invalidated: invalidation, userId, operationId: write.operationId }, createdAt: nowIso() });
    return { article: (await container.stores.artifactStore.getArticle(updated.id)) ?? updated };
  }
  const patchResult = await container.runtime.invokeSkill<PatchEditorInput, PatchEditorOutput>(
    'patch-editor',
    { articleId: article.id, blockId: operation.blockId, instruction: operation.instruction },
    { userId, sessionId, articleId: article.id, blockId: operation.blockId },
  );
  article.blocks = article.blocks.map((block) => block.id === patchResult.patch.blockId ? { ...block, text: patchResult.patch.after, updatedAt: nowIso(), status: 'draft' } : block);
  const updated = await container.stores.artifactStore.updateArticleWithRevision({ article, baseRevision: write.baseRevision, operationId: write.operationId });
  await container.stores.artifactStore.commitVersion(article.id, `应用局部修改：${patchResult.patch.instruction}`, 'agent');
  await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, blockId: operation.blockId, reason: 'dialogue-patch-applied', userId, operationId: write.operationId }, createdAt: nowIso() });
  if (sessionId) await container.stores.sessionStore.updateSession(sessionId, { currentArticleId: article.id, currentWorkspaceId: article.workspaceId, currentBlockId: operation.blockId });
  return { article: updated };
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

function normalizeCommentIds(value: string[] | undefined): string[] | undefined {
  const ids = [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))];
  return ids.length ? ids : undefined;
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
  assertHumanGateFresh(gate, article.revision);
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
  const operationId = `op_human_gate_${gate.id}`;
  const operation = await container.stores.workflowOperationStore.startOperation({
    operationId,
    runId: gate.runId,
    userId: gate.userId,
    articleId: article.id,
    toolName: 'human_gate_accept',
    allowedActionId: gate.id,
    argsHash: hashOperationArgs({ gateId: gate.id, targetKind: gate.targetKind, targetId: gate.targetId, actionType: gate.actionType, payload }),
    articleRevisionBefore: gate.baseRevision,
  });
  if (operation.status === 'completed') return { articleId: article.id, revision: article.revision, taskCardStatus: article.taskCard.status, operationId, idempotent: true };
  const taskCardPatch = readObject(payload.taskCardPatch) ?? readObject(payload.taskCard);
  const mergedTaskCard = taskCardPatch
    ? mergeDeep(article.taskCard as unknown as Record<string, unknown>, taskCardPatch) as unknown as WritingTaskCard
    : article.taskCard;
  try {
    mergedTaskCard.status = 'confirmed';
    mergedTaskCard.updatedAt = nowIso();
    article.taskCard = normalizeTaskCardPolicies(mergedTaskCard).taskCard;
    const updated = await container.stores.artifactStore.updateArticleWithRevision({
      article,
      baseRevision: gate.baseRevision ?? article.revision,
      operationId,
    });
    await container.stores.artifactStore.commitVersion(article.id, 'HumanGate 确认任务卡', 'user');
    await container.stores.workflowOperationStore.updateOperation({ ...operation, status: 'completed', error: undefined, articleRevisionAfter: updated.revision, resultRef: updated.id });
    await container.stores.eventTraceStore.append({ id: newId('evt'), runId: gate.runId, type: 'artifact.updated', payload: { articleId: article.id, reason: 'human-gate-task-card-confirmed', userId: gate.userId, gateId: gate.id, operationId }, createdAt: nowIso() });
    return { articleId: updated.id, revision: updated.revision, taskCardStatus: updated.taskCard?.status, operationId };
  } catch (error) {
    await container.stores.workflowOperationStore.updateOperation({ ...operation, status: 'failed', error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function supersedeStaleHumanGate(container: AppContainer, run: WorkflowRun, gate: HumanGate, userId: string, error: HumanGateStaleError | ArticleRevisionConflictError) {
  const now = nowIso();
  const currentRevision = error instanceof HumanGateStaleError ? error.currentRevision : error.actualRevision;
  const gateRevision = error instanceof HumanGateStaleError ? error.gateRevision : error.expectedRevision;
  await container.stores.humanGateStore.updateGate({ ...gate, status: 'superseded', resolvedByUserId: userId, resolvedAt: now });
  await container.stores.eventTraceStore.append({
    id: newId('evt'),
    runId: run.id,
    type: 'human_gate.resolved',
    payload: {
      userId,
      gateId: gate.id,
      decision: 'superseded',
      stale: true,
      articleId: gate.articleId,
      actionType: gate.actionType,
      currentRevision,
      gateRevision,
    },
    createdAt: now,
  });
  await container.stores.stateStore.updateRun(run.id, {
    status: 'waiting',
    waitingFor: { nodeId: 'human-gate', reason: '当前确认项已过期，文章内容已经变化。请重新发起确认或直接说明下一步修改。' },
    state: { ...run.state, pendingHumanGateId: undefined, staleHumanGateId: gate.id, staleHumanGateRevision: gateRevision, currentArticleRevision: currentRevision },
    updatedAt: now,
  });
  return enrichRun(container, run.id);
}

function assertHumanGateFresh(gate: HumanGate, currentRevision: number): void {
  if (typeof gate.baseRevision === 'number' && currentRevision !== gate.baseRevision) {
    throw new HumanGateStaleError(currentRevision, gate.baseRevision);
  }
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
    revision: article.revision,
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
