import {
  AllowedAction,
  AllowedActionType,
  ArticleArtifact,
  ArticleBlock,
  consistencyReviewSignature,
  ExternalStores,
  hashOperationArgs,
  HumanGate,
  newId,
  nowIso,
  ReviewFinding,
  ReviewArtifact,
  RevisionOperation,
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
import { AgentToolExecutor } from './agent/agentToolExecutor';
import { AgentSessionTarget, getOrCreateAgentSession } from './agent/agentSessionTarget';
import { processArticleComments } from './articleComments';

type WorkflowActionHandler = (run: WorkflowRun, action: AllowedAction) => Promise<WorkflowActionExecutionResult>;
type WorkflowToolRegistry = Readonly<Record<AllowedActionType, WorkflowActionHandler>>;

export class PiWorkflowActionExecutor implements WorkflowActionExecutor {
  private readonly tools: WorkflowToolRegistry;

  constructor(private readonly deps: { stores: ExternalStores; agentToolExecutor: AgentToolExecutor }) {
    this.tools = {
      create_task_card_draft: this.createTaskCardDraft.bind(this),
      ask_followup: this.requestTaskCardGate.bind(this),
      plan_outline: this.planOutline.bind(this),
      confirm_outline_for_writing: this.confirmOutlineForWriting.bind(this),
      request_human_gate: this.requestHumanGate.bind(this),
      review_task_card_outline_consistency: this.reviewTaskCardOutlineConsistency.bind(this),
      create_revision_proposal: this.createRevisionProposal.bind(this),
      write_next_section: this.writeSection.bind(this),
      write_section: this.writeSection.bind(this),
      process_article_comments: this.processArticleComments.bind(this),
      generate_polish_report: this.generatePolishReport.bind(this),
    };
  }

  async execute(input: WorkflowActionExecutionInput): Promise<WorkflowActionExecutionResult> {
    await this.assertAuthorizedAction(input.run, input.action);
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
    return this.tools[action.type](run, action);
  }

  private async createTaskCardDraft(run: WorkflowRun, action: AllowedAction): Promise<WorkflowActionExecutionResult> {
    const rawRequirement = this.readRunMessage(run);
    const workspaceId = this.requireString(run.metadata.workspaceId, 'workspaceId');
    await this.requireWorkspaceAccess(run, workspaceId);
    const skillInput: TaskCardBuilderInput = { rawRequirement, userId: run.metadata.userId, sessionId: run.metadata.sessionId, domainContext: (run.input as { domainContext?: TaskCardBuilderInput['domainContext'] }).domainContext, writingStandard: (run.input as { writingStandard?: TaskCardBuilderInput['writingStandard'] }).writingStandard };
    const result = await this.executeWorkflowSkill<TaskCardBuilderInput, TaskCardBuilderOutput>(run, action, {
      toolName: 'build_task_card_draft',
      skillId: 'task-card-builder',
      skillInput,
    });
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
    const skillInput: OutlinePlannerInput = { articleId: article.id, taskCard };
    const result = await this.executeWorkflowSkill<OutlinePlannerInput, OutlinePlannerOutput>(run, action, {
      article,
      toolName: 'plan_outline',
      skillId: 'outline-planner',
      skillInput,
    });
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

  private async confirmOutlineForWriting(run: WorkflowRun, action: AllowedAction): Promise<WorkflowActionExecutionResult> {
    const article = await this.requireArticle(action.articleId);
    this.requireBaseRevision(action, article);
    const hasDraftOutline = article.outline.some((item) => item.status === 'draft');
    if (!hasDraftOutline) return { article, summary: '当前大纲已可写作。' };
    const updated = await this.deps.stores.artifactStore.updateArticleWithRevision({
      article: {
        ...article,
        outline: article.outline.map((item) => item.status === 'draft' ? { ...item, status: 'confirmed' as const } : item),
      },
      baseRevision: action.baseRevision as number,
      operationId: action.operationId,
    });
    await this.deps.stores.artifactStore.commitVersion(article.id, 'pi 确认大纲并开始写作', 'agent');
    await this.deps.stores.stateStore.updateRun(run.id, {
      state: { ...run.state, finalizedOutline: { articleId: article.id, articleRevision: updated.revision } },
      metadata: { ...run.metadata, articleId: article.id, workspaceId: article.workspaceId },
      updatedAt: nowIso(),
    });
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'artifact.updated', payload: { articleId: article.id, reason: 'pi-outline-confirmed-for-writing', outlineCount: updated.outline.length, userId: run.metadata.userId }, createdAt: nowIso() });
    return { article: updated, summary: '已确认大纲，开始写作。' };
  }

  private async requestHumanGate(run: WorkflowRun, action: AllowedAction): Promise<WorkflowActionExecutionResult> {
    const article = await this.requireArticle(action.articleId);
    if (!article.outline.length) throw new Error('Outline overwrite gate requires an existing outline.');
    const gate = await this.createGate(run, action, {
      targetKind: 'outline',
      question: `重新生成大纲会替换当前 ${article.outline.length} 个大纲项，并清空已经生成的 ${article.blocks.length} 段正文。确认继续？`,
      options: [
        { id: 'replace_outline', label: '确认重新生成' },
        { id: 'keep_outline', label: '保留当前大纲' },
      ],
      baseRevision: article.revision,
    });
    await this.deps.stores.stateStore.updateRun(run.id, { status: 'waiting', waitingFor: { nodeId: 'human-gate', reason: gate.question }, state: { ...run.state, pendingHumanGateId: gate.id }, updatedAt: nowIso() });
    return { article, summary: gate.question };
  }

  private async reviewTaskCardOutlineConsistency(run: WorkflowRun, action: AllowedAction): Promise<WorkflowActionExecutionResult> {
    const article = await this.requireArticle(action.articleId);
    const reviewSignature = consistencyReviewSignature(article);
    const findings = consistencyFindings(article);
    const hasBlockingFindings = findings.some((finding) => finding.severity === 'blocking');
    const suggestions = findings
      .filter((finding) => finding.severity !== 'info')
      .map((finding) => ({ id: newId('sug'), actionType: 'create_revision_proposal', targetKind: finding.targetKind, targetId: finding.targetId, summary: finding.message }));
    const reviewArtifact = await this.deps.stores.reviewArtifactStore.createReviewArtifact({
      articleId: article.id,
      runId: run.id,
      type: 'consistency-review',
      baseRevision: article.revision,
      findings,
      suggestions,
    });
    const firstSuggestion = suggestions[0];
    await this.deps.stores.stateStore.updateRun(run.id, {
      status: run.status,
      waitingFor: run.waitingFor,
      state: {
        ...run.state,
        consistencyReviewRevision: article.revision,
        consistencyReviewSignature: reviewSignature,
        consistencyReviewId: reviewArtifact.id,
        consistencyBlockingReviewId: hasBlockingFindings ? reviewArtifact.id : undefined,
        consistencyBlockingRevision: hasBlockingFindings ? article.revision : undefined,
        consistencyBlockingSignature: hasBlockingFindings ? reviewSignature : undefined,
        pendingReviewProposal: hasBlockingFindings && firstSuggestion ? {
          articleRevision: article.revision,
          consistencyReviewSignature: reviewSignature,
          reviewArtifactId: reviewArtifact.id,
          suggestionId: firstSuggestion.id,
          targetKind: firstSuggestion.targetKind,
          targetId: firstSuggestion.targetId,
          summary: firstSuggestion.summary,
        } : undefined,
      },
      updatedAt: nowIso(),
    });
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'review_artifact.created', payload: { articleId: article.id, reviewArtifactId: reviewArtifact.id, reviewType: reviewArtifact.type, userId: run.metadata.userId }, createdAt: nowIso() });
    return { article, summary: hasBlockingFindings ? '一致性检查发现阻断问题。' : '一致性检查完成。' };
  }

  private async createRevisionProposal(run: WorkflowRun, action: AllowedAction): Promise<WorkflowActionExecutionResult> {
    const article = await this.requireArticle(action.articleId);
    this.requireBaseRevision(action, article);
    const reviewArtifactId = this.requireString(action.reviewArtifactId, 'reviewArtifactId');
    const reviewArtifact = await this.deps.stores.reviewArtifactStore.getReviewArtifact(reviewArtifactId);
    if (!reviewArtifact || reviewArtifact.runId !== run.id || reviewArtifact.articleId !== article.id) {
      throw new Error(`Review artifact not found for workflow action: ${reviewArtifactId}`);
    }
    const operations = revisionOperationsForReview(reviewArtifact);
    if (!operations.length) throw new Error('Review artifact has no actionable revision suggestions.');
    const summary = revisionProposalSummary(reviewArtifact);
    const proposal = await this.deps.stores.revisionProposalStore.createProposal({
      articleId: article.id,
      userId: run.metadata.userId,
      runId: run.id,
      authorUserId: run.metadata.userId,
      baseRevision: article.revision,
      contextKind: revisionProposalContextKind(reviewArtifact),
      summary,
      message: reviewArtifact.type === 'polish-report' ? '已根据统稿报告生成待确认修改方案，确认后才会写入正文。' : '已根据一致性检查生成待确认修改方案，应用后再继续写作。',
      operations,
      warnings: actionableReviewFindings(reviewArtifact).map((finding) => finding.message),
    });
    await this.deps.stores.stateStore.updateRun(run.id, {
      status: 'waiting',
      waitingFor: { nodeId: 'revision-proposal', reason: '已生成待确认修改方案，请先应用或取消后再继续写作。' },
      state: {
        ...run.state,
        pendingReviewProposal: undefined,
        pendingRevisionProposalId: proposal.id,
        pendingRevisionProposalRevision: article.revision,
      },
      updatedAt: nowIso(),
    });
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'revision_proposal.created', payload: { articleId: article.id, proposalId: proposal.id, reviewArtifactId, userId: run.metadata.userId }, createdAt: nowIso() });
    return { article, summary };
  }

  private async writeSection(run: WorkflowRun, action: AllowedAction): Promise<WorkflowActionExecutionResult> {
    const article = await this.requireArticle(action.articleId);
    const taskCard = this.requireTaskCard(article);
    this.requireBaseRevision(action, article);
    const sectionId = this.requireString(action.sectionId, 'sectionId');
    const section = article.outline.find((item) => item.id === sectionId);
    if (!section) throw new Error(`Outline section not found: ${sectionId}`);
    if (section.status === 'draft') throw new Error('Outline section is still draft.');
    const skillInput: SectionWriterInput = { articleId: article.id, section, taskCard };
    const result = await this.executeWorkflowSkill<SectionWriterInput, SectionWriterOutput>(run, action, {
      article,
      toolName: 'write_section',
      skillId: 'section-writer',
      skillInput,
    });
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

  private async processArticleComments(run: WorkflowRun, action: AllowedAction): Promise<WorkflowActionExecutionResult> {
    const article = await this.requireArticle(action.articleId);
    this.requireBaseRevision(action, article);
    const result = await processArticleComments(this.deps, article, run.metadata.userId, {
      sessionId: typeof run.metadata.sessionId === 'string' ? run.metadata.sessionId : undefined,
      commentIds: readCommentIds(run.input),
      runId: run.id,
      baseRevision: action.baseRevision as number,
      operationId: action.operationId,
    });
    const revised = result.results.filter((item) => item.action === 'revise' && item.changed).length;
    const explained = result.results.filter((item) => item.action === 'explain').length;
    const questions = result.results.filter((item) => item.action === 'ask').length;
    await this.deps.stores.stateStore.updateRun(run.id, {
      state: {
        ...run.state,
        commentProcessResult: {
          articleRevision: result.article.revision,
          processedCount: result.results.length,
          revised,
          explained,
          questions,
        },
      },
      updatedAt: nowIso(),
    });
    return { article: result.article, summary: result.results.length ? `已处理 ${result.results.length} 条批注：修订 ${revised} 条，解释 ${explained} 条，追问 ${questions} 条。` : '没有可处理批注。' };
  }

  private async generatePolishReport(run: WorkflowRun, action: AllowedAction): Promise<WorkflowActionExecutionResult> {
    const article = await this.requireArticle(action.articleId);
    const findings = polishFindings(article);
    const hasActionableFindings = findings.some((finding) => finding.severity !== 'info');
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
    const firstSuggestion = reviewArtifact.suggestions[0];
    await this.deps.stores.stateStore.updateRun(run.id, {
      state: {
        ...run.state,
        polishReportRevision: article.revision,
        polishReportId: reviewArtifact.id,
        pendingReviewProposal: hasActionableFindings && firstSuggestion ? {
          articleRevision: article.revision,
          reviewArtifactId: reviewArtifact.id,
          suggestionId: firstSuggestion.id,
          targetKind: firstSuggestion.targetKind,
          targetId: firstSuggestion.targetId,
          summary: firstSuggestion.summary,
        } : undefined,
      },
      updatedAt: nowIso(),
    });
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'review_artifact.created', payload: { articleId: article.id, reviewArtifactId: reviewArtifact.id, reviewType: reviewArtifact.type, userId: run.metadata.userId }, createdAt: nowIso() });
    return { article, summary: '统稿报告已生成。' };
  }

  private async startOperation(run: WorkflowRun, action: AllowedAction): Promise<WorkflowOperation> {
    return this.deps.stores.workflowOperationStore.startOperation({
      operationId: action.operationId,
      runId: run.id,
      userId: run.metadata.userId,
      workspaceId: typeof run.metadata.workspaceId === 'string' ? run.metadata.workspaceId : undefined,
      articleId: action.articleId,
      contextKind: 'workflow',
      targetId: run.id,
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

  private async executeWorkflowSkill<I = unknown, O = unknown>(run: WorkflowRun, action: AllowedAction, input: {
    article?: ArticleArtifact;
    toolName: string;
    skillId: string;
    skillInput: I;
    blockId?: string;
  }): Promise<O> {
    const sessionTarget = this.workflowAgentSessionTarget(run, input.article);
    const { session } = await getOrCreateAgentSession(this.deps.stores, sessionTarget);
    return this.deps.agentToolExecutor.executeSkillTool<I, O>({
      agentSession: session,
      allowedTools: [input.toolName],
      toolName: input.toolName,
      skillId: input.skillId,
      input: input.skillInput,
      operationId: `${action.operationId}_skill`,
      sessionId: typeof run.metadata.sessionId === 'string' ? run.metadata.sessionId : undefined,
      runId: run.id,
      workflowId: run.workflowId,
      articleId: input.article?.id,
      blockId: input.blockId,
    });
  }

  private workflowAgentSessionTarget(run: WorkflowRun, article?: ArticleArtifact): AgentSessionTarget {
    const workspaceId = article?.workspaceId ?? (typeof run.metadata.workspaceId === 'string' ? run.metadata.workspaceId : undefined);
    if (!workspaceId) throw new Error('workspaceId is required for workflow agent session.');
    return {
      userId: run.metadata.userId,
      runId: run.id,
      workspaceId,
      articleId: article?.id ?? (typeof run.metadata.articleId === 'string' ? run.metadata.articleId : undefined),
      contextKind: 'workflow',
      targetId: run.id,
    };
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

  private async requireArticle(articleId: string | undefined): Promise<ArticleArtifact> {
    if (!articleId) throw new Error('articleId is required for this workflow action.');
    const article = await this.deps.stores.artifactStore.getArticle(articleId);
    if (!article) throw new Error(`Article not found: ${articleId}`);
    return article;
  }

  private async assertAuthorizedAction(run: WorkflowRun, action: AllowedAction): Promise<void> {
    const allowedActions = readAllowedActions(run.state.allowedActions);
    const authorized = allowedActions.find((item) => item.id === action.id);
    if (!authorized) throw new Error(`Unauthorized workflow action: ${action.id}`);
    if (authorized.operationId !== action.operationId) throw new Error(`Unauthorized operationId for action ${action.id}.`);
    if (authorized.type !== action.type) throw new Error(`Unauthorized action type for action ${action.id}.`);
    if (authorized.articleId !== action.articleId) throw new Error(`Unauthorized articleId for action ${action.id}.`);
    if (authorized.sectionId !== action.sectionId) throw new Error(`Unauthorized sectionId for action ${action.id}.`);
    if (authorized.reviewArtifactId !== action.reviewArtifactId) throw new Error(`Unauthorized reviewArtifactId for action ${action.id}.`);
    if (authorized.suggestionId !== action.suggestionId) throw new Error(`Unauthorized suggestionId for action ${action.id}.`);
    if (authorized.targetKind !== action.targetKind) throw new Error(`Unauthorized targetKind for action ${action.id}.`);
    if (authorized.targetId !== action.targetId) throw new Error(`Unauthorized targetId for action ${action.id}.`);
    if (authorized.baseRevision !== action.baseRevision) throw new Error(`Unauthorized baseRevision for action ${action.id}.`);
    if (authorized.requiresHumanGate !== action.requiresHumanGate) throw new Error(`Unauthorized HumanGate policy for action ${action.id}.`);
    if (action.articleId) {
      const article = await this.requireArticle(action.articleId);
      await this.requireWorkspaceAccess(run, article.workspaceId);
    }
  }

  private async requireWorkspaceAccess(run: WorkflowRun, workspaceId: string): Promise<void> {
    const workspace = await this.deps.stores.workspaceStore.getWorkspace(workspaceId);
    if (!workspace || workspace.deletedAt) throw new Error(`Workspace not found: ${workspaceId}`);
    if (workspace.userId !== run.metadata.userId && !workspace.memberUserIds.includes(run.metadata.userId)) {
      throw new Error('Workflow action requires workspace access.');
    }
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

function readAllowedActions(value: unknown): AllowedAction[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isAllowedAction);
}

function isAllowedAction(value: unknown): value is AllowedAction {
  if (!value || typeof value !== 'object') return false;
  const action = value as Partial<AllowedAction>;
  return typeof action.id === 'string'
    && typeof action.operationId === 'string'
    && typeof action.type === 'string'
    && typeof action.requiresHumanGate === 'boolean'
    && typeof action.reason === 'string';
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
  for (const block of article.blocks) {
    if (block.status === 'needs_revision') {
      findings.push({ severity: 'warning', targetKind: 'block', targetId: block.id, message: `正文段落「${block.title ?? block.id}」已标记为需要修订，应先生成局部修改方案。` });
    }
    if (article.taskCard?.constraints.citationRequired && !block.sourceRefs.length) {
      findings.push({ severity: 'warning', targetKind: 'block', targetId: block.id, message: `正文段落「${block.title ?? block.id}」缺少来源绑定，但任务卡要求引用或来源依据。` });
    }
  }
  if (!findings.length) findings.push({ severity: 'info', targetKind: 'article', message: '所有大纲项均已有正文，可以进入人工统稿审阅。' });
  return findings;
}

function revisionOperationsForReview(reviewArtifact: ReviewArtifact): RevisionOperation[] {
  const findings = actionableReviewFindings(reviewArtifact);
  if (!findings.length) return [];
  const taskCardFindings = findings.filter((finding) => finding.targetKind === 'task-card');
  const blockFindings = findings.filter((finding) => finding.targetKind === 'block' && finding.targetId);
  const outlineItemFindings = findings.filter((finding) => finding.targetKind === 'outline-item' && finding.targetId);
  const outlineFindings = findings.filter((finding) => finding.targetKind === 'outline' || (finding.targetKind !== 'task-card' && finding.targetKind !== 'block' && finding.targetKind !== 'outline-item'));
  const operations: RevisionOperation[] = [];
  if (taskCardFindings.length) operations.push({ type: 'revise-task-card', instruction: revisionInstruction(reviewArtifact, taskCardFindings) });
  if (outlineFindings.length) operations.push({ type: 'revise-outline', instruction: revisionInstruction(reviewArtifact, outlineFindings) });
  for (const finding of outlineItemFindings) operations.push({ type: 'revise-outline-item', outlineItemId: finding.targetId as string, instruction: revisionInstruction(reviewArtifact, [finding]) });
  for (const finding of blockFindings) operations.push({ type: 'patch-block', blockId: finding.targetId as string, instruction: revisionInstruction(reviewArtifact, [finding]) });
  return operations;
}

function actionableReviewFindings(reviewArtifact: ReviewArtifact): ReviewFinding[] {
  return reviewArtifact.findings.filter((finding) => finding.severity !== 'info');
}

function readCommentIds(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const value = (input as { commentIds?: unknown }).commentIds;
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
}

function revisionInstruction(reviewArtifact: ReviewArtifact, findings: ReviewFinding[]): string {
  const source = reviewArtifact.type === 'consistency-review' ? '一致性检查' : '统稿报告';
  const messages = findings.map((finding) => `- ${finding.message}`).join('\n');
  return `${source}发现以下问题，请据此修订，保持任务卡、大纲和正文一致：\n${messages}`;
}

function revisionProposalSummary(reviewArtifact: ReviewArtifact): string {
  const blockingCount = reviewArtifact.findings.filter((finding) => finding.severity === 'blocking').length;
  const warningCount = reviewArtifact.findings.filter((finding) => finding.severity === 'warning').length;
  if (blockingCount) return `处理 ${blockingCount} 个阻断问题`;
  if (warningCount) return `处理 ${warningCount} 个修订建议`;
  return '处理审阅建议';
}

function revisionProposalContextKind(reviewArtifact: ReviewArtifact): 'task-card' | 'outline' | 'outline-item' | 'block' {
  const findings = actionableReviewFindings(reviewArtifact);
  const targetKinds = new Set(findings.map((finding) => finding.targetKind));
  if (targetKinds.size === 1 && targetKinds.has('task-card')) return 'task-card';
  if (targetKinds.size === 1 && targetKinds.has('outline-item')) return 'outline-item';
  if (targetKinds.size === 1 && targetKinds.has('block')) return 'block';
  return 'outline';
}
