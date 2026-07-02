import { EventTraceStore, StateStore } from './stores';
import { WorkflowRun } from './types';
import { newId, nowIso } from './utils';
import { WorkflowRunner } from './workflow';

export type WorkflowExecutionMode = 'inline' | 'async';
export type WorkflowQueueReason = 'start' | 'resume' | 'retry' | 'manual';

export interface WorkflowJob {
  id: string;
  runId: string;
  workflowId: string;
  reason: WorkflowQueueReason;
  attempt: number;
  createdAt: string;
  availableAt?: string;
}

export interface WorkflowQueue {
  enqueue(job: WorkflowJob): Promise<void>;
  reserve(options?: { timeoutMs?: number; runnerId?: string }): Promise<WorkflowJob | undefined>;
  complete(job: WorkflowJob): Promise<void>;
  fail(job: WorkflowJob, error: Error): Promise<void>;
  getDepth?(): Promise<number>;
  close?(): Promise<void>;
}

export function toWorkflowJob(run: WorkflowRun, reason: WorkflowQueueReason): WorkflowJob {
  return { id: newId('job'), runId: run.id, workflowId: run.workflowId, reason, attempt: 1, createdAt: nowIso() };
}

export class LocalWorkflowQueue implements WorkflowQueue {
  private readonly jobs: WorkflowJob[] = [];
  private readonly waiters: Array<(job: WorkflowJob | undefined) => void> = [];
  private closed = false;

  async enqueue(job: WorkflowJob): Promise<void> {
    if (this.closed) throw new Error('LocalWorkflowQueue is closed.');
    const waiter = this.waiters.shift();
    if (waiter) waiter(job);
    else this.jobs.push(job);
  }

  async reserve(options?: { timeoutMs?: number }): Promise<WorkflowJob | undefined> {
    if (this.closed) return undefined;
    const job = this.jobs.shift();
    if (job) return job;
    return new Promise((resolve) => {
      const wrapped = (reserved: WorkflowJob | undefined) => {
        clearTimeout(timeout);
        resolve(reserved);
      };
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(wrapped);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(undefined);
      }, options?.timeoutMs ?? 1000);
      this.waiters.push(wrapped);
    });
  }

  async complete(): Promise<void> {}

  async fail(job: WorkflowJob): Promise<void> {
    if (job.attempt < 3 && !this.closed) {
      await this.enqueue({ ...job, id: newId('job'), attempt: job.attempt + 1, availableAt: nowIso() });
    }
  }

  async getDepth(): Promise<number> {
    return this.jobs.length;
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()?.(undefined);
  }
}

export interface WorkflowWorkerPoolOptions {
  concurrency: number;
  reserveTimeoutMs?: number;
}

export class WorkflowWorkerPool {
  private running = false;
  private readonly workers: Promise<void>[] = [];

  constructor(
    private readonly deps: { queue: WorkflowQueue; stateStore: StateStore; eventTraceStore: EventTraceStore; runnerFactory: () => WorkflowRunner },
    private readonly options: WorkflowWorkerPoolOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    for (let i = 0; i < Math.max(1, this.options.concurrency); i += 1) {
      void this.workers.push(this.workerLoop(`runner-${i + 1}`));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.deps.queue.close?.();
    await Promise.allSettled(this.workers);
  }

  private async workerLoop(runnerId: string): Promise<void> {
    await this.deps.eventTraceStore.append({ id: newId('evt'), type: 'runner.started', payload: { runnerId }, createdAt: nowIso() });
    while (this.running) {
      const job = await this.deps.queue.reserve({ timeoutMs: this.options.reserveTimeoutMs ?? 1000, runnerId });
      if (!job) continue;
      await this.deps.eventTraceStore.append({ id: newId('evt'), runId: job.runId, type: 'queue.dequeued', payload: { runnerId, jobId: job.id, workflowId: job.workflowId, attempt: job.attempt, reason: job.reason }, createdAt: nowIso() });
      try {
        await this.markRunAsRunning(job.runId);
        const run = await this.deps.runnerFactory().runUntilBlocked(job.runId);
        await this.deps.queue.complete(job);
        await this.deps.eventTraceStore.append({ id: newId('evt'), runId: job.runId, type: 'queue.completed', payload: { runnerId, jobId: job.id, status: run.status }, createdAt: nowIso() });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        await this.deps.queue.fail(job, failure);
        await this.deps.eventTraceStore.append({ id: newId('evt'), runId: job.runId, type: 'queue.failed', payload: { runnerId, jobId: job.id, error: failure.message }, createdAt: nowIso() });
      }
    }
    await this.deps.eventTraceStore.append({ id: newId('evt'), type: 'runner.stopped', payload: { runnerId }, createdAt: nowIso() });
  }

  private async markRunAsRunning(runId: string): Promise<WorkflowRun | undefined> {
    const run = await this.deps.stateStore.getRun(runId);
    if (!run) return undefined;
    if (run.status === 'queued') return this.deps.stateStore.updateRun(runId, { status: 'running', updatedAt: nowIso() });
    return run;
  }
}
