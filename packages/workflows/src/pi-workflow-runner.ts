import { AgentDecision, ArticleArtifact, ExternalStores, HumanGate, PiAgentSession, WorkflowPolicy, WorkflowRun, WorkflowActionExecutor, newId, nowIso } from '@wa/core';
import { AllowedActionPlanner, consistencyReviewSignature } from './allowed-actions';
import { PiAgentDecisionProvider } from '@wa/core';

export const WRITING_AUTOPILOT_POLICY: WorkflowPolicy = {
  id: 'writing-autopilot',
  goal: '自主推进写作任务，从任务卡到大纲、正文、一致性审阅和统稿报告。',
  allowedActionPolicy: 'runner 每轮生成 allowedActions；agent 只能选择其中一个 action，不能自造 action 或 operationId。',
  humanGatePolicy: '覆盖已有大纲、正文或需要用户裁决时必须创建 HumanGate 并暂停 run。',
  completionPolicy: '任务卡、大纲、正文全部完成且统稿报告生成后，run 才能 completed。',
};

export interface PiWorkflowRunnerDeps {
  stores: ExternalStores;
  planner?: AllowedActionPlanner;
  actionExecutor?: WorkflowActionExecutor;
  decisionProvider?: PiAgentDecisionProvider;
  maxTurns?: number;
}

export class PiWorkflowRunner {
  private readonly planner: AllowedActionPlanner;

  constructor(private readonly deps: PiWorkflowRunnerDeps, private readonly policy = WRITING_AUTOPILOT_POLICY) {
    this.planner = deps.planner ?? new AllowedActionPlanner();
  }

  async runUntilBlocked(runId: string): Promise<WorkflowRun> {
    let run = await this.requireRun(runId);
    if (run.workflowId !== this.policy.id) throw new Error(`PiWorkflowRunner only supports ${this.policy.id}; got ${run.workflowId}.`);
    const maxTurns = this.deps.maxTurns ?? 1;
    for (let turn = 0; turn < maxTurns && run.status === 'running'; turn += 1) {
      const article = await this.loadArticle(run);
      const pendingGate = await this.pendingHumanGate(run);
      const session = await this.getOrCreateSession(run, article, pendingGate);
      if (isWaitingForCurrentRevisionProposal(run, article)) {
        return this.wait(run, '已生成待确认修改方案，请先应用或取消后再继续写作。', 'revision-proposal');
      }
      if (isBlockedByCurrentConsistencyReview(run, article) && !hasPendingReviewProposal(run, article)) {
        return this.wait(run, '一致性检查发现阻断问题，请先处理右侧建议后再继续写作。', 'consistency-review');
      }
      const allowedActions = this.planner.plan({
        run,
        article,
        pendingHumanGate: Boolean(pendingGate),
        requestedSectionId: typeof run.metadata.sectionId === 'string' ? run.metadata.sectionId : undefined,
      });
      const decisionResult = await this.resolveDecision(run, article, session, pendingGate, allowedActions).catch((error) => this.fail(run, error));
      if ('status' in decisionResult) return decisionResult;
      const decision = decisionResult.decision;
      run = await this.persistDecisionState(run, session, decision, allowedActions);
      await this.deps.stores.piAgentSessionStore.saveSession({ ...session, messages: decisionResult.messages, pendingHumanGateId: pendingGate?.id, baseArticleRevision: article?.revision });
      await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'agent.decision', payload: { userId: run.metadata.userId, decision, allowedActions }, createdAt: nowIso() });
      if (pendingGate) return this.wait(run, pendingGate.question);
      if (!allowedActions.length) return this.complete(run);
      if (!decision.selectedActionId) return this.fail(run, new Error('Pi agent did not select an action while allowedActions is non-empty.'));
      const selectedAction = allowedActions.find((action) => action.id === decision.selectedActionId);
      if (!selectedAction) return this.fail(run, new Error(`Pi agent selected unauthorized action: ${decision.selectedActionId}`));
      if (!this.deps.actionExecutor) return this.fail(run, new Error('PiWorkflowRunner requires an actionExecutor when actions are available.'));
      try {
        await this.deps.actionExecutor.execute({ policy: this.policy, run, action: selectedAction });
      } catch (error) {
        return this.fail(run, error);
      }
      run = await this.requireRun(run.id);
      if (run.status === 'waiting' || run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return run;
    }
    return run.status === 'running' ? this.wait(run, '已达到本轮自动执行步数上限。') : run;
  }

  private async loadArticle(run: WorkflowRun): Promise<ArticleArtifact | undefined> {
    const articleId = typeof run.metadata.articleId === 'string' ? run.metadata.articleId : undefined;
    return articleId ? this.deps.stores.artifactStore.getArticle(articleId) : undefined;
  }

  private async pendingHumanGate(run: WorkflowRun): Promise<HumanGate | undefined> {
    return (await this.deps.stores.humanGateStore.listGates({ runId: run.id, userId: run.metadata.userId, statuses: ['pending'] }))[0];
  }

  private async getOrCreateSession(run: WorkflowRun, article?: ArticleArtifact, pendingGate?: HumanGate): Promise<PiAgentSession> {
    const existing = await this.deps.stores.piAgentSessionStore.getWorkflowSession(run.id);
    if (existing) {
      return this.deps.stores.piAgentSessionStore.saveSession({
        ...existing,
        workspaceId: existing.workspaceId ?? (typeof run.metadata.workspaceId === 'string' ? run.metadata.workspaceId : article?.workspaceId),
        articleId: existing.articleId ?? article?.id,
        targetId: existing.targetId ?? run.id,
        pendingHumanGateId: pendingGate?.id,
        baseArticleRevision: article?.revision ?? existing.baseArticleRevision,
      });
    }
    const now = nowIso();
    const session: PiAgentSession = {
      id: newId('pi_ses'),
      runId: run.id,
      userId: run.metadata.userId,
      workspaceId: typeof run.metadata.workspaceId === 'string' ? run.metadata.workspaceId : article?.workspaceId,
      articleId: article?.id,
      contextKind: 'workflow',
      targetId: run.id,
      messages: [],
      pendingHumanGateId: pendingGate?.id,
      baseArticleRevision: article?.revision,
      lockVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.stores.piAgentSessionStore.saveSession(session);
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'pi.session.created', payload: { userId: run.metadata.userId, sessionId: session.id, articleId: article?.id }, createdAt: nowIso() });
    return session;
  }

  private async resolveDecision(
    run: WorkflowRun,
    article: ArticleArtifact | undefined,
    session: PiAgentSession,
    pendingGate: HumanGate | undefined,
    allowedActions: ReturnType<AllowedActionPlanner['plan']>,
  ): Promise<{ decision: AgentDecision; messages: PiAgentSession['messages'] }> {
    if (pendingGate || !allowedActions.length) {
      return { decision: this.buildInternalDecision(allowedActions, pendingGate), messages: session.messages };
    }
    if (!this.deps.decisionProvider) throw new Error('PiWorkflowRunner requires a decisionProvider when actions are available.');
    return this.deps.decisionProvider.decide({ policy: this.policy, run, article, session, allowedActions });
  }

  private buildInternalDecision(allowedActions: ReturnType<AllowedActionPlanner['plan']>, pendingGate?: HumanGate): AgentDecision {
    if (pendingGate) {
      return { intent: 'wait_for_human_gate', rationale: pendingGate.question, requiresHumanGate: true, stopReason: 'waiting' };
    }
    if (!allowedActions.length) return { intent: 'complete', rationale: '没有可继续执行的动作。', requiresHumanGate: false, stopReason: 'completed' };
    throw new Error('Internal decision can only wait for HumanGate or complete with no allowed actions.');
  }

  private async persistDecisionState(run: WorkflowRun, session: PiAgentSession, decision: AgentDecision, allowedActions: ReturnType<AllowedActionPlanner['plan']>): Promise<WorkflowRun> {
    return this.deps.stores.stateStore.updateRun(run.id, {
      state: {
        ...run.state,
        piAgentSessionId: session.id,
        allowedActions,
        agentDecision: decision,
      },
      updatedAt: nowIso(),
    });
  }

  private async wait(run: WorkflowRun, reason: string, nodeId = 'pi-agent'): Promise<WorkflowRun> {
    const waiting = await this.deps.stores.stateStore.updateRun(run.id, { status: 'waiting', waitingFor: { nodeId, reason }, updatedAt: nowIso() });
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'workflow.waiting', payload: { workflowId: run.workflowId, reason, userId: run.metadata.userId, runMetadata: run.metadata }, createdAt: nowIso() });
    return waiting;
  }

  private async complete(run: WorkflowRun): Promise<WorkflowRun> {
    const completed = await this.deps.stores.stateStore.updateRun(run.id, { status: 'completed', waitingFor: undefined, updatedAt: nowIso() });
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'workflow.completed', payload: { workflowId: run.workflowId, userId: run.metadata.userId, runMetadata: run.metadata }, createdAt: nowIso() });
    return completed;
  }

  private async fail(run: WorkflowRun, error: unknown): Promise<WorkflowRun> {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await this.deps.stores.stateStore.updateRun(run.id, { status: 'failed', error: message, updatedAt: nowIso() });
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'workflow.failed', payload: { workflowId: run.workflowId, error: message, userId: run.metadata.userId, runMetadata: run.metadata }, createdAt: nowIso() });
    return failed;
  }

  private async requireRun(runId: string): Promise<WorkflowRun> {
    const run = await this.deps.stores.stateStore.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }
}

function isBlockedByCurrentConsistencyReview(run: WorkflowRun, article?: ArticleArtifact): boolean {
  if (!article) return false;
  const currentSignature = consistencyReviewSignature(article);
  return typeof run.state.consistencyBlockingReviewId === 'string'
    && run.state.consistencyBlockingSignature === currentSignature;
}

function hasPendingReviewProposal(run: WorkflowRun, article?: ArticleArtifact): boolean {
  if (!article) return false;
  const value = run.state.pendingReviewProposal;
  if (!value || typeof value !== 'object') return false;
  return (value as { articleRevision?: unknown }).articleRevision === article.revision;
}

function isWaitingForCurrentRevisionProposal(run: WorkflowRun, article?: ArticleArtifact): boolean {
  if (!article) return false;
  return typeof run.state.pendingRevisionProposalId === 'string'
    && run.state.pendingRevisionProposalRevision === article.revision;
}
