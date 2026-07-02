import Redis from 'ioredis';
import { WorkflowJob, WorkflowQueue, newId, nowIso } from '@wa/core';

export interface RedisWorkflowQueueOptions { redisUrl: string; queueKey?: string; failedKey?: string; maxAttempts?: number }

export class RedisWorkflowQueue implements WorkflowQueue {
  private readonly client: Redis;
  private readonly blockingClient: Redis;
  private readonly queueKey: string;
  private readonly failedKey: string;
  private closed = false;

  constructor(private readonly options: RedisWorkflowQueueOptions) {
    this.queueKey = options.queueKey ?? 'wa:workflow:queue';
    this.failedKey = options.failedKey ?? `${this.queueKey}:failed`;
    this.client = new Redis(options.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
    this.blockingClient = new Redis(options.redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
  }

  async enqueue(job: WorkflowJob): Promise<void> { if (this.closed) throw new Error('RedisWorkflowQueue is closed.'); await this.client.connect().catch(ignoreConnected); await this.client.lpush(this.queueKey, JSON.stringify(job)); }
  async reserve(options?: { timeoutMs?: number }): Promise<WorkflowJob | undefined> { if (this.closed) return undefined; await this.blockingClient.connect().catch(ignoreConnected); const result = await this.blockingClient.brpop(this.queueKey, Math.max(1, Math.ceil((options?.timeoutMs ?? 1000) / 1000))); return result ? JSON.parse(result[1]) as WorkflowJob : undefined; }
  async complete(): Promise<void> {}
  async fail(job: WorkflowJob): Promise<void> { if (job.attempt < (this.options.maxAttempts ?? 3)) await this.enqueue({ ...job, id: newId('job'), attempt: job.attempt + 1, availableAt: nowIso() }); else { await this.client.connect().catch(ignoreConnected); await this.client.lpush(this.failedKey, JSON.stringify(job)); } }
  async getDepth(): Promise<number> { await this.client.connect().catch(ignoreConnected); return this.client.llen(this.queueKey); }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([this.client.quit(), this.blockingClient.quit()]); }
}
function ignoreConnected(error: unknown): void { const msg = error instanceof Error ? error.message : String(error); if (!msg.includes('already connecting') && !msg.includes('Connection is already')) throw error; }
