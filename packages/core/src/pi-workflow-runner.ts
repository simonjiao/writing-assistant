import { ExternalStores } from './stores';
import {
  AgentDecision,
  ArticleArtifact,
  HumanGate,
  PiAgentSession,
  WorkflowPolicy,
  WorkflowRun,
} from './types';
import { newId, nowIso } from './utils';
import { AllowedActionPlanner } from './allowed-actions';
import { WorkflowActionExecutor } from './workflow-action-executor';
import { PiAgentDecisionProvider } from './pi-agent-decision';

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
      if (isBlockedByCurrentConsistencyReview(run, article)) {
        return this.wait(run, '一致性检查发现阻断问题，请先处理右侧建议后再继续写作。', 'consistency-review');
      }
      const allowedActions = this.planner.plan({
        run,
        article,
        pendingHumanGate: Boolean(pendingGate),
        requestedSectionId: typeof run.metadata.sectionId === 'string' ? run.metadata.sectionId : undefined,
      });
      const decisionResult = pendingGate || !this.deps.decisionProvider
        ? { decision: this.buildDecision(allowedActions, pendingGate), messages: session.messages }
        : await this.deps.decisionProvider.decide({ policy: this.policy, run, article, session, allowedActions });
      const decision = decisionResult.decision;
      run = await this.persistDecisionState(run, session, decision, allowedActions);
      await this.deps.stores.piAgentSessionStore.saveSession({ ...session, messages: decisionResult.messages, pendingHumanGateId: pendingGate?.id, baseArticleRevision: article?.revision });
      await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'agent.decision', payload: { userId: run.metadata.userId, decision, allowedActions }, createdAt: nowIso() });
      if (pendingGate) return this.wait(run, pendingGate.question);
      if (!allowedActions.length) return this.complete(run);
      const selectedAction = allowedActions.find((action) => action.id === decision.selectedActionId) ?? allowedActions[0];
      if (!this.deps.actionExecutor) return this.wait(run, '等待 agent action tool 执行。');
      await this.deps.actionExecutor.execute({ policy: this.policy, run, action: selectedAction });
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

  private buildDecision(allowedActions: ReturnType<AllowedActionPlanner['plan']>, pendingGate?: HumanGate): AgentDecision {
    if (pendingGate) {
      return { intent: 'wait_for_human_gate', rationale: pendingGate.question, requiresHumanGate: true, stopReason: 'waiting' };
    }
    const selected = allowedActions[0];
    if (!selected) return { intent: 'complete', rationale: '没有可继续执行的动作。', requiresHumanGate: false, stopReason: 'completed' };
    return { intent: selected.type, selectedActionId: selected.id, rationale: selected.reason, requiresHumanGate: selected.requiresHumanGate };
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

  private async requireRun(runId: string): Promise<WorkflowRun> {
    const run = await this.deps.stores.stateStore.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }
}

function isBlockedByCurrentConsistencyReview(run: WorkflowRun, article?: ArticleArtifact): boolean {
  if (!article) return false;
  return typeof run.state.consistencyBlockingReviewId === 'string'
    && run.state.consistencyBlockingRevision === article.revision;
}
