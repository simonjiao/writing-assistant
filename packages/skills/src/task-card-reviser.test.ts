import { describe, expect, it } from 'vitest';
import { WritingTaskCard } from '@wa/core';
import { TaskCardReviserSkill } from './task-card-reviser';

const currentTaskCard: WritingTaskCard = {
  id: 'task_1',
  topic: '旧主题',
  writingGoal: '写一篇旧目标文章。',
  audience: '普通读者',
  scope: { editions: [], chapters: [], characters: [], themes: ['旧主题'] },
  structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
  style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
  constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
  interactionMode: { askBeforeWriting: true, localEditFirst: true },
  status: 'confirmed',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function llmReturning(content: unknown) {
  return {
    async chat() { return { content: JSON.stringify(content) }; },
    async json<T>() { return {} as T; },
  };
}

function capturingLlm(content: unknown, calls: Array<{ messages: Array<{ role: string; content: string }> }>) {
  return {
    async chat(request: { messages: Array<{ role: string; content: string }> }) {
      calls.push({ messages: request.messages });
      return { content: JSON.stringify(content) };
    },
    async json<T>() { return {} as T; },
  };
}

describe('TaskCardReviserSkill', () => {
  it('constrains articleType to the supported enum', async () => {
    const skill = new TaskCardReviserSkill();
    const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    await skill.invoke({
      input: { articleId: 'art_1', instruction: '字数改到 900 字。', currentTaskCard },
      context: { memory: {} } as never,
      llm: capturingLlm({
        taskCard: {
          ...currentTaskCard,
          structure: { ...currentTaskCard.structure, expectedLength: '900字' },
        },
        summary: '已修改字数。',
        changedFields: ['structure.expectedLength'],
      }, calls),
    });
    const system = calls[0].messages.find((message) => message.role === 'system')?.content ?? '';
    const user = JSON.parse(calls[0].messages.find((message) => message.role === 'user')?.content ?? '{}') as { requiredOutputShape?: { taskCard?: string } };
    expect(system).toContain('必须把被否定的写法转入 taskCard.constraints.mustAvoid');
    expect(system).toContain('不能改成“从不要求宝玉”或“没有要求”');
    expect(system).toContain('有规劝但不等于认同仕途经济价值');
    expect(system).toContain('只能是 essay、analysis、commentary、speech、longform');
    expect(system).toContain('不要输出 shortform');
    expect(user.requiredOutputShape?.taskCard).toContain('essay | analysis | commentary | speech | longform');
  });

  it('revises the task card from a natural language instruction', async () => {
    const skill = new TaskCardReviserSkill();
    const output = await skill.invoke({
      input: { articleId: 'art_1', instruction: '主题改成新主题，目标更偏论证。', currentTaskCard },
      context: { memory: {} } as never,
      llm: llmReturning({
        taskCard: {
          ...currentTaskCard,
          id: 'model_should_not_replace_id',
          topic: '新主题',
          writingGoal: '围绕新主题形成论证型文章。',
          scope: { editions: [], chapters: [], characters: [], themes: ['新主题'] },
        },
        summary: '已修改主题和写作目标。',
        changedFields: ['topic', 'writingGoal', 'scope.themes'],
      }),
    });
    expect(output.taskCard.id).toBe(currentTaskCard.id);
    expect(output.taskCard.status).toBe('confirmed');
    expect(output.taskCard.topic).toBe('新主题');
    expect(output.changedFields).toContain('writingGoal');
  });

  it('keeps modern commentary complaints as avoid constraints', async () => {
    const skill = new TaskCardReviserSkill();
    const output = await skill.invoke({
      input: { articleId: 'art_1', instruction: '还有不可调和的产物，像是个现代评论。', currentTaskCard },
      context: { memory: {} } as never,
      llm: llmReturning({
        taskCard: {
          ...currentTaskCard,
          constraints: { ...currentTaskCard.constraints, mustAvoid: [] },
        },
        summary: '已增加语言限制。',
        changedFields: ['constraints.mustAvoid'],
      }),
    });
    expect(output.taskCard.constraints.mustAvoid).toContain('现代评论腔和现代抽象词汇（如价值观、责任观、世界观、维度、机制、结构性、主体性、规训、不可调和的产物）');
  });

  it('rejects incomplete revised task cards', async () => {
    const skill = new TaskCardReviserSkill();
    await expect(skill.invoke({
      input: { articleId: 'art_1', instruction: '清空目标。', currentTaskCard },
      context: { memory: {} } as never,
      llm: llmReturning({
        taskCard: {
          ...currentTaskCard,
          writingGoal: '',
        },
        summary: '已修改。',
        changedFields: ['writingGoal'],
      }),
    })).rejects.toThrow('taskCard.writingGoal');
  });
});
