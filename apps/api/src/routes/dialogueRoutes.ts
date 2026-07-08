import { FastifyInstance, FastifyRequest } from 'fastify';
import { ArticleArtifact, ArticleBlock, DialogueMessage, KnowledgeItem, OutlineItem, RevisionProposal } from '@wa/core';
import type { DialogueCoordinatorInput, DialogueCoordinatorOutput } from '@wa/workflows';
import { AppContainer } from '../bootstrap';
import { addKnowledgeEvidenceToBrief, buildCompactDialogueConversation, compactDialogueBriefForPrompt, enqueueDialogueBriefUpdate, ensureDialogueBriefSettled, getDialogueBriefStatus, getOrCreateDialogueBrief } from '../dialogueBrief';

type DialogueContextRequest = { kind?: string; outlineItemId?: string; blockId?: string };
type DialogueRoute = 'apply' | 'dismiss' | 'answer' | 'clarify' | 'discuss' | 'needs-rag' | 'propose';

type ResolvedDialogueContext = {
  context: DialogueCoordinatorInput['context'];
  selectedOutlineItem?: OutlineItem;
  selectedBlock?: ArticleBlock;
};

type ArticleAccessResult =
  | { ok: true; article: ArticleArtifact }
  | { ok: false; statusCode: number; error: string };

type DialogueApplyResult = {
  mode: string;
  message: string;
  proposal: RevisionProposal;
  article?: ArticleArtifact | null;
  [key: string]: unknown;
};

type DialogueDismissResult = {
  proposal: RevisionProposal;
  runPayload?: Record<string, unknown>;
};

export interface DialogueRoutesDependencies {
  container: AppContainer;
  readRequestUserId(request: FastifyRequest, explicitUserId?: string): string | undefined;
  requireArticleAccess(container: AppContainer, userId: string, articleId: string): Promise<ArticleAccessResult>;
  routeDialogueMessage(message: string, pendingProposal?: RevisionProposal): DialogueRoute;
  resolveDialogueContext(article: ArticleArtifact, request?: DialogueContextRequest): { ok: true; value: ResolvedDialogueContext } | { ok: false; statusCode: number; error: string };
  refineDialogueRoute(container: AppContainer, article: ArticleArtifact, userId: string, sessionId: string | undefined, message: string, context: DialogueCoordinatorInput['context'], hasPendingProposal: boolean): Promise<DialogueRoute>;
  appendDialogueMessage(container: AppContainer, input: Omit<DialogueMessage, 'id' | 'createdAt'>): Promise<DialogueMessage>;
  appendDialoguePiMessages(container: AppContainer, article: ArticleArtifact, userId: string, target: { contextKind: DialogueCoordinatorInput['context']['kind']; targetId?: string }, messages: Array<{ role: 'user' | 'assistant'; content: string; proposalId?: string }>): Promise<void>;
  dialogueSessionTargetFromContext(context: DialogueCoordinatorInput['context']): { contextKind: DialogueCoordinatorInput['context']['kind']; targetId?: string };
  dialogueSessionTargetFromProposal(proposal: RevisionProposal): { contextKind: DialogueCoordinatorInput['context']['kind']; targetId?: string };
  listDialogueMessages(container: AppContainer, articleId: string, userId: string, limit?: number): Promise<DialogueMessage[]>;
  shouldUpdateDialogueBrief(route: DialogueRoute, message: string, pendingProposal?: RevisionProposal): boolean;
  localDialogueReply(route: DialogueRoute, context: DialogueCoordinatorInput['context'], article: ArticleArtifact, message: string, pendingProposal?: RevisionProposal): string;
  answerWithKnowledge(container: AppContainer, article: ArticleArtifact, context: DialogueCoordinatorInput['context'], message: string): Promise<{ message: string; query: string; items: KnowledgeItem[] }>;
  proposalForDialogue(proposal: RevisionProposal): DialogueCoordinatorInput['pendingProposal'];
  executeArticleProgramTool<I = unknown, O = unknown>(input: {
    container: AppContainer;
    article: ArticleArtifact;
    userId: string;
    sessionId?: string;
    target: { contextKind: DialogueCoordinatorInput['context']['kind']; targetId?: string };
    allowedTools: readonly string[];
    toolName: string;
    programInput: I;
    operationPrefix: string;
  }): Promise<O>;
  isDialogueCoordinatorRecoverableFailure(error: unknown): boolean;
  dialogueBriefBarrierError(error: unknown): string;
  applyRevisionProposal(container: AppContainer, proposalId: string, userId: string, sessionId?: string): Promise<DialogueApplyResult>;
  dismissRevisionProposal(container: AppContainer, proposal: RevisionProposal, userId: string): Promise<DialogueDismissResult>;
  syncWorkflowRunToRefreshedProposal(container: AppContainer, previousProposal: RevisionProposal, nextProposal: RevisionProposal): Promise<void>;
  isRevisionProposalStaleError(error: unknown): boolean;
}

export function registerDialogueRoutes(app: FastifyInstance, deps: DialogueRoutesDependencies): void {
  const { container } = deps;

  app.post('/api/articles/:articleId/dialogue', async (request, reply) => {
    const articleId = ((request.params as { articleId?: string }).articleId ?? '').trim();
    if (!articleId) return reply.code(400).send({ error: 'articleId is required.' });
    const body = (request.body ?? {}) as { message?: string; userId?: string; sessionId?: string; context?: DialogueContextRequest; pendingProposalId?: string };
    const message = body.message?.trim();
    if (!message) return reply.code(400).send({ error: 'Dialogue message is required.' });
    const userId = deps.readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await deps.requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    try {
      await ensureDialogueBriefSettled(container, access.article.id, userId);
    } catch (error) {
      return reply.code(409).send({ error: deps.dialogueBriefBarrierError(error), briefStatus: await getDialogueBriefStatus(container, access.article.id, userId) });
    }
    const pendingProposal = body.pendingProposalId ? await container.stores.revisionProposalStore.getProposal(body.pendingProposalId) : undefined;
    if (body.pendingProposalId && (!pendingProposal || pendingProposal.articleId !== access.article.id)) return reply.code(404).send({ error: 'Revision proposal not found.' });
    if (pendingProposal && pendingProposal.userId !== userId) return reply.code(403).send({ error: 'Revision proposal belongs to another user.' });
    if (pendingProposal && pendingProposal.status !== 'pending') return reply.code(400).send({ error: `Revision proposal is already ${pendingProposal.status}.` });
    let route = deps.routeDialogueMessage(message, pendingProposal);
    if (pendingProposal && route === 'apply') {
      await deps.appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: pendingProposal.contextKind, role: 'user', content: message, proposalId: pendingProposal.id });
      let applied: DialogueApplyResult;
      try {
        applied = await deps.applyRevisionProposal(container, pendingProposal.id, userId, body.sessionId);
      } catch (error) {
        if (deps.isRevisionProposalStaleError(error)) return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      await deps.appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: pendingProposal.contextKind, role: 'assistant', content: applied.message, proposalId: pendingProposal.id });
      await deps.appendDialoguePiMessages(container, applied.article ?? access.article, userId, deps.dialogueSessionTargetFromProposal(pendingProposal), [
        { role: 'user', content: message, proposalId: pendingProposal.id },
        { role: 'assistant', content: applied.message, proposalId: pendingProposal.id },
      ]);
      return { ...applied, messages: await deps.listDialogueMessages(container, access.article.id, userId) };
    }
    if (pendingProposal && route === 'dismiss') {
      await deps.appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: pendingProposal.contextKind, role: 'user', content: message, proposalId: pendingProposal.id });
      const { proposal: dismissed, runPayload } = await deps.dismissRevisionProposal(container, pendingProposal, userId);
      const assistantMessage = '已取消这次修改方案。';
      await deps.appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: pendingProposal.contextKind, role: 'assistant', content: assistantMessage, proposalId: pendingProposal.id });
      await deps.appendDialoguePiMessages(container, access.article, userId, deps.dialogueSessionTargetFromProposal(pendingProposal), [
        { role: 'user', content: message, proposalId: pendingProposal.id },
        { role: 'assistant', content: assistantMessage, proposalId: pendingProposal.id },
      ]);
      return { mode: 'answer', message: assistantMessage, proposal: dismissed, ...(runPayload ?? {}), messages: await deps.listDialogueMessages(container, access.article.id, userId) };
    }
    const context = deps.resolveDialogueContext(access.article, body.context);
    if (!context.ok) return reply.code(context.statusCode).send({ error: context.error });
    if (route === 'clarify') route = await deps.refineDialogueRoute(container, access.article, userId, body.sessionId, message, context.value.context, Boolean(pendingProposal));
    const userMessage = await deps.appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'user', content: message, proposalId: pendingProposal?.id });
    const conversation = await deps.listDialogueMessages(container, access.article.id, userId, 24);
    if (route === 'answer' || route === 'clarify' || route === 'discuss') {
      if (deps.shouldUpdateDialogueBrief(route, message, pendingProposal)) {
        await enqueueDialogueBriefUpdate({ container, article: access.article, userId, sessionId: body.sessionId, message: userMessage, context: { kind: context.value.context.kind, title: context.value.context.title } });
      }
      const assistantMessage = deps.localDialogueReply(route, context.value.context, access.article, message, pendingProposal);
      await deps.appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'assistant', content: assistantMessage, proposalId: pendingProposal?.id });
      await deps.appendDialoguePiMessages(container, access.article, userId, deps.dialogueSessionTargetFromContext(context.value.context), [
        { role: 'user', content: message, proposalId: pendingProposal?.id },
        { role: 'assistant', content: assistantMessage, proposalId: pendingProposal?.id },
      ]);
      return { mode: route, message: assistantMessage, messages: await deps.listDialogueMessages(container, access.article.id, userId) };
    }
    if (route === 'needs-rag') {
      const knowledgeAnswer = await deps.answerWithKnowledge(container, access.article, context.value.context, message);
      await addKnowledgeEvidenceToBrief({ container, articleId: access.article.id, userId, query: knowledgeAnswer.query, items: knowledgeAnswer.items });
      await deps.appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'assistant', content: knowledgeAnswer.message, proposalId: pendingProposal?.id });
      await deps.appendDialoguePiMessages(container, access.article, userId, deps.dialogueSessionTargetFromContext(context.value.context), [
        { role: 'user', content: message, proposalId: pendingProposal?.id },
        { role: 'assistant', content: knowledgeAnswer.message, proposalId: pendingProposal?.id },
      ]);
      return { mode: 'answer', message: knowledgeAnswer.message, messages: await deps.listDialogueMessages(container, access.article.id, userId) };
    }
    const conversationBrief = await getOrCreateDialogueBrief(container, access.article.id, userId);
    await enqueueDialogueBriefUpdate({ container, article: access.article, userId, sessionId: body.sessionId, message: userMessage, context: { kind: context.value.context.kind, title: context.value.context.title } });
    let result: DialogueCoordinatorOutput;
    try {
      const programInput: DialogueCoordinatorInput = {
        articleId: access.article.id,
        message,
        skipKnowledge: true,
        conversation: buildCompactDialogueConversation(conversation),
        conversationBrief: compactDialogueBriefForPrompt(conversationBrief),
        pendingProposal: pendingProposal ? deps.proposalForDialogue(pendingProposal) : undefined,
        context: context.value.context,
        taskCard: access.article.taskCard,
        outline: access.article.outline,
        selectedOutlineItem: context.value.selectedOutlineItem,
        selectedBlock: context.value.selectedBlock,
      };
      result = await deps.executeArticleProgramTool<DialogueCoordinatorInput, DialogueCoordinatorOutput>({
        container,
        article: access.article,
        userId,
        sessionId: body.sessionId,
        target: deps.dialogueSessionTargetFromContext(context.value.context),
        allowedTools: ['create_revision_proposal', 'ask_clarifying_question', 'answer'],
        toolName: 'create_revision_proposal',
        programInput,
        operationPrefix: 'dialogue_coordinator',
      });
    } catch (error) {
      if (!deps.isDialogueCoordinatorRecoverableFailure(error)) throw error;
      const assistantMessage = '这次修改范围较大，方案没有生成成功。请把要改的大纲项、要新增的情节或要删除的部分拆成更明确的一两条再发。';
      await deps.appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'assistant', content: assistantMessage, proposalId: pendingProposal?.id });
      await deps.appendDialoguePiMessages(container, access.article, userId, deps.dialogueSessionTargetFromContext(context.value.context), [
        { role: 'user', content: message, proposalId: pendingProposal?.id },
        { role: 'assistant', content: assistantMessage, proposalId: pendingProposal?.id },
      ]);
      return { mode: 'clarify', message: assistantMessage, messages: await deps.listDialogueMessages(container, access.article.id, userId) };
    }
    if (result.mode !== 'proposal') {
      await deps.appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'assistant', content: result.message, proposalId: pendingProposal?.id });
      await deps.appendDialoguePiMessages(container, access.article, userId, deps.dialogueSessionTargetFromContext(context.value.context), [
        { role: 'user', content: message, proposalId: pendingProposal?.id },
        { role: 'assistant', content: result.message, proposalId: pendingProposal?.id },
      ]);
      return { mode: result.mode, message: result.message, messages: await deps.listDialogueMessages(container, access.article.id, userId) };
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
    if (pendingProposal?.runId) await deps.syncWorkflowRunToRefreshedProposal(container, pendingProposal, proposal);
    await deps.appendDialogueMessage(container, { articleId: access.article.id, userId, contextKind: context.value.context.kind, role: 'assistant', content: result.message, proposalId: proposal.id });
    await deps.appendDialoguePiMessages(container, access.article, userId, deps.dialogueSessionTargetFromContext(context.value.context), [
      { role: 'user', content: message, proposalId: pendingProposal?.id },
      { role: 'assistant', content: result.message, proposalId: proposal.id },
    ]);
    return { mode: 'proposal', message: result.message, proposal, messages: await deps.listDialogueMessages(container, access.article.id, userId) };
  });

  app.get('/api/articles/:articleId/dialogue/brief', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const query = request.query as { userId?: string };
    const userId = deps.readRequestUserId(request, query.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await deps.requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    return getDialogueBriefStatus(container, articleId, userId);
  });

  app.get('/api/articles/:articleId/dialogue/messages', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const query = request.query as { userId?: string; limit?: string };
    const userId = deps.readRequestUserId(request, query.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await deps.requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;
    return deps.listDialogueMessages(container, articleId, userId, Number.isFinite(limit) ? limit : undefined);
  });

  app.get('/api/articles/:articleId/dialogue/proposals', async (request, reply) => {
    const { articleId } = request.params as { articleId: string };
    const query = request.query as { userId?: string };
    const userId = deps.readRequestUserId(request, query.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await deps.requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    return container.stores.revisionProposalStore.listPendingProposals(articleId, userId);
  });

  app.post('/api/articles/:articleId/dialogue/:proposalId/apply', async (request, reply) => {
    const { articleId, proposalId } = request.params as { articleId: string; proposalId: string };
    const body = (request.body ?? {}) as { userId?: string; sessionId?: string };
    const userId = deps.readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await deps.requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const proposal = await container.stores.revisionProposalStore.getProposal(proposalId);
    if (!proposal || proposal.articleId !== articleId) return reply.code(404).send({ error: 'Revision proposal not found.' });
    let applied: DialogueApplyResult;
    try {
      applied = await deps.applyRevisionProposal(container, proposal.id, userId, body.sessionId);
    } catch (error) {
      if (deps.isRevisionProposalStaleError(error)) return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    await deps.appendDialogueMessage(container, { articleId, userId, contextKind: proposal.contextKind, role: 'assistant', content: applied.message, proposalId: proposal.id });
    await deps.appendDialoguePiMessages(container, applied.article ?? access.article, userId, deps.dialogueSessionTargetFromProposal(proposal), [
      { role: 'assistant', content: applied.message, proposalId: proposal.id },
    ]);
    return { ...applied, messages: await deps.listDialogueMessages(container, articleId, userId) };
  });

  app.post('/api/articles/:articleId/dialogue/:proposalId/dismiss', async (request, reply) => {
    const { articleId, proposalId } = request.params as { articleId: string; proposalId: string };
    const body = (request.body ?? {}) as { userId?: string };
    const userId = deps.readRequestUserId(request, body.userId);
    if (!userId) return reply.code(400).send({ error: 'userId is required.' });
    const access = await deps.requireArticleAccess(container, userId, articleId);
    if (!access.ok) return reply.code(access.statusCode).send({ error: access.error });
    const proposal = await container.stores.revisionProposalStore.getProposal(proposalId);
    if (!proposal || proposal.articleId !== articleId) return reply.code(404).send({ error: 'Revision proposal not found.' });
    if (proposal.userId !== userId) return reply.code(403).send({ error: 'Revision proposal belongs to another user.' });
    const { proposal: dismissed, runPayload } = await deps.dismissRevisionProposal(container, proposal, userId);
    await deps.appendDialogueMessage(container, { articleId, userId, contextKind: proposal.contextKind, role: 'assistant', content: '已取消这次修改提案。', proposalId: proposal.id });
    await deps.appendDialoguePiMessages(container, access.article, userId, deps.dialogueSessionTargetFromProposal(proposal), [
      { role: 'assistant', content: '已取消这次修改提案。', proposalId: proposal.id },
    ]);
    return { mode: 'answer', message: '已取消这次修改提案。', proposal: dismissed, ...(runPayload ?? {}), messages: await deps.listDialogueMessages(container, articleId, userId) };
  });
}
