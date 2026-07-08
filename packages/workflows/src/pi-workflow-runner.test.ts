import { describe, expect, it } from 'vitest';
import { ExternalStores, PiWorkflowRunner, WorkflowActionExecutor, WorkflowRun, ArticleArtifact } from './index';

const now = '2026-07-07T00:00:00.000Z';

function run(): WorkflowRun {
  return {
    id: 'run_1',
    workflowId: 'writing-autopilot',
    status: 'running',
    input: { targetStage: 'outline' },
    state: {},
    metadata: { userId: 'u1', articleId: 'art_1', workspaceId: 'wsp_1' },
    createdAt: now,
    updatedAt: now,
  };
}

function article(): ArticleArtifact {
  return {
    id: 'art_1',
    userId: 'u1',
    workspaceId: 'wsp_1',
    revision: 3,
    title: '测试文章',
    taskCard: {
      id: 'card_1',
      topic: '测试文章',
      writingGoal: '测试',
      audience: '读者',
      scope: {},
      structure: { articleType: 'essay', expectedLength: '短篇' },
      style: { register: '自然', tone: '克制', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '不强制引用' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    },
    outline: [],
    blocks: [],
    citations: [],
    themeTags: [],
    comments: [],
    versions: [],
    createdAt: now,
    updatedAt: now,
  };
}

function stores(initialRun = run(), initialArticle = article()): ExternalStores {
  const runs = new Map<string, WorkflowRun>([[initialRun.id, initialRun]]);
  const sessions = new Map<string, any>();
  const events: any[] = [];
  return {
    stateStore: {
      async saveRun(nextRun) { runs.set(nextRun.id, nextRun); return nextRun; },
      async getRun(runId) { return runs.get(runId); },
      async updateRun(runId, patch) { const current = runs.get(runId); if (!current) throw new Error('Run not found'); const updated = { ...current, ...patch } as WorkflowRun; runs.set(runId, updated); return updated; },
      async listRuns() { return [...runs.values()]; },
    },
    artifactStore: { async getArticle(articleId) { return articleId === initialArticle.id ? initialArticle : undefined; } },
    humanGateStore: { async listGates() { return []; } },
    piAgentSessionStore: {
      async getWorkflowSession(runId) { return [...sessions.values()].find((session) => session.runId === runId); },
      async saveSession(session) { sessions.set(session.id, { ...session, updatedAt: now }); return sessions.get(session.id); },
    },
    eventTraceStore: { async append(event) { events.push(event); }, async listByRun(runId) { return events.filter((event) => event.runId === runId); } },
  } as unknown as ExternalStores;
}

describe('PiWorkflowRunner', () => {
  it('executes a singleton allowed action without an LLM decision provider', async () => {
    let executed = false;
    const testStores = stores();
    const runner = new PiWorkflowRunner({
      stores: testStores,
      actionExecutor: { async execute() { executed = true; return { summary: 'executed' }; } } as WorkflowActionExecutor,
    });
    const result = await runner.runUntilBlocked('run_1');
    expect(result.status).toBe('waiting');
    expect(result.waitingFor?.reason).toContain('已达到本轮自动执行步数上限');
    expect(executed).toBe(true);
  });

  it('requires an LLM decision provider when there is a real action choice', async () => {
    let executed = false;
    const testStores = stores();
    const runner = new PiWorkflowRunner({
      stores: testStores,
      planner: {
        plan() {
          return [
            { id: 'act_1', operationId: 'op_1', type: 'plan_outline', articleId: 'art_1', baseRevision: 3, requiresHumanGate: false, reason: '生成大纲。' },
            { id: 'act_2', operationId: 'op_2', type: 'request_human_gate', articleId: 'art_1', baseRevision: 3, requiresHumanGate: true, reason: '询问用户。' },
          ];
        },
      } as never,
      actionExecutor: { async execute() { executed = true; return { summary: 'executed' }; } } as WorkflowActionExecutor,
    });
    const result = await runner.runUntilBlocked('run_1');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('requires a decisionProvider');
    expect(executed).toBe(false);
  });

  it('fails instead of executing a default action when the decision omits selectedActionId', async () => {
    let executed = false;
    const testStores = stores();
    const runner = new PiWorkflowRunner({
      stores: testStores,
      planner: {
        plan() {
          return [
            { id: 'act_1', operationId: 'op_1', type: 'plan_outline', articleId: 'art_1', baseRevision: 3, requiresHumanGate: false, reason: '生成大纲。' },
            { id: 'act_2', operationId: 'op_2', type: 'request_human_gate', articleId: 'art_1', baseRevision: 3, requiresHumanGate: true, reason: '询问用户。' },
          ];
        },
      } as never,
      decisionProvider: {
        async decide() {
          return { decision: { intent: 'wait', rationale: '没有选择动作。', requiresHumanGate: false, stopReason: 'waiting' }, messages: [] };
        },
      } as never,
      actionExecutor: { async execute() { executed = true; return { summary: 'executed' }; } } as WorkflowActionExecutor,
    });
    const result = await runner.runUntilBlocked('run_1');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('did not select an action');
    expect(executed).toBe(false);
  });

  it('returns a failed run when the selected workflow action throws', async () => {
    let executed = false;
    const testStores = stores();
    const runner = new PiWorkflowRunner({
      stores: testStores,
      decisionProvider: {
        async decide(input: { allowedActions: Array<{ id: string; type: string; reason: string; requiresHumanGate: boolean }> }) {
          const action = input.allowedActions[0];
          return {
            decision: { intent: action.type, selectedActionId: action.id, rationale: action.reason, requiresHumanGate: action.requiresHumanGate },
            messages: [],
          };
        },
      } as never,
      actionExecutor: { async execute() { executed = true; throw new Error('Action execution failed.'); } } as WorkflowActionExecutor,
    });

    const result = await runner.runUntilBlocked('run_1');

    expect(executed).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Action execution failed');
    await expect(testStores.eventTraceStore.listByRun('run_1')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'workflow.failed', payload: expect.objectContaining({ error: 'Action execution failed.' }) }),
    ]));
  });
});
