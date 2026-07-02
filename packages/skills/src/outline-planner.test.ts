import { describe, expect, it } from 'vitest';
import { WritingTaskCard } from '@wa/core';
import { OutlinePlannerSkill } from './outline-planner';

const taskCard: WritingTaskCard = {
  id: 'task_1',
  topic: '测试主题',
  writingGoal: '围绕测试主题完成一篇结构清楚的文章。',
  audience: '普通中文读者',
  scope: { editions: [], chapters: [], characters: [], themes: ['测试主题'] },
  structure: { articleType: 'analysis', expectedLength: '1200-2000字', outlinePreference: '分层展开。' },
  style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
  constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
  interactionMode: { askBeforeWriting: true, localEditFirst: true },
  status: 'confirmed',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function llmReturning(content: unknown) {
  return {
    async chat() { return { content: JSON.stringify(content) }; },
    async json<T>() { return {} as T; },
  };
}

describe('OutlinePlannerSkill', () => {
  it('accepts complete outline sections', async () => {
    const skill = new OutlinePlannerSkill();
    const output = await skill.invoke({
      input: { articleId: 'art_1', taskCard },
      context: { memory: {}, knowledge: [] } as never,
      llm: llmReturning({
        outline: [
          { title: '第一节', goal: '提出问题。', expectedBlocks: 1, sourceHints: [], themeTags: ['测试主题'] },
          { title: '第二节', goal: '展开背景。', expectedBlocks: 2, sourceHints: [], themeTags: ['测试主题'] },
          { title: '第三节', goal: '形成论证。', expectedBlocks: 2, sourceHints: [], themeTags: ['测试主题'] },
          { title: '第四节', goal: '收束结论。', expectedBlocks: 1, sourceHints: [], themeTags: ['测试主题'] },
        ],
        summary: '已生成完整大纲。',
      }),
    });
    expect(output.outline).toHaveLength(4);
    expect(output.outline[0].title).toBe('第一节');
    expect(output.outline[0].status).toBe('draft');
  });

  it('rejects incomplete outline sections', async () => {
    const skill = new OutlinePlannerSkill();
    await expect(skill.invoke({
      input: { articleId: 'art_1', taskCard },
      context: { memory: {}, knowledge: [] } as never,
      llm: llmReturning({
        outline: [
          { order: 1, expectedBlocks: 1, sourceHints: [], themeTags: ['测试主题'] },
          { title: '第二节', goal: '展开背景。', expectedBlocks: 2, sourceHints: [], themeTags: ['测试主题'] },
          { title: '第三节', goal: '形成论证。', expectedBlocks: 2, sourceHints: [], themeTags: ['测试主题'] },
          { title: '第四节', goal: '收束结论。', expectedBlocks: 1, sourceHints: [], themeTags: ['测试主题'] },
        ],
        summary: '已生成大纲。',
      }),
    })).rejects.toThrow('outline[0].title');
  });
});
