import { describe, expect, it } from 'vitest';
import { DialogueCoordinatorSkill } from './dialogue-coordinator';

function llm(content: unknown) {
  return {
    async chat() {
      return { content: JSON.stringify(content) };
    },
    async json<T>() { return {} as T; },
  };
}

describe('DialogueCoordinatorSkill', () => {
  it('keeps explanatory messages read-only', async () => {
    const skill = new DialogueCoordinatorSkill();
    const output = await skill.invoke({
      input: {
        articleId: 'art-1',
        message: '为什么这里要这样写？',
        context: { kind: 'outline-item', title: '当前大纲项', outlineItemId: 'sec-1' },
        outline: [],
      },
      context: { memory: {} } as never,
      llm: llm({ mode: 'answer', message: '这是解释。', operations: [{ type: 'revise-outline-item', outlineItemId: 'sec-1', instruction: '错误操作' }], warnings: [] }),
    });

    expect(output.mode).toBe('answer');
    expect(output.operations).toEqual([]);
  });

  it('normalizes selected outline item proposals', async () => {
    const skill = new DialogueCoordinatorSkill();
    const output = await skill.invoke({
      input: {
        articleId: 'art-1',
        message: '这里不要写成反对仕途经济。',
        context: { kind: 'outline-item', title: '当前大纲项', outlineItemId: 'sec-1' },
        outline: [],
      },
      context: { memory: {} } as never,
      llm: llm({ mode: 'proposal', message: '待确认。', summary: '修订大纲项', operations: [{ type: 'revise-outline-item', instruction: '不要写成反对仕途经济。' }], warnings: [] }),
    });

    expect(output.mode).toBe('proposal');
    expect(output.operations).toEqual([{ type: 'revise-outline-item', outlineItemId: 'sec-1', instruction: '不要写成反对仕途经济。' }]);
  });
});
