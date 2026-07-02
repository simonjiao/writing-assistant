import { ContextBuilder } from './context';
import { EventTraceStore } from './stores';
import { SkillRegistry } from './skill';
import { LLMProvider } from './types';
import { newId, nowIso } from './utils';

export interface InvokeSkillMeta {
  userId: string;
  sessionId?: string;
  runId?: string;
  workflowId?: string;
  articleId?: string;
  blockId?: string;
}

export class AgentRuntime {
  constructor(
    private readonly deps: {
      llm: LLMProvider;
      skillRegistry: SkillRegistry;
      contextBuilder: ContextBuilder;
      eventTraceStore?: EventTraceStore;
    },
  ) {}

  get skillRegistry(): SkillRegistry {
    return this.deps.skillRegistry;
  }

  async invokeSkill<I = unknown, O = unknown>(skillId: string, input: I, meta: InvokeSkillMeta): Promise<O> {
    const skill = this.deps.skillRegistry.get<I, O>(skillId);
    await this.deps.eventTraceStore?.append({
      id: newId('evt'),
      runId: meta.runId,
      type: 'skill.started',
      payload: { skillId, workflowId: meta.workflowId },
      createdAt: nowIso(),
    });

    const context = await this.deps.contextBuilder.build({
      userId: meta.userId,
      sessionId: meta.sessionId,
      runId: meta.runId,
      skillId,
      input,
      articleId: meta.articleId,
      blockId: meta.blockId,
    });

    const output = await skill.invoke({ input, context, llm: this.deps.llm });

    await this.deps.eventTraceStore?.append({
      id: newId('evt'),
      runId: meta.runId,
      type: 'skill.completed',
      payload: { skillId, workflowId: meta.workflowId },
      createdAt: nowIso(),
    });

    return output;
  }
}
