import { describe, expect, it } from 'vitest';
import { DialogueCoordinatorProgram } from './dialogue-coordinator';

function llm(content: unknown) {
  return {
    async chat() {
      return { content: JSON.stringify(content) };
    },
    async json<T>() { return {} as T; },
  };
}

describe('DialogueCoordinatorProgram', () => {
  it('keeps explanatory messages read-only', async () => {
    const program = new DialogueCoordinatorProgram();
    const output = await program.invoke({
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
    const program = new DialogueCoordinatorProgram();
    const output = await program.invoke({
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

  it('uses task-card context as the operation target when the model returns a block operation', async () => {
    const program = new DialogueCoordinatorProgram();
    const output = await program.invoke({
      input: {
        articleId: 'art-1',
        message: '限制评论和抒情，多用书中情节和人物表现。',
        context: { kind: 'task-card', title: '任务卡' },
        outline: [],
      },
      context: { memory: {} } as never,
      llm: llm({ mode: 'proposal', message: '待确认。', summary: '修订任务卡', operations: [{ type: 'patch-block', instruction: '限制评论和抒情，多用书中情节和人物表现。' }], warnings: [] }),
    });

    expect(output.mode).toBe('proposal');
    expect(output.operations).toEqual([{ type: 'revise-task-card', instruction: '限制评论和抒情，多用书中情节和人物表现。' }]);
  });

  it('fills block id from the current block context', async () => {
    const program = new DialogueCoordinatorProgram();
    const output = await program.invoke({
      input: {
        articleId: 'art-1',
        message: '压缩这一段。',
        context: { kind: 'block', title: '当前段落', blockId: 'blk-1' },
        outline: [],
      },
      context: { memory: {} } as never,
      llm: llm({ mode: 'proposal', message: '待确认。', summary: '修订段落', operations: [{ type: 'patch-block', instruction: '压缩这一段。' }], warnings: [] }),
    });

    expect(output.mode).toBe('proposal');
    expect(output.operations).toEqual([{ type: 'patch-block', blockId: 'blk-1', instruction: '压缩这一段。' }]);
  });
});
