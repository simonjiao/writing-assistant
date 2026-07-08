import { AllowedAction, ArticleArtifact, OutlineItem, WorkflowRun, hashOperationArgs } from '@wa/core';
import { actionSkillBinding } from './product-skill';

export interface AllowedActionPlannerInput {
  run: WorkflowRun;
  article?: ArticleArtifact;
  pendingHumanGate?: boolean;
  requestedSectionId?: string;
}

export class AllowedActionPlanner {
  plan(input: AllowedActionPlannerInput): AllowedAction[] {
    if (input.pendingHumanGate) return [];
    const targetStage = readTargetStage(input.run.input);
    const article = input.article;
    if (!article) {
      return [this.action(input.run, 'create_task_intake', { reason: '当前运行还没有任务容器，需要立即保存用户输入。' })];
    }
    if (!article.taskCard) {
      return [this.action(input.run, 'refine_task_card', { article, reason: '当前任务已保存，但还缺少任务卡草稿，需要整理任务卡。' })];
    }
    if (article.taskCard.status !== 'confirmed') {
      return [this.action(input.run, 'ask_followup', { article, reason: '任务卡尚未确认，需要继续补充或等待用户确认。' })];
    }
    if (targetStage === 'task-card') return [];
    if (targetStage === 'outline' && article.outline.length && shouldReplaceExistingOutline(input.run)) {
      const approvedRevision = typeof input.run.state.outlineReplacementApprovedRevision === 'number' ? input.run.state.outlineReplacementApprovedRevision : undefined;
      if (approvedRevision !== article.revision) {
        return [this.action(input.run, 'request_human_gate', { article, reason: '重新生成大纲会覆盖当前大纲并清空已有正文，需要用户确认。', requiresHumanGate: true })];
      }
      return [this.action(input.run, 'plan_outline', { article, reason: '用户已确认覆盖当前大纲，重新生成大纲。' })];
    }
    if (!article.outline.length) {
      return [this.action(input.run, 'plan_outline', { article, reason: '任务卡已确认，尚未生成大纲。' })];
    }
    if (isCommentProcessingIntent(input.run.input)) {
      const commentTargets = writableCommentTargets(input.run, article);
      if (!commentTargets.length || hasProcessedCommentsForCurrentRevision(input.run, article)) return [];
      return [this.action(input.run, 'process_article_comments', {
        article,
        reason: `处理 ${commentTargets.length} 条正文批注。`,
        targetKind: 'article-comments',
        targetId: stableCommentTargetId(commentTargets.map((comment) => comment.id)),
      })];
    }
    if (targetStage === 'article' && article.outline.some((item) => item.status === 'draft')) {
      return [this.action(input.run, 'confirm_outline_for_writing', { article, reason: '用户开始写作，先确认当前大纲，随后再进入一致性检查和章节生成。' })];
    }
    if (this.needsConsistencyReview(input.run, article)) {
      return [this.action(input.run, 'review_task_card_outline_consistency', { article, reason: '任务卡或大纲内容变化后，需要先做一致性检查。' })];
    }
    const pendingReviewProposal = readPendingReviewProposal(input.run.state, article.revision);
    if (pendingReviewProposal) {
      return [this.action(input.run, 'create_revision_proposal', {
        article,
        reason: `根据审阅建议生成待确认修改方案：${pendingReviewProposal.summary}`,
        reviewArtifactId: pendingReviewProposal.reviewArtifactId,
        suggestionId: pendingReviewProposal.suggestionId,
        targetKind: pendingReviewProposal.targetKind,
        targetId: pendingReviewProposal.targetId,
      })];
    }
    if (targetStage === 'outline') return [];
    const section = this.nextWritableSection(article, input.requestedSectionId);
    if (section) {
      return [this.action(input.run, input.requestedSectionId ? 'write_section' : 'write_next_section', { article, section, reason: `下一步写作大纲项：${section.title}` })];
    }
    if (targetStage === 'section') return [];
    if (input.run.state.polishReportRevision === article.revision) return [];
    return [this.action(input.run, 'generate_polish_report', { article, reason: '所有大纲项均已有正文，可以生成整篇统稿报告。' })];
  }

  private needsConsistencyReview(run: WorkflowRun, article: ArticleArtifact): boolean {
    return run.state.consistencyReviewSignature !== consistencyReviewSignature(article);
  }

  private nextWritableSection(article: ArticleArtifact, requestedSectionId?: string): OutlineItem | undefined {
    const writtenSectionIds = new Set(article.blocks.map((block) => block.sectionId).filter((id): id is string => Boolean(id)));
    if (requestedSectionId) {
      const section = article.outline.find((item) => item.id === requestedSectionId);
      return section && section.status !== 'draft' && !writtenSectionIds.has(section.id) ? section : undefined;
    }
    return article.outline
      .slice()
      .sort((left, right) => left.order - right.order)
      .find((section) => section.status !== 'draft' && !writtenSectionIds.has(section.id));
  }

  private action(run: WorkflowRun, type: AllowedAction['type'], input: { article?: ArticleArtifact; section?: OutlineItem; reason: string; requiresHumanGate?: boolean; reviewArtifactId?: string; suggestionId?: string; targetKind?: string; targetId?: string }): AllowedAction {
    const baseRevision = input.article?.revision;
    const sectionId = input.section?.id;
    const skillBinding = actionSkillBinding(type);
    const operationId = stableActionId('op', { runId: run.id, workflowId: run.workflowId, type, articleId: input.article?.id, sectionId, reviewArtifactId: input.reviewArtifactId, suggestionId: input.suggestionId, targetKind: input.targetKind, targetId: input.targetId, baseRevision });
    return {
      id: stableActionId('act', { runId: run.id, type, articleId: input.article?.id, sectionId, reviewArtifactId: input.reviewArtifactId, suggestionId: input.suggestionId, targetKind: input.targetKind, targetId: input.targetId, baseRevision }),
      operationId,
      type,
      skillId: skillBinding.skillId,
      toolName: skillBinding.toolName,
      articleId: input.article?.id,
      sectionId,
      reviewArtifactId: input.reviewArtifactId,
      suggestionId: input.suggestionId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      baseRevision,
      requiresHumanGate: input.requiresHumanGate ?? false,
      reason: `${skillBinding.hint} ${input.reason}`,
    };
  }
}

export function consistencyReviewSignature(article: ArticleArtifact): string {
  return hashOperationArgs({
    taskCard: article.taskCard ? {
      topic: article.taskCard.topic,
      writingGoal: article.taskCard.writingGoal,
      audience: article.taskCard.audience,
      scope: article.taskCard.scope,
      structure: article.taskCard.structure,
      style: article.taskCard.style,
      constraints: article.taskCard.constraints,
      topRules: article.taskCard.topRules,
    } : undefined,
    outline: article.outline
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((item) => ({
        id: item.id,
        title: item.title,
        goal: item.goal,
        order: item.order,
        expectedBlocks: item.expectedBlocks,
        rhetoricalRole: item.rhetoricalRole,
        keySection: item.keySection,
        specialHandling: item.specialHandling,
        sourceHints: item.sourceHints,
        themeTags: item.themeTags,
      })),
  });
}

function stableActionId(prefix: string, value: unknown): string {
  return `${prefix}_${hashOperationArgs(value).slice(0, 24)}`;
}

function readTargetStage(input: unknown): 'task-card' | 'outline' | 'section' | 'article' {
  if (input && typeof input === 'object') {
    const value = (input as { targetStage?: unknown }).targetStage;
    if (value === 'task-card' || value === 'outline' || value === 'section' || value === 'article') return value;
  }
  return 'article';
}

function shouldReplaceExistingOutline(run: WorkflowRun): boolean {
  if (run.state.outlineResult) return false;
  return Boolean(run.input && typeof run.input === 'object' && (run.input as { replaceExisting?: unknown }).replaceExisting === true);
}

function readPendingReviewProposal(state: WorkflowRun['state'], articleRevision: number): { reviewArtifactId: string; suggestionId?: string; targetKind?: string; targetId?: string; summary: string } | undefined {
  const value = state.pendingReviewProposal;
  if (!value || typeof value !== 'object') return undefined;
  const proposal = value as { reviewArtifactId?: unknown; suggestionId?: unknown; targetKind?: unknown; targetId?: unknown; summary?: unknown; articleRevision?: unknown };
  if (proposal.articleRevision !== articleRevision) return undefined;
  if (typeof proposal.reviewArtifactId !== 'string') return undefined;
  return {
    reviewArtifactId: proposal.reviewArtifactId,
    suggestionId: typeof proposal.suggestionId === 'string' ? proposal.suggestionId : undefined,
    targetKind: typeof proposal.targetKind === 'string' ? proposal.targetKind : undefined,
    targetId: typeof proposal.targetId === 'string' ? proposal.targetId : undefined,
    summary: typeof proposal.summary === 'string' ? proposal.summary : '处理审阅建议',
  };
}

function writableCommentTargets(run: WorkflowRun, article: ArticleArtifact) {
  if (!isCommentProcessingIntent(run.input)) return [];
  const requestedIds = readRequestedCommentIds(run.input);
  const targets = (article.comments ?? []).filter((comment) => comment.status === 'open');
  return requestedIds.length ? targets.filter((comment) => requestedIds.includes(comment.id)) : targets;
}

function isCommentProcessingIntent(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const message = typeof (input as { message?: unknown }).message === 'string' ? (input as { message: string }).message : '';
  return /批注|注释|评论/.test(message) && /处理|解决|修订|应用|批量/.test(message);
}

function readRequestedCommentIds(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const value = (input as { commentIds?: unknown }).commentIds;
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
}

function hasProcessedCommentsForCurrentRevision(run: WorkflowRun, article: ArticleArtifact): boolean {
  const value = run.state.commentProcessResult;
  if (!value || typeof value !== 'object') return false;
  return (value as { articleRevision?: unknown }).articleRevision === article.revision;
}

function stableCommentTargetId(commentIds: string[]): string {
  return hashOperationArgs({ commentIds: [...commentIds].sort() }).slice(0, 24);
}
