import { describe, expect, it } from 'vitest';
import { OutlineItem, WritingTaskCard } from '@wa/core';
import { OutlineItemReviserSkill } from './outline-item-reviser';

const currentOutlineItem: OutlineItem = {
  id: 'sec-1',
  title: '旧标题',
  goal: '旧目标。',
  order: 2,
  expectedBlocks: 2,
  rhetoricalRole: 'turn',
  keySection: true,
  specialHandling: ['这里是全文关键转折，必须先修正误解再推进判断。'],
  sourceHints: ['旧来源'],
  themeTags: ['旧标签'],
  status: 'confirmed',
};

const taskCard: WritingTaskCard = {
  id: 'task-1',
  topic: '任务主题',
  writingGoal: '写一篇分析文章。',
  audience: '普通读者',
  scope: { editions: [], chapters: [], characters: [], themes: ['任务主题'] },
  structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
  style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
  constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
  interactionMode: { askBeforeWriting: true, localEditFirst: true },
  status: 'confirmed',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function capturingLlm(content: unknown, calls: Array<{ messages: Array<{ role: string; content: string }> }>) {
  return {
    async chat(request: { messages: Array<{ role: string; content: string }> }) {
      calls.push({ messages: request.messages });
      return { content: JSON.stringify(content) };
    },
    async json<T>() { return {} as T; },
  };
}

describe('OutlineItemReviserSkill', () => {
  it('revises only the selected outline item and preserves stable fields', async () => {
    const skill = new OutlineItemReviserSkill();
    const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const output = await skill.invoke({
      input: {
        articleId: 'art-1',
        instruction: '把标题改成新标题，目标避免说黛玉完全反对仕途经济。',
        currentOutlineItem,
        taskCard,
        articleOutline: [currentOutlineItem],
      },
      context: { memory: {} } as never,
      llm: capturingLlm({
        outlineItem: {
          ...currentOutlineItem,
          id: 'model-must-not-replace-id',
          order: 99,
          status: 'written',
          title: '新标题',
          goal: '说明黛玉有规劝，但不等于认同仕途经济价值。',
        },
        summary: '修正标题和目标。',
        changedFields: ['title', 'goal'],
      }, calls),
    });

    expect(output.outlineItem.id).toBe(currentOutlineItem.id);
    expect(output.outlineItem.order).toBe(currentOutlineItem.order);
    expect(output.outlineItem.status).toBe(currentOutlineItem.status);
    expect(output.outlineItem.rhetoricalRole).toBe('turn');
    expect(output.outlineItem.keySection).toBe(true);
    expect(output.outlineItem.specialHandling).toEqual(['这里是全文关键转折，必须先修正误解再推进判断。']);
    expect(output.outlineItem.title).toBe('新标题');
    expect(output.outlineItem.goal).toContain('有规劝');
    expect(output.changedFields).toEqual(['title', 'goal']);

    const system = calls[0].messages.find((message) => message.role === 'system')?.content ?? '';
    expect(system).toContain('只能修改 currentOutlineItem');
    expect(system).toContain('不要修改任务卡');
    expect(system).toContain('不要生成正文');
    expect(system).toContain('起承转合');
    expect(system).toContain('关键段落');
  });

  it('rejects incomplete outline item revisions', async () => {
    const skill = new OutlineItemReviserSkill();
    await expect(skill.invoke({
      input: { articleId: 'art-1', instruction: '清空标题。', currentOutlineItem },
      context: { memory: {} } as never,
      llm: capturingLlm({
        outlineItem: { ...currentOutlineItem, title: '' },
        summary: '清空标题。',
        changedFields: ['title'],
      }, []),
    })).rejects.toThrow('outlineItem.title');
  });
});
