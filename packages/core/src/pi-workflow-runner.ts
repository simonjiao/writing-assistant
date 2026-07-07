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
}

export class PiWorkflowRunner {
  private readonly planner: AllowedActionPlanner;

  constructor(private readonly deps: PiWorkflowRunnerDeps, private readonly policy = WRITING_AUTOPILOT_POLICY) {
    this.planner = deps.planner ?? new AllowedActionPlanner();
  }

  async runUntilBlocked(runId: string): Promise<WorkflowRun> {
    const run = await this.requireRun(runId);
    if (run.workflowId !== this.policy.id) throw new Error(`PiWorkflowRunner only supports ${this.policy.id}; got ${run.workflowId}.`);
    const article = await this.loadArticle(run);
    const pendingGate = await this.pendingHumanGate(run);
    const session = await this.getOrCreateSession(run, article, pendingGate);
    const allowedActions = this.planner.plan({
      run,
      article,
      pendingHumanGate: Boolean(pendingGate),
      requestedSectionId: typeof run.metadata.sectionId === 'string' ? run.metadata.sectionId : undefined,
    });
    const decision = this.buildDecision(allowedActions, pendingGate);
    const nextRun = await this.persistRunState(run, session, decision, allowedActions, pendingGate);
    await this.deps.stores.piAgentSessionStore.saveSession({ ...session, pendingHumanGateId: pendingGate?.id, baseArticleRevision: article?.revision });
    await this.deps.stores.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'agent.decision', payload: { userId: run.metadata.userId, decision, allowedActions }, createdAt: nowIso() });
    return nextRun;
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
    if (existing) return existing;
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

  private async persistRunState(run: WorkflowRun, session: PiAgentSession, decision: AgentDecision, allowedActions: ReturnType<AllowedActionPlanner['plan']>, pendingGate?: HumanGate): Promise<WorkflowRun> {
    const status: WorkflowRun['status'] = pendingGate || allowedActions.length ? 'waiting' : 'completed';
    const waitingFor = status === 'waiting'
      ? { nodeId: 'pi-agent', reason: pendingGate ? pendingGate.question : '等待 agent action tool 执行。' }
      : undefined;
    return this.deps.stores.stateStore.updateRun(run.id, {
      status,
      waitingFor,
      state: {
        ...run.state,
        piAgentSessionId: session.id,
        allowedActions,
        agentDecision: decision,
      },
      updatedAt: nowIso(),
    });
  }

  private async requireRun(runId: string): Promise<WorkflowRun> {
    const run = await this.deps.stores.stateStore.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }
}
