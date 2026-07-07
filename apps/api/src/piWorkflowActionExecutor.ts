import {
  AgentRuntime,
  AllowedAction,
  ArticleArtifact,
  ArticleBlock,
  ExternalStores,
  hashOperationArgs,
  HumanGate,
  newId,
  nowIso,
  ReviewFinding,
  WorkflowActionExecutionInput,
  WorkflowActionExecutionResult,
  WorkflowActionExecutor,
  WorkflowOperation,
  WorkflowRun,
  WritingTaskCard,
} from '@wa/core';
import {
  normalizeTaskCardPolicies,
  OutlinePlannerInput,
  OutlinePlannerOutput,
  SectionWriterInput,
  SectionWriterOutput,
  TaskCardBuilderInput,
  TaskCardBuilderOutput,
} from '@wa/skills';

export class PiWorkflowActionExecutor implements WorkflowActionExecutor {
  constructor(private readonly deps: { stores: ExternalStores; runtime: AgentRuntime }) {}

  async execute(input: WorkflowActionExecutionInput): Promise<WorkflowActionExecutionResult> {
    const existing = await this.deps.stores.workflowOperationStore.getOperation(input.action.operationId);
    if (existing?.status === 'completed') return { summary: `Operation already completed: ${input.action.operationId}` };
    if (existing?.status === 'running') throw new Error(`Workflow operation is already running: ${input.action.operationId}`);
    const operation = await this.startOperation(input.run, input.action);
    await this.emitOperationEvent(input.run, input.action, 'workflow.operation.started');
    await this.emitOperationEvent(input.run, input.action, 'tool.started');
    try {
      const result = await this.executeAction(input.run, input.action);
      await this.completeOperation(operation, result.article);
      await this.emitOperationEvent(input.run, input.action, 'tool.completed');
      await this.emitOperationEvent(input.run, input.action, 'workflow.operation.completed');
      return result;
    } catch (error) {
      await this.failOperation(operation, error);
      await this.emitOperationEvent(input.run, input.action, 'tool.failed', { error: error instanceof Error ? error.message : String(error) });
      await this.emitOperationEvent(input.run, input.action, 'workflow.operation.failed', { error: error instanceof Error ? error.message : String(error) });
      await this.deps.stores.stateStore.updateRun(input.run.id, { status: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: nowIso() });
      throw error;
    }
  }

  private async executeAction(run: WorkflowRun, action: AllowedAction): Promise<WorkflowActionExecutionResult> {
    if (action.type === 'create_task_card_draft') return this.createTaskCardDraft(run, action);
    if (action.type === 'ask_followup') return this.requestTaskCardGate(run, action);
    if (action.type === 'plan_outline') return this.planOutline(run, action);
    if (action.type === 'review_task_card_outline_consistency') return this.reviewTaskCardOutlineConsistency(run, action);
    if (action.type === 'write_next_section' || action.type === 'write_section') return this.writeSection(run, action);
    if (action.type === 'generate_polish_report') return this.generatePolishReport(run, action);
    throw new Error(`Unsupported workflow action: ${action.type}`);
  }

  private async createTaskCardDraft(run: WorkflowRun, action: AllowedAction): Promise<WorkflowActionExecutionResult> {
    const rawRequirement = this.readRunMessage(run);
    const workspaceId = this.requireString(run.metadata.workspaceId, 'workspaceId');
    const result = await this.deps.runtime.invokeSkill<TaskCardBuilderInput, TaskCardBuilderOutput>(
      'task-card-builder',
      { rawRequirement, userId: run.metadata.userId, sessionId: run.metadata.sessionId, domainContext: (run.input as { domainContext?: TaskCardBuilderInput['domainContext'] }).domainContext, writingStandard: (run.input as { writingStandard?: TaskCardBuilderInput['writingStandard'] }).writingStandard },
      this.skillMeta(run),
    );
    const taskCard = normalizeTaskCardPolicies(result.taskCard, rawRequirement).taskCard;
    const article = await this.deps.stores.artifactStore.createArticle({ userId: run.metadata.userId, workspaceId, title: taskCard.topic, taskCard });
    await this.deps.stores.stateStore.updateRun(run.id, {
      metadata: { ...run.metadata, articleId: article.id, workspaceId },
      state: { ...run.state, taskCardResult: result, draftArticle: { articleId: article.id, workspaceId } },
      updatedAt: nowIso(),
    });
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'artifact.updated', payload: { articleId: article.id, workspaceId, reason: 'pi-task-card-draft-created', userId: run.metadata.userId }, createdAt: nowIso() });
    return { article, summary: result.summary };
  }

  private async requestTaskCardGate(run: WorkflowRun, action: AllowedAction): Promise<WorkflowActionExecutionResult> {
    const article = await this.requireArticle(action.articleId);
    const prompts = article.taskCard?.interactionMode.followUpPrompts ?? [];
    const gate = await this.createGate(run, action, {
      targetKind: 'task-card',
      targetId: article.taskCard?.id,
      question: prompts[0]?.question ?? '请确认任务卡，或继续补充需要修改的内容。',
      options: prompts[0]?.options?.length ? prompts[0].options.map((label, index) => ({ id: `option_${index + 1}`, label })) : [{ id: 'confirm', label: '确认任务卡' }],
      baseRevision: article.revision,
    });
    await this.deps.stores.stateStore.updateRun(run.id, { status: 'waiting', waitingFor: { nodeId: 'human-gate', reason: gate.question }, state: { ...run.state, pendingHumanGateId: gate.id }, updatedAt: nowIso() });
    return { article, summary: gate.question };
  }

  private async planOutline(run: WorkflowRun, action: AllowedAction): Promise<WorkflowActionExecutionResult> {
    const article = await this.requireArticle(action.articleId);
    const taskCard = this.requireTaskCard(article);
    this.requireBaseRevision(action, article);
    const result = await this.deps.runtime.invokeSkill<OutlinePlannerInput, OutlinePlannerOutput>(
      'outline-planner',
      { articleId: article.id, taskCard },
      this.skillMeta(run, article.id),
    );
    const updated = await this.deps.stores.artifactStore.updateArticleWithRevision({
      article: { ...article, outline: result.outline, blocks: [], citations: [], themeTags: [] },
      baseRevision: action.baseRevision as number,
      operationId: action.operationId,
    });
    await this.deps.stores.artifactStore.commitVersion(article.id, `pi 生成大纲：${result.summary.slice(0, 80)}`, 'agent');
    await this.deps.stores.stateStore.updateRun(run.id, { state: { ...run.state, outlineResult: result }, metadata: { ...run.metadata, articleId: article.id, workspaceId: article.workspaceId }, updatedAt: nowIso() });
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'artifact.updated', payload: { articleId: article.id, reason: 'pi-outline-planned', userId: run.metadata.userId }, createdAt: nowIso() });
    return { article: updated, summary: result.summary };
  }

  private async reviewTaskCardOutlineConsistency(run: WorkflowRun, action: AllowedAction): Promise<WorkflowActionExecutionResult> {
    const article = await this.requireArticle(action.articleId);
    const findings = consistencyFindings(article);
    const reviewArtifact = await this.deps.stores.reviewArtifactStore.createReviewArtifact({
      articleId: article.id,
      runId: run.id,
      type: 'consistency-review',
      baseRevision: article.revision,
      findings,
      suggestions: findings
        .filter((finding) => finding.severity !== 'info')
        .map((finding) => ({ id: newId('sug'), actionType: 'create_revision_proposal', targetKind: finding.targetKind, targetId: finding.targetId, summary: finding.message })),
    });
    await this.deps.stores.stateStore.updateRun(run.id, { state: { ...run.state, consistencyReviewRevision: article.revision, consistencyReviewId: reviewArtifact.id }, updatedAt: nowIso() });
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'review_artifact.created', payload: { articleId: article.id, reviewArtifactId: reviewArtifact.id, reviewType: reviewArtifact.type, userId: run.metadata.userId }, createdAt: nowIso() });
    return { article, summary: findings.some((finding) => finding.severity === 'blocking') ? '一致性检查发现阻断问题。' : '一致性检查完成。' };
  }

  private async writeSection(run: WorkflowRun, action: AllowedAction): Promise<WorkflowActionExecutionResult> {
    const article = await this.requireArticle(action.articleId);
    const taskCard = this.requireTaskCard(article);
    this.requireBaseRevision(action, article);
    const sectionId = this.requireString(action.sectionId, 'sectionId');
    const section = article.outline.find((item) => item.id === sectionId);
    if (!section) throw new Error(`Outline section not found: ${sectionId}`);
    if (section.status === 'draft') throw new Error('Outline section is still draft.');
    const result = await this.deps.runtime.invokeSkill<SectionWriterInput, SectionWriterOutput>(
      'section-writer',
      { articleId: article.id, section, taskCard },
      this.skillMeta(run, article.id),
    );
    const blocks = result.blocks?.length ? result.blocks : result.block ? [result.block] : [];
    if (!blocks.length) throw new Error('Section writer returned no blocks.');
    const updated = await this.deps.stores.artifactStore.updateArticleWithRevision({
      article: {
        ...article,
        blocks: article.blocks.filter((block) => block.sectionId !== sectionId).concat(blocks),
        outline: article.outline.map((item) => item.id === sectionId ? { ...item, status: 'written' as const } : item),
      },
      baseRevision: action.baseRevision as number,
      operationId: action.operationId,
    });
    await this.deps.stores.artifactStore.commitVersion(article.id, `pi 生成章节正文：${section.title}`, 'agent');
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'artifact.updated', payload: { articleId: article.id, reason: 'pi-section-written', sectionId, blockIds: blocks.map((block) => block.id), userId: run.metadata.userId }, createdAt: nowIso() });
    return { article: updated, summary: result.summary };
  }

  private async generatePolishReport(run: WorkflowRun, action: AllowedAction): Promise<WorkflowActionExecutionResult> {
    const article = await this.requireArticle(action.articleId);
    const findings = polishFindings(article);
    const reviewArtifact = await this.deps.stores.reviewArtifactStore.createReviewArtifact({
      articleId: article.id,
      runId: run.id,
      type: 'polish-report',
      baseRevision: article.revision,
      findings,
      suggestions: findings
        .filter((finding) => finding.severity !== 'info')
        .map((finding) => ({ id: newId('sug'), actionType: 'create_revision_proposal', targetKind: finding.targetKind, targetId: finding.targetId, summary: finding.message })),
    });
    await this.deps.stores.stateStore.updateRun(run.id, { state: { ...run.state, polishReportRevision: article.revision, polishReportId: reviewArtifact.id }, updatedAt: nowIso() });
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'review_artifact.created', payload: { articleId: article.id, reviewArtifactId: reviewArtifact.id, reviewType: reviewArtifact.type, userId: run.metadata.userId }, createdAt: nowIso() });
    return { article, summary: '统稿报告已生成。' };
  }

  private async startOperation(run: WorkflowRun, action: AllowedAction): Promise<WorkflowOperation> {
    return this.deps.stores.workflowOperationStore.startOperation({
      operationId: action.operationId,
      runId: run.id,
      userId: run.metadata.userId,
      articleId: action.articleId,
      toolName: action.type,
      allowedActionId: action.id,
      argsHash: hashOperationArgs({ action, input: run.input }),
      articleRevisionBefore: action.baseRevision,
    });
  }

  private async completeOperation(operation: WorkflowOperation, article?: ArticleArtifact): Promise<void> {
    await this.deps.stores.workflowOperationStore.updateOperation({ ...operation, status: 'completed', articleRevisionAfter: article?.revision, resultRef: article?.id });
  }

  private async failOperation(operation: WorkflowOperation, error: unknown): Promise<void> {
    await this.deps.stores.workflowOperationStore.updateOperation({ ...operation, status: 'failed', error: error instanceof Error ? error.message : String(error) });
  }

  private async emitOperationEvent(run: WorkflowRun, action: AllowedAction, type: 'workflow.operation.started' | 'workflow.operation.completed' | 'workflow.operation.failed' | 'tool.started' | 'tool.completed' | 'tool.failed', payload: Record<string, unknown> = {}): Promise<void> {
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type, payload: { ...payload, userId: run.metadata.userId, operationId: action.operationId, allowedActionId: action.id, actionType: action.type, articleId: action.articleId, sectionId: action.sectionId }, createdAt: nowIso() });
  }

  private async createGate(run: WorkflowRun, action: AllowedAction, input: Omit<HumanGate, 'id' | 'runId' | 'userId' | 'articleId' | 'actionType' | 'status' | 'createdAt' | 'updatedAt'> & { articleId?: string }): Promise<HumanGate> {
    const gate = await this.deps.stores.humanGateStore.createGate({
      runId: run.id,
      userId: run.metadata.userId,
      articleId: input.articleId ?? action.articleId,
      actionType: action.type,
      ...input,
    });
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'human_gate.created', payload: { userId: run.metadata.userId, gateId: gate.id, articleId: gate.articleId, actionType: gate.actionType }, createdAt: nowIso() });
    return gate;
  }

  private readRunMessage(run: WorkflowRun): string {
    const input = run.input as { message?: unknown; rawRequirement?: unknown };
    const message = typeof input.message === 'string' ? input.message.trim() : typeof input.rawRequirement === 'string' ? input.rawRequirement.trim() : '';
    if (!message) throw new Error('writing-autopilot requires input.message to create a task card draft.');
    return message;
  }

  private skillMeta(run: WorkflowRun, articleId?: string) {
    return { userId: run.metadata.userId, sessionId: run.metadata.sessionId, runId: run.id, workflowId: run.workflowId, articleId };
  }

  private async requireArticle(articleId: string | undefined): Promise<ArticleArtifact> {
    if (!articleId) throw new Error('articleId is required for this workflow action.');
    const article = await this.deps.stores.artifactStore.getArticle(articleId);
    if (!article) throw new Error(`Article not found: ${articleId}`);
    return article;
  }

  private requireTaskCard(article: ArticleArtifact): WritingTaskCard {
    if (!article.taskCard) throw new Error('Task card is required for this workflow action.');
    return article.taskCard;
  }

  private requireBaseRevision(action: AllowedAction, article: ArticleArtifact): void {
    if (typeof action.baseRevision !== 'number') throw new Error(`Action ${action.id} is missing baseRevision.`);
    if (action.baseRevision !== article.revision) throw new Error(`Action ${action.id} has stale baseRevision ${action.baseRevision}; current article revision is ${article.revision}.`);
  }

  private requireString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
    return value.trim();
  }
}

function consistencyFindings(article: ArticleArtifact): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  if (!article.taskCard) findings.push({ severity: 'blocking', targetKind: 'task-card', message: '缺少任务卡，无法检查大纲一致性。' });
  if (!article.outline.length) findings.push({ severity: 'blocking', targetKind: 'outline', message: '缺少大纲，无法开始正文写作。' });
  const avoidTerms = article.taskCard?.constraints.mustAvoid ?? [];
  const outlineText = article.outline.map((item) => `${item.title}\n${item.goal}\n${item.sourceHints.join('\n')}`).join('\n');
  for (const term of avoidTerms) {
    const trimmed = term.trim();
    if (trimmed && outlineText.includes(trimmed)) {
      findings.push({ severity: 'blocking', targetKind: 'outline', message: `大纲仍包含任务卡要求避免的表达：${trimmed}` });
    }
  }
  if (!findings.length) findings.push({ severity: 'info', targetKind: 'outline', message: '任务卡和大纲暂无明显冲突。' });
  return findings;
}

function polishFindings(article: ArticleArtifact): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const blocksBySection = new Map<string, ArticleBlock[]>();
  for (const block of article.blocks) if (block.sectionId) blocksBySection.set(block.sectionId, [...(blocksBySection.get(block.sectionId) ?? []), block]);
  for (const section of article.outline) {
    if (!blocksBySection.get(section.id)?.length) {
      findings.push({ severity: 'blocking', targetKind: 'outline-item', targetId: section.id, message: `大纲项「${section.title}」还没有正文。` });
    }
  }
  if (!findings.length) findings.push({ severity: 'info', targetKind: 'article', message: '所有大纲项均已有正文，可以进入人工统稿审阅。' });
  return findings;
}
