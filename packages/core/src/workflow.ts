import { AgentRuntime } from './agent-runtime';
import { EventTraceStore, StateStore } from './stores';
import { WorkflowRun } from './types';
import { WorkflowExecutionMode, WorkflowQueue, WorkflowQueueReason, toWorkflowJob } from './queue';
import { newId, nowIso, truncate } from './utils';

export const END = '__END__';

export interface WorkflowNodeContext { run: WorkflowRun; runtime: AgentRuntime }
export type NodeNext = string | typeof END | ((ctx: WorkflowNodeContext, result: unknown) => string | typeof END | Promise<string | typeof END>);
export type NodeInputBuilder = (ctx: WorkflowNodeContext) => unknown | Promise<unknown>;
export type NodeHandler = (ctx: WorkflowNodeContext) => unknown | Promise<unknown>;
export type WorkflowNode =
  | { id: string; label: string; kind: 'skill'; skillId: string; input?: NodeInputBuilder; outputKey?: string; next: NodeNext }
  | { id: string; label: string; kind: 'function'; handler: NodeHandler; outputKey?: string; next: NodeNext }
  | { id: string; label: string; kind: 'wait'; reason: string; next: NodeNext };
export interface WorkflowDefinition { id: string; name: string; description: string; startNodeId: string; nodes: WorkflowNode[] }

export class WorkflowEngine {
  private readonly definitions = new Map<string, WorkflowDefinition>();

  constructor(private readonly deps: { stateStore: StateStore; eventTraceStore: EventTraceStore; runtime: AgentRuntime; queue?: WorkflowQueue; executionMode?: WorkflowExecutionMode }) {
    if (this.executionMode === 'async' && !deps.queue) throw new Error('WorkflowEngine async mode requires a WorkflowQueue.');
  }

  get executionMode(): WorkflowExecutionMode { return this.deps.executionMode ?? (this.deps.queue ? 'async' : 'inline'); }

  registerWorkflow(definition: WorkflowDefinition): void {
    if (this.definitions.has(definition.id)) throw new Error(`Workflow already registered: ${definition.id}`);
    this.assertValidDefinition(definition);
    this.definitions.set(definition.id, definition);
  }

  listWorkflows(): Array<Pick<WorkflowDefinition, 'id' | 'name' | 'description'>> {
    return [...this.definitions.values()].map(({ id, name, description }) => ({ id, name, description }));
  }

  getDefinition(workflowId: string): WorkflowDefinition {
    const definition = this.definitions.get(workflowId);
    if (!definition) throw new Error(`Workflow not found: ${workflowId}`);
    return definition;
  }

  createRunner(): WorkflowRunner {
    return new WorkflowRunner({ definitions: this.definitions, runtime: this.deps.runtime, stateStore: this.deps.stateStore, eventTraceStore: this.deps.eventTraceStore });
  }

  async startWorkflow(workflowId: string, input: unknown, metadata: WorkflowRun['metadata']): Promise<WorkflowRun> {
    const definition = this.getDefinition(workflowId);
    const run: WorkflowRun = { id: newId('run'), workflowId, status: this.executionMode === 'async' ? 'queued' : 'running', currentNodeId: definition.startNodeId, input, state: {}, metadata, history: [], createdAt: nowIso(), updatedAt: nowIso() };
    await this.deps.stateStore.saveRun(run);
    await this.deps.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'workflow.started', payload: { workflowId, metadata, userId: metadata.userId, executionMode: this.executionMode }, createdAt: nowIso() });
    if (this.executionMode === 'async') { await this.enqueueRun(run, 'start'); return run; }
    return this.createRunner().runUntilBlocked(run.id);
  }

  async resumeWorkflow(runId: string, resumeInput: unknown): Promise<WorkflowRun> {
    const run = await this.deps.stateStore.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.status !== 'waiting') throw new Error(`Run is not waiting: ${runId}; current status=${run.status}`);
    const updated = await this.deps.stateStore.updateRun(runId, { status: this.executionMode === 'async' ? 'queued' : 'running', resumeInput, waitingFor: undefined, updatedAt: nowIso() });
    await this.deps.eventTraceStore.append({ id: newId('evt'), runId, type: 'workflow.resumed', payload: { workflowId: run.workflowId, userId: run.metadata.userId, executionMode: this.executionMode }, createdAt: nowIso() });
    if (this.executionMode === 'async') { await this.enqueueRun(updated, 'resume'); return updated; }
    return this.createRunner().runUntilBlocked(runId);
  }

  async getRun(runId: string): Promise<WorkflowRun | undefined> { return this.deps.stateStore.getRun(runId); }

  async cancelWorkflow(runId: string): Promise<WorkflowRun> {
    const run = await this.deps.stateStore.updateRun(runId, { status: 'cancelled', updatedAt: nowIso() });
    await this.deps.eventTraceStore.append({ id: newId('evt'), runId, type: 'workflow.failed', payload: { workflowId: run.workflowId, cancelled: true, userId: run.metadata.userId }, createdAt: nowIso() });
    return run;
  }

  private async enqueueRun(run: WorkflowRun, reason: WorkflowQueueReason): Promise<void> {
    if (!this.deps.queue) throw new Error('Workflow queue is not configured.');
    const job = toWorkflowJob(run, reason);
    await this.deps.queue.enqueue(job);
    await this.deps.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'workflow.queued', payload: { workflowId: run.workflowId, jobId: job.id, reason, userId: run.metadata.userId, metadata: run.metadata }, createdAt: nowIso() });
    await this.deps.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'queue.enqueued', payload: { workflowId: run.workflowId, jobId: job.id, reason, userId: run.metadata.userId }, createdAt: nowIso() });
  }

  private assertValidDefinition(definition: WorkflowDefinition): void {
    const ids = new Set(definition.nodes.map((node) => node.id));
    if (!ids.has(definition.startNodeId)) throw new Error(`Workflow ${definition.id} has invalid start node: ${definition.startNodeId}`);
    for (const node of definition.nodes) if (typeof node.next === 'string' && node.next !== END && !ids.has(node.next)) throw new Error(`Workflow ${definition.id} node ${node.id} points to unknown node: ${node.next}`);
  }
}

export class WorkflowRunner {
  constructor(private readonly deps: { definitions: Map<string, WorkflowDefinition>; runtime: AgentRuntime; stateStore: StateStore; eventTraceStore: EventTraceStore }) {}

  async runUntilBlocked(runId: string): Promise<WorkflowRun> {
    let run = await this.requireRun(runId);
    while (run.status === 'running') {
      if (!run.currentNodeId) { run = await this.completeRun(run); break; }
      run = await this.executeCurrentNode(run);
    }
    return run;
  }

  private async executeCurrentNode(run: WorkflowRun): Promise<WorkflowRun> {
    const definition = this.requireDefinition(run.workflowId);
    const node = definition.nodes.find((candidate) => candidate.id === run.currentNodeId);
    if (!node) throw new Error(`Node not found: ${run.currentNodeId}`);
    const startedAt = nowIso();
    await this.deps.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'node.started', payload: { workflowId: run.workflowId, nodeId: node.id, kind: node.kind, userId: run.metadata.userId, runMetadata: run.metadata }, createdAt: startedAt });
    try {
      if (node.kind === 'wait') return this.executeWaitNode(run, node, startedAt);
      const ctx: WorkflowNodeContext = { run, runtime: this.deps.runtime };
      const result = node.kind === 'skill'
        ? await this.deps.runtime.invokeSkill(node.skillId, node.input ? await node.input(ctx) : run.input, { userId: run.metadata.userId, sessionId: run.metadata.sessionId, runId: run.id, workflowId: run.workflowId, articleId: typeof run.metadata.articleId === 'string' ? run.metadata.articleId : undefined })
        : await node.handler(ctx);
      if (node.outputKey) run.state[node.outputKey] = result as unknown;
      const nextNodeId = await this.resolveNext(node.next, { run, runtime: this.deps.runtime }, result);
      run.history.push({ nodeId: node.id, status: 'completed', startedAt, finishedAt: nowIso(), summary: truncate(result) });
      run.currentNodeId = nextNodeId === END ? undefined : nextNodeId;
      run.status = nextNodeId === END ? 'completed' : 'running';
      run.updatedAt = nowIso();
      delete run.resumeInput;
      await this.deps.stateStore.saveRun(run);
      await this.deps.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: run.status === 'completed' ? 'workflow.completed' : 'node.completed', payload: { workflowId: run.workflowId, nodeId: node.id, nextNodeId: run.currentNodeId, userId: run.metadata.userId, runMetadata: run.metadata }, createdAt: nowIso() });
      return run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      run.status = 'failed'; run.error = message; run.updatedAt = nowIso();
      run.history.push({ nodeId: node.id, status: 'failed', startedAt, finishedAt: nowIso(), summary: message });
      await this.deps.stateStore.saveRun(run);
      await this.deps.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'workflow.failed', payload: { workflowId: run.workflowId, nodeId: node.id, error: message, userId: run.metadata.userId, runMetadata: run.metadata }, createdAt: nowIso() });
      return run;
    }
  }

  private async executeWaitNode(run: WorkflowRun, node: Extract<WorkflowNode, { kind: 'wait' }>, startedAt: string): Promise<WorkflowRun> {
    if (run.resumeInput === undefined) {
      run.status = 'waiting'; run.waitingFor = { nodeId: node.id, reason: node.reason }; run.updatedAt = nowIso();
      run.history.push({ nodeId: node.id, status: 'waiting', startedAt, finishedAt: nowIso(), summary: node.reason });
      await this.deps.stateStore.saveRun(run);
      await this.deps.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'workflow.waiting', payload: { workflowId: run.workflowId, nodeId: node.id, reason: node.reason, userId: run.metadata.userId, runMetadata: run.metadata }, createdAt: nowIso() });
      await this.deps.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'review.required', payload: { workflowId: run.workflowId, nodeId: node.id, reason: node.reason, userId: run.metadata.userId, runMetadata: run.metadata }, createdAt: nowIso() });
      return run;
    }
    run.state[`${node.id}Response`] = run.resumeInput;
    const nextNodeId = await this.resolveNext(node.next, { run, runtime: this.deps.runtime }, run.resumeInput);
    run.currentNodeId = nextNodeId === END ? undefined : nextNodeId;
    run.status = nextNodeId === END ? 'completed' : 'running';
    run.updatedAt = nowIso(); delete run.resumeInput; delete run.waitingFor;
    await this.deps.stateStore.saveRun(run);
    await this.deps.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'node.completed', payload: { workflowId: run.workflowId, nodeId: node.id, nextNodeId: run.currentNodeId, userId: run.metadata.userId, runMetadata: run.metadata }, createdAt: nowIso() });
    return run;
  }

  private async resolveNext(next: NodeNext, ctx: WorkflowNodeContext, result: unknown): Promise<string | typeof END> { return typeof next === 'function' ? next(ctx, result) : next; }
  private async completeRun(run: WorkflowRun): Promise<WorkflowRun> { run.status = 'completed'; run.updatedAt = nowIso(); await this.deps.stateStore.saveRun(run); return run; }
  private async requireRun(runId: string): Promise<WorkflowRun> { const run = await this.deps.stateStore.getRun(runId); if (!run) throw new Error(`Run not found: ${runId}`); return run; }
  private requireDefinition(workflowId: string): WorkflowDefinition { const definition = this.deps.definitions.get(workflowId); if (!definition) throw new Error(`Workflow not found: ${workflowId}`); return definition; }
}
