import { AgentEvent } from './types';

export interface EventSubscriptionFilter { runId?: string; userId?: string; eventTypes?: string[] }
export type EventHandler = (event: AgentEvent) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface EventBus {
  publish(event: AgentEvent): Promise<void>;
  subscribe(filter: EventSubscriptionFilter, handler: EventHandler): Unsubscribe | Promise<Unsubscribe>;
  close?(): Promise<void>;
}

export class InMemoryEventBus implements EventBus {
  private nextId = 1;
  private readonly subscribers = new Map<number, { filter: EventSubscriptionFilter; handler: EventHandler }>();

  async publish(event: AgentEvent): Promise<void> {
    await Promise.all([...this.subscribers.values()].filter(({ filter }) => eventMatchesFilter(event, filter)).map(({ handler }) => Promise.resolve(handler(event)).catch(() => undefined)));
  }

  subscribe(filter: EventSubscriptionFilter, handler: EventHandler): Unsubscribe {
    const id = this.nextId++;
    this.subscribers.set(id, { filter, handler });
    return () => this.subscribers.delete(id);
  }
}

export function eventMatchesFilter(event: AgentEvent, filter: EventSubscriptionFilter): boolean {
  if (filter.runId && event.runId !== filter.runId) return false;
  if (filter.eventTypes?.length && !filter.eventTypes.includes(event.type)) return false;
  if (filter.userId) {
    const payload = event.payload ?? {};
    const direct = typeof payload.userId === 'string' ? payload.userId : undefined;
    const metadata = isRecord(payload.metadata) ? payload.metadata : undefined;
    const runMetadata = isRecord(payload.runMetadata) ? payload.runMetadata : undefined;
    const values = [direct, typeof metadata?.userId === 'string' ? metadata.userId : undefined, typeof runMetadata?.userId === 'string' ? runMetadata.userId : undefined];
    if (!values.includes(filter.userId)) return false;
  }
  return true;
}

export class PublishingEventTraceStore {
  constructor(private readonly inner: { append(event: AgentEvent): Promise<void>; listByRun(runId: string): Promise<AgentEvent[]> }, private readonly bus: EventBus) {}

  async append(event: AgentEvent): Promise<void> {
    await this.inner.append(event);
    await this.bus.publish(event);
  }

  listByRun(runId: string): Promise<AgentEvent[]> {
    return this.inner.listByRun(runId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
