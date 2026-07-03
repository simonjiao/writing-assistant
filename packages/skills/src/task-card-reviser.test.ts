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

describe('TaskCardReviserSkill', () => {
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
