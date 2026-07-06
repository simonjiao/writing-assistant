import { describe, expect, it } from 'vitest';
import { OutlineItem } from '@wa/core';
import { OutlineReviserSkill } from './outline-reviser';

const outline: OutlineItem[] = [
  { id: 'sec-1', title: '第一节', goal: '第一节目标。', order: 1, expectedBlocks: 1, rhetoricalRole: 'opening', keySection: false, specialHandling: ['开头提出核心问题。'], sourceHints: [], themeTags: [], status: 'confirmed' },
  { id: 'sec-2', title: '第二节', goal: '第二节目标。', order: 2, expectedBlocks: 1, rhetoricalRole: 'development', keySection: false, specialHandling: ['承接开头展开。'], sourceHints: [], themeTags: [], status: 'confirmed' },
  { id: 'sec-3', title: '第三节', goal: '第三节目标。', order: 3, expectedBlocks: 2, rhetoricalRole: 'turn', keySection: true, specialHandling: ['关键段落写出转折。'], sourceHints: [], themeTags: [], status: 'confirmed' },
  { id: 'sec-4', title: '第四节', goal: '第四节目标。', order: 4, expectedBlocks: 1, rhetoricalRole: 'conclusion', keySection: false, specialHandling: ['结尾收束全文。'], sourceHints: [], themeTags: [], status: 'confirmed' },
];

function llm(content: unknown) {
  return {
    async chat() {
      return { content: JSON.stringify(content) };
    },
    async json<T>() { return {} as T; },
  };
}

describe('OutlineReviserSkill', () => {
  it('normalizes a whole-outline revision and reorders by returned sequence', async () => {
    const skill = new OutlineReviserSkill();
    const output = await skill.invoke({
      input: {
        articleId: 'art-1',
        instruction: '整体调换顺序。',
        currentOutline: outline,
      },
      context: { memory: {} } as never,
      llm: llm({
        outline: [
          { ...outline[0], order: 88 },
          { ...outline[2], order: 77 },
          { ...outline[1], order: 99, title: '第二节调整后' },
          { ...outline[3], order: 66 },
        ],
        summary: '调整顺序。',
        changedFields: ['outline'],
        warnings: [],
      }),
    });

    expect(output.outline.map((item) => item.id)).toEqual(['sec-1', 'sec-3', 'sec-2', 'sec-4']);
    expect(output.outline.map((item) => item.order)).toEqual([1, 2, 3, 4]);
    expect(output.outline[2].title).toBe('第二节调整后');
    expect(output.outline[0].rhetoricalRole).toBe('opening');
    expect(output.outline[1].keySection).toBe(true);
  });

  it('rejects an empty outline', async () => {
    const skill = new OutlineReviserSkill();
    await expect(skill.invoke({
      input: { articleId: 'art-1', instruction: '清空。', currentOutline: outline },
      context: { memory: {} } as never,
      llm: llm({ outline: [], summary: '清空。', changedFields: [], warnings: [] }),
    })).rejects.toThrow('empty outline');
  });
});
