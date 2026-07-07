import {
  AllowedAction,
  AllowedActionType,
  ArticleArtifact,
  OutlineItem,
  WorkflowRun,
} from './types';
import { hashOperationArgs } from './workflow-state';

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
      return [this.action(input.run, 'create_task_card_draft', { reason: '当前运行还没有文章草稿，需要先创建任务卡草稿。' })];
    }
    if (!article.taskCard) {
      return [this.action(input.run, 'create_task_card_draft', { article, reason: '当前文章缺少任务卡，需要补建任务卡草稿。' })];
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
    if (this.needsConsistencyReview(input.run, article)) {
      return [this.action(input.run, 'review_task_card_outline_consistency', { article, reason: '任务卡或大纲 revision 变化后，需要先做一致性检查。' })];
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
    return run.state.consistencyReviewRevision !== article.revision;
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

  private action(run: WorkflowRun, type: AllowedActionType, input: { article?: ArticleArtifact; section?: OutlineItem; reason: string; requiresHumanGate?: boolean }): AllowedAction {
    const baseRevision = input.article?.revision;
    const sectionId = input.section?.id;
    const operationId = stableActionId('op', { runId: run.id, workflowId: run.workflowId, type, articleId: input.article?.id, sectionId, baseRevision });
    return {
      id: stableActionId('act', { runId: run.id, type, articleId: input.article?.id, sectionId, baseRevision }),
      operationId,
      type,
      articleId: input.article?.id,
      sectionId,
      baseRevision,
      requiresHumanGate: input.requiresHumanGate ?? false,
      reason: input.reason,
    };
  }
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
