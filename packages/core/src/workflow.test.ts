import { describe, expect, it } from 'vitest';
import { AgentRuntime, ContextBuilder, END, EventTraceStore, LLMProvider, SkillRegistry, StateStore, WorkflowEngine, WorkflowRun } from './index';

class MemoryStateStore implements StateStore {
  runs = new Map<string, WorkflowRun>();
  async saveRun(run: WorkflowRun) { this.runs.set(run.id, run); return run; }
  async getRun(runId: string) { return this.runs.get(runId); }
  async updateRun(runId: string, patch: Partial<WorkflowRun>) { const run = { ...(this.runs.get(runId) as WorkflowRun), ...patch }; this.runs.set(runId, run); return run; }
  async listRuns() { return [...this.runs.values()]; }
}

class MemoryEvents implements EventTraceStore {
  events: any[] = [];
  async append(event: any) { this.events.push(event); }
  async listByRun(runId: string) { return this.events.filter((event) => event.runId === runId); }
}

const llm: LLMProvider = { async chat() { return { content: 'ok' }; }, async json<T>() { return {} as T; } };
const contextBuilder: ContextBuilder = { async build(input) { return { userId: input.userId, memory: { userId: input.userId, stylePreferences: [], structurePreferences: [], editPreferences: [], memoryNotes: [], updatedAt: '' }, knowledge: [], scope: 'article', skillId: input.skillId, compactSummary: '' }; } };

describe('WorkflowEngine', () => {
  it('pauses and resumes at wait nodes', async () => {
    const stateStore = new MemoryStateStore();
    const eventTraceStore = new MemoryEvents();
    const registry = new SkillRegistry();
    const runtime = new AgentRuntime({ llm, skillRegistry: registry, contextBuilder, eventTraceStore });
    const engine = new WorkflowEngine({ stateStore, eventTraceStore, runtime });
    engine.registerWorkflow({
      id: 'demo',
      name: 'Demo',
      description: 'Demo',
      startNodeId: 'set',
      nodes: [
        { id: 'set', label: 'Set', kind: 'function', outputKey: 'value', handler: async () => ({ ok: true }), next: 'wait' },
        { id: 'wait', label: 'Wait', kind: 'wait', reason: 'confirm', next: 'done' },
        { id: 'done', label: 'Done', kind: 'function', outputKey: 'done', handler: async () => ({ done: true }), next: END },
      ],
    });
    const run = await engine.startWorkflow('demo', {}, { userId: 'u1' });
    expect(run.status).toBe('waiting');
    const resumed = await engine.resumeWorkflow(run.id, { decision: 'confirm' });
    expect(resumed.status).toBe('completed');
    expect(resumed.state.done).toEqual({ done: true });
  });
});
