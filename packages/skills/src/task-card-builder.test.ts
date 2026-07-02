import { describe, expect, it } from 'vitest';
import { TaskCardBuilderSkill } from './task-card-builder';

const rawRequirement = '写一篇关于《红楼梦》中宝黛关系的长文，半文半白，不要太学术，重点写精神相通。';

function llmReturning(content: unknown) {
  return {
    async chat() { return { content: JSON.stringify(content) }; },
    async json<T>() { return {} as T; },
  };
}

describe('TaskCardBuilderSkill', () => {
  it('normalizes explicit user requirements without generating missing content', async () => {
    const skill = new TaskCardBuilderSkill();
    const output = await skill.invoke({
      input: { rawRequirement, userId: 'u1' },
      context: { memory: {} } as never,
      llm: llmReturning({
        taskCard: {
          topic: rawRequirement,
          writingGoal: rawRequirement,
          audience: '普通中文读者',
          scope: { editions: [], chapters: [], characters: [], themes: [] },
          structure: { articleType: 'essay', expectedLength: '3000-5000字', outlinePreference: '先立论，再分节展开。' },
          style: { register: '半文半白', tone: '典雅而不古奥，避免学术腔', classicalFlavor: false },
          constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作，必要时补充资料。' },
          interactionMode: { askBeforeWriting: false, localEditFirst: false },
          status: 'draft',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        missingQuestions: [],
        summary: '已生成任务卡。',
        confidence: 0.5,
      }),
    });
    expect(output.taskCard.topic).toBe('《红楼梦》中宝黛关系');
    expect(output.taskCard.structure.articleType).toBe('longform');
    expect(output.taskCard.style.classicalFlavor).toBe(true);
    expect(output.taskCard.constraints.mustInclude).toContain('精神相通');
    expect(output.taskCard.constraints.mustAvoid).toContain('不要太学术');
    expect(output.taskCard.scope.themes).toContain('《红楼梦》中宝黛关系');
    expect(output.taskCard.interactionMode.askBeforeWriting).toBe(true);
  });

  it('rejects incomplete model output instead of synthesizing content', async () => {
    const skill = new TaskCardBuilderSkill();
    await expect(skill.invoke({
      input: { rawRequirement, userId: 'u1' },
      context: { memory: {} } as never,
      llm: llmReturning({
        taskCard: {
          topic: '《红楼梦》中宝黛关系',
          writingGoal: rawRequirement,
          audience: '普通中文读者',
          scope: { editions: [], chapters: [], characters: [], themes: [] },
          structure: { articleType: 'longform', expectedLength: '3000-5000字', outlinePreference: '先立论，再分节展开。' },
          style: { register: '半文半白', tone: '', classicalFlavor: true },
          constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
          interactionMode: { askBeforeWriting: true, localEditFirst: true },
          status: 'draft',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        missingQuestions: [],
        summary: '已生成任务卡。',
      }),
    })).rejects.toThrow('taskCard.style.tone');
  });
});
