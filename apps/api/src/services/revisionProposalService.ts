import { ArticleArtifact, hashOperationArgs, newId, nowIso, RevisionOperation, RevisionProposal, WritingTaskCard } from '@wa/core';
import { normalizeTaskCardPolicies } from '@wa/skills';
import type { OutlineItemReviserOutput, OutlineReviserOutput, PatchEditorInput, PatchEditorOutput, TaskCardReviserOutput } from '@wa/skills';
import { AppContainer } from '../bootstrap';

export class RevisionProposalStaleError extends Error {
  constructor(currentRevision: number, proposalRevision: number) {
    super(`Revision proposal is stale: article revision is ${currentRevision}, proposal was created at ${proposalRevision}.`);
  }
}

type ArticleAccessResult =
  | { ok: true; article: ArticleArtifact }
  | { ok: false; statusCode: number; error: string };

type ArticleAgentTarget = { contextKind: 'task-card' | 'outline' | 'outline-item' | 'block'; targetId?: string };

type ExecuteArticleAgentSkill = <I = unknown, O = unknown>(input: {
  container: AppContainer;
  article: ArticleArtifact;
  userId: string;
  sessionId?: string;
  target: ArticleAgentTarget;
  allowedTools: readonly string[];
  toolName: string;
  skillId: string;
  skillInput: I;
  operationPrefix: string;
  operationId?: string;
  operationPayload?: unknown;
  blockId?: string;
}) => Promise<O>;

export interface RevisionProposalService {
  applyRevisionProposal(proposalId: string, userId: string, sessionId?: string): Promise<{
    mode: 'applied';
    message: string;
    proposal: RevisionProposal;
    article?: ArticleArtifact | null;
    [key: string]: unknown;
  }>;
  dismissRevisionProposal(proposal: RevisionProposal, userId: string): Promise<{ proposal: RevisionProposal; runPayload?: Record<string, unknown> }>;
  syncWorkflowRunToRefreshedProposal(previousProposal: RevisionProposal, nextProposal: RevisionProposal): Promise<void>;
}

export function createRevisionProposalService(deps: {
  container: AppContainer;
  requireArticleAccess(userId: string, articleId: string): Promise<ArticleAccessResult>;
  executeArticleAgentSkill: ExecuteArticleAgentSkill;
  enrichRun(runId: string): Promise<Record<string, unknown>>;
  withWritingStandardSummary(article: ArticleArtifact): ArticleArtifact;
  clearDownstreamForTaskCardChange(article: ArticleArtifact): { outlineCount: number; blockCount: number; citationCount: number; themeTagCount: number };
  clearAllBlocks(article: ArticleArtifact): { blockCount: number };
  clearBlocksForOutlineSections(article: ArticleArtifact, sectionIds: string[]): { blockCount: number };
}): RevisionProposalService {
  const { container } = deps;

  async function applyRevisionProposal(proposalId: string, userId: string, sessionId?: string) {
    const proposal = await container.stores.revisionProposalStore.getProposal(proposalId);
    if (!proposal) throw new Error('Revision proposal not found.');
    if (proposal.status !== 'pending') throw new Error(`Revision proposal is already ${proposal.status}.`);
    const access = await deps.requireArticleAccess(userId, proposal.articleId);
    if (!access.ok) throw new Error(access.error);
    let article = access.article;
    if (typeof proposal.baseRevision === 'number' && article.revision !== proposal.baseRevision) {
      throw new RevisionProposalStaleError(article.revision, proposal.baseRevision);
    }
    let runPayload: Record<string, unknown> | undefined;
    for (const [operationIndex, operation] of proposal.operations.entries()) {
      const operationId = revisionProposalOperationId(proposal.id, operationIndex);
      const operationRecord = await container.stores.agentOperationStore.startOperation({
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
        result = await applyRevisionOperation(article, operation, userId, sessionId, { baseRevision: article.revision, operationId });
        await container.stores.agentOperationStore.updateOperation({ ...operationRecord, status: 'completed', error: undefined, articleRevisionAfter: result.article.revision, resultRef: result.article.id });
      } catch (error) {
        await container.stores.agentOperationStore.updateOperation({ ...operationRecord, status: 'failed', error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      if (result.runPayload) runPayload = result.runPayload;
      article = result.article;
    }
    const applied = await container.stores.revisionProposalStore.updateProposal({ ...proposal, status: 'applied', appliedByUserId: userId });
    const articlePayload = await container.stores.artifactStore.getArticle(article.id);
    const workflowRunPayload = await syncWorkflowRunAfterProposal(applied, 'applied');
    const finalRunPayload = workflowRunPayload ?? runPayload;
    return {
      mode: 'applied' as const,
      message: finalRunPayload ? '修改已应用，工作流已继续推进。' : '修改已应用。',
      proposal: applied,
      article: articlePayload ? deps.withWritingStandardSummary(articlePayload) : articlePayload,
      ...(finalRunPayload ?? {}),
    };
  }

  async function dismissRevisionProposal(proposal: RevisionProposal, userId: string): Promise<{ proposal: RevisionProposal; runPayload?: Record<string, unknown> }> {
    if (proposal.userId !== userId) throw new Error('Revision proposal belongs to another user.');
    if (proposal.status !== 'pending') throw new Error(`Revision proposal is already ${proposal.status}.`);
    const dismissed = await container.stores.revisionProposalStore.updateProposal({ ...proposal, status: 'dismissed' });
    const runPayload = await syncWorkflowRunAfterProposal(dismissed, 'dismissed');
    return { proposal: dismissed, runPayload };
  }

  async function syncWorkflowRunToRefreshedProposal(previousProposal: RevisionProposal, nextProposal: RevisionProposal): Promise<void> {
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

  async function syncWorkflowRunAfterProposal(proposal: RevisionProposal, resolution: 'applied' | 'dismissed'): Promise<Record<string, unknown> | undefined> {
    if (!proposal.runId) return undefined;
    const run = await container.stores.stateStore.getRun(proposal.runId);
    if (!run) return undefined;
    if (run.metadata.userId !== proposal.userId) throw new Error('Workflow proposal belongs to another user.');
    if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed') return deps.enrichRun(run.id);
    if (run.state.pendingRevisionProposalId !== proposal.id) return deps.enrichRun(run.id);
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
    return deps.enrichRun(run.id);
  }

  async function applyRevisionOperation(article: ArticleArtifact, operation: RevisionOperation, userId: string, sessionId: string | undefined, write: { baseRevision: number; operationId: string }): Promise<{ article: ArticleArtifact; runPayload?: Record<string, unknown> }> {
    if (operation.type === 'revise-task-card') {
      if (!article.taskCard) throw new Error('Article has no task card to revise.');
      const skillInput = { articleId: article.id, instruction: operation.instruction, currentTaskCard: article.taskCard, skipKnowledge: true };
      const result = await deps.executeArticleAgentSkill<typeof skillInput, TaskCardReviserOutput>({
        container,
        article,
        userId,
        sessionId,
        target: { contextKind: 'task-card' },
        allowedTools: ['revise_task_card'],
        toolName: 'revise_task_card',
        skillId: 'task-card-reviser',
        skillInput,
        operationPrefix: 'revision_apply_task_card',
        operationId: `${write.operationId}_skill`,
        operationPayload: { writeOperationId: write.operationId, operation, skillInput },
      });
      const invalidation = deps.clearDownstreamForTaskCardChange(article);
      article.taskCard = normalizeTaskCardPolicies(result.taskCard as WritingTaskCard, operation.instruction).taskCard;
      article.title = result.taskCard.topic;
      const updated = await container.stores.artifactStore.updateArticleWithRevision({ article, baseRevision: write.baseRevision, operationId: write.operationId });
      await container.stores.artifactStore.commitVersion(article.id, invalidation.outlineCount || invalidation.blockCount ? `修订任务卡并清空下游内容：${result.summary.slice(0, 80)}` : `修订任务卡：${result.summary.slice(0, 80)}`, 'user');
      await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, reason: 'task-card-revised', changedFields: result.changedFields, invalidated: invalidation, userId, operationId: write.operationId }, createdAt: nowIso() });
      return { article: (await container.stores.artifactStore.getArticle(updated.id)) ?? updated };
    }
    if (operation.type === 'revise-outline-item') {
      const existing = article.outline.find((item) => item.id === operation.outlineItemId);
      if (!existing) throw new Error(`Outline section not found: ${operation.outlineItemId}`);
      const skillInput = { articleId: article.id, instruction: operation.instruction, currentOutlineItem: existing, taskCard: article.taskCard, articleOutline: article.outline };
      const result = await deps.executeArticleAgentSkill<typeof skillInput, OutlineItemReviserOutput>({
        container,
        article,
        userId,
        sessionId,
        target: { contextKind: 'outline-item', targetId: operation.outlineItemId },
        allowedTools: ['revise_outline_item'],
        toolName: 'revise_outline_item',
        skillId: 'outline-item-reviser',
        skillInput,
        operationPrefix: 'revision_apply_outline_item',
        operationId: `${write.operationId}_skill`,
        operationPayload: { writeOperationId: write.operationId, operation, skillInput },
      });
      const invalidation = deps.clearBlocksForOutlineSections(article, [operation.outlineItemId]);
      const revisedItem = { ...result.outlineItem, status: result.outlineItem.status === 'written' ? 'confirmed' as const : result.outlineItem.status };
      article.outline = article.outline.map((item) => item.id === operation.outlineItemId ? revisedItem : item);
      const updated = await container.stores.artifactStore.updateArticleWithRevision({ article, baseRevision: write.baseRevision, operationId: write.operationId });
      await container.stores.artifactStore.commitVersion(article.id, invalidation.blockCount ? `修订大纲章节并清空本节正文：${result.summary.slice(0, 80)}` : `修订大纲章节：${result.summary.slice(0, 80)}`, 'user');
      await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, sectionId: operation.outlineItemId, reason: 'outline-section-revised', changedFields: result.changedFields, invalidated: invalidation, userId, operationId: write.operationId }, createdAt: nowIso() });
      return { article: (await container.stores.artifactStore.getArticle(updated.id)) ?? updated };
    }
    if (operation.type === 'revise-outline') {
      const writtenSectionIds = [...new Set(article.blocks.map((block) => block.sectionId).filter((id): id is string => Boolean(id)))];
      const skillInput = { articleId: article.id, instruction: operation.instruction, taskCard: article.taskCard, currentOutline: article.outline, writtenSectionIds };
      const result = await deps.executeArticleAgentSkill<typeof skillInput, OutlineReviserOutput>({
        container,
        article,
        userId,
        sessionId,
        target: { contextKind: 'outline' },
        allowedTools: ['revise_outline'],
        toolName: 'revise_outline',
        skillId: 'outline-reviser',
        skillInput,
        operationPrefix: 'revision_apply_outline',
        operationId: `${write.operationId}_skill`,
        operationPayload: { writeOperationId: write.operationId, operation, skillInput },
      });
      const invalidation = deps.clearAllBlocks(article);
      article.outline = result.outline.map((item) => ({ ...item, status: item.status === 'written' ? 'confirmed' as const : item.status }));
      const updated = await container.stores.artifactStore.updateArticleWithRevision({ article, baseRevision: write.baseRevision, operationId: write.operationId });
      await container.stores.artifactStore.commitVersion(article.id, invalidation.blockCount ? `修订大纲并清空正文：${result.summary.slice(0, 80)}` : `修订大纲：${result.summary.slice(0, 80)}`, 'user');
      await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, reason: 'outline-revised', changedFields: result.changedFields, warnings: result.warnings, invalidated: invalidation, userId, operationId: write.operationId }, createdAt: nowIso() });
      return { article: (await container.stores.artifactStore.getArticle(updated.id)) ?? updated };
    }
    const skillInput: PatchEditorInput = { articleId: article.id, blockId: operation.blockId, instruction: operation.instruction };
    const patchResult = await deps.executeArticleAgentSkill<PatchEditorInput, PatchEditorOutput>({
      container,
      article,
      userId,
      sessionId,
      target: { contextKind: 'block', targetId: operation.blockId },
      allowedTools: ['patch_block'],
      toolName: 'patch_block',
      skillId: 'patch-editor',
      skillInput,
      operationPrefix: 'revision_apply_patch_block',
      operationId: `${write.operationId}_skill`,
      operationPayload: { writeOperationId: write.operationId, operation, skillInput },
      blockId: operation.blockId,
    });
    article.blocks = article.blocks.map((block) => block.id === patchResult.patch.blockId ? { ...block, text: patchResult.patch.after, updatedAt: nowIso(), status: 'draft' } : block);
    const updated = await container.stores.artifactStore.updateArticleWithRevision({ article, baseRevision: write.baseRevision, operationId: write.operationId });
    await container.stores.artifactStore.commitVersion(article.id, `应用局部修改：${patchResult.patch.instruction}`, 'agent');
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'artifact.updated', payload: { articleId: article.id, blockId: operation.blockId, reason: 'dialogue-patch-applied', userId, operationId: write.operationId }, createdAt: nowIso() });
    if (sessionId) await container.stores.sessionStore.updateSession(sessionId, { currentArticleId: article.id, currentWorkspaceId: article.workspaceId, currentBlockId: operation.blockId });
    return { article: updated };
  }

  return {
    applyRevisionProposal,
    dismissRevisionProposal,
    syncWorkflowRunToRefreshedProposal,
  };
}

function revisionProposalOperationId(proposalId: string, operationIndex: number): string {
  return `op_revision_proposal_${proposalId}_${operationIndex + 1}`;
}

function revisionOperationToolName(operation: RevisionOperation): string {
  return `apply_${operation.type}`;
}
