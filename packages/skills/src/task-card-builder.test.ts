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

  it('merges selected domain profile context into the task card', async () => {
    const skill = new TaskCardBuilderSkill();
    const output = await skill.invoke({
      input: {
        rawRequirement: '写一篇关于宝黛精神相通的文章。',
        userId: 'u1',
        domainContext: {
          profileId: 'hongloumeng-baodai',
          label: '红楼梦：宝黛关系',
          editions: ['脂评本'],
          themes: ['仕途经济边界'],
          mustInclude: ['黛玉有规劝，但不等于认同仕途经济价值。'],
          mustAvoid: ['黛玉从不要求宝玉'],
          sourcePolicies: ['以脂评本前八十回为主要依据。'],
        },
      },
      context: { memory: {} } as never,
      llm: llmReturning({
        taskCard: {
          topic: '宝黛精神相通',
          writingGoal: '分析宝黛精神相通。',
          audience: '普通中文读者',
          scope: { editions: [], chapters: [], characters: [], themes: [] },
          structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
          style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
          constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
          interactionMode: { askBeforeWriting: true, localEditFirst: true },
        },
        missingQuestions: [],
        summary: '已生成任务卡。',
        confidence: 0.8,
      }),
    });
    expect(output.taskCard.scope.editions).toContain('脂评本');
    expect(output.taskCard.scope.themes).toContain('仕途经济边界');
    expect(output.taskCard.constraints.mustInclude).toContain('黛玉有规劝，但不等于认同仕途经济价值。');
    expect(output.taskCard.constraints.mustAvoid).toContain('黛玉从不要求宝玉');
    expect(output.taskCard.constraints.sourcePolicy).toContain('以脂评本前八十回为主要依据');
  });
});
