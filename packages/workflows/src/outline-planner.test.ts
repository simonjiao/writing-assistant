import { describe, expect, it } from 'vitest';
import { WritingTaskCard } from '@wa/core';
import { PromptProgram } from './prompt-program';
import { OutlinePlannerProgram } from './outline-planner';

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

function capturingLlm(content: unknown, calls: Array<{ messages: Array<{ role: string; content: string }> }>) {
  return {
    async chat(request: { messages: Array<{ role: string; content: string }> }) {
      calls.push({ messages: request.messages });
      return { content: JSON.stringify(content) };
    },
    async json<T>() { return {} as T; },
  };
}

const completeOutline = [
  { title: '第一节', goal: '提出一个分析判断。', expectedBlocks: 1, rhetoricalRole: 'opening', keySection: false, specialHandling: ['开头先提出核心问题，不铺陈背景。'], sourceHints: [], themeTags: ['测试主题'] },
  { title: '第二节', goal: '展开一个论证层次。', expectedBlocks: 2, rhetoricalRole: 'development', keySection: false, specialHandling: ['承接开头，推进第一层解释。'], sourceHints: [], themeTags: ['测试主题'] },
  { title: '第三节', goal: '比较另一组解释。', expectedBlocks: 2, rhetoricalRole: 'turn', keySection: true, specialHandling: ['作为关键段落，写清转折和比较关系，避免复述。'], sourceHints: [], themeTags: ['测试主题'] },
  { title: '第四节', goal: '收束概念层次。', expectedBlocks: 1, rhetoricalRole: 'conclusion', keySection: false, specialHandling: ['结尾回扣主题张力，不机械总结。'], sourceHints: [], themeTags: ['测试主题'] },
];

describe('OutlinePlannerProgram', () => {
  it('tells the model to organize arguments instead of story order', async () => {
    const program = new OutlinePlannerProgram();
    const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    await program.invoke({
      input: { articleId: 'art_1', taskCard },
      context: { memory: {}, knowledge: [] } as never,
      llm: capturingLlm({
        outline: [
          ...completeOutline,
        ],
        summary: '已生成论证型大纲。',
      }, calls),
    });
    const system = calls[0].messages.find((message) => message.role === 'system')?.content ?? '';
    const user = JSON.parse(calls[0].messages.find((message) => message.role === 'user')?.content ?? '{}') as { requiredOutputShape?: { outline?: Array<{ sourceHints?: string; rhetoricalRole?: string; specialHandling?: string }> } };
    expect(system).toContain('不要按原文出场顺序');
    expect(system).toContain('优先按问题、论点、对照关系、概念层次');
    expect(system).toContain('大纲必须明确全文起承转合');
    expect(system).toContain('第一节 rhetoricalRole 必须是 opening');
    expect(system).toContain('最后一节必须是 conclusion');
    expect(system).toContain('至少一个中间章节必须设置 keySection=true');
    expect(system).toContain('opening 不是背景介绍');
    expect(system).toContain('conclusion 不是复述摘要');
    expect(system).toContain('JSON 字符串内不能直接嵌套英文双引号');
    expect(system).toContain('必须遵守 taskCard.constraints.mustAvoid');
    expect(system).toContain('不要把 mustAvoid 中的内容改写成章节标题、章节目标、themeTags 或主体论点');
    expect(system).toContain('不要用“从不”“没有要求”“完全不要求”等绝对化表述');
    expect(system).toContain('有规劝但不等于认同某种功利价值');
    expect(user.requiredOutputShape?.outline?.[0]?.rhetoricalRole).toContain('opening');
    expect(user.requiredOutputShape?.outline?.[0]?.specialHandling).toContain('opening、conclusion、keySection=true 必须非空');
    expect(user.requiredOutputShape?.outline?.[0]?.sourceHints).toContain('原文顺序节点');
  });

  it('accepts complete outline sections', async () => {
    const program = new OutlinePlannerProgram();
    const output = await program.invoke({
      input: { articleId: 'art_1', taskCard },
      context: { memory: {}, knowledge: [] } as never,
      llm: llmReturning({
        outline: completeOutline,
        summary: '已生成完整大纲。',
      }),
    });
    expect(output.outline).toHaveLength(4);
    expect(output.outline[0].title).toBe('第一节');
    expect(output.outline[0].rhetoricalRole).toBe('opening');
    expect(output.outline[2].keySection).toBe(true);
    expect(output.outline[3].rhetoricalRole).toBe('conclusion');
    expect(output.outline[0].status).toBe('draft');
  });

  it('rejects incomplete outline sections', async () => {
    const program = new OutlinePlannerProgram();
    await expect(program.invoke({
      input: { articleId: 'art_1', taskCard },
      context: { memory: {}, knowledge: [] } as never,
      llm: llmReturning({
        outline: [
          { order: 1, expectedBlocks: 1, sourceHints: [], themeTags: ['测试主题'] },
          completeOutline[1],
          completeOutline[2],
          completeOutline[3],
        ],
        summary: '已生成大纲。',
      }),
    })).rejects.toThrow('outline[0].title');
  });

  it('rejects outlines without a key middle section', async () => {
    const program = new OutlinePlannerProgram();
    await expect(program.invoke({
      input: { articleId: 'art_1', taskCard },
      context: { memory: {}, knowledge: [] } as never,
      llm: llmReturning({
        outline: completeOutline.map((item) => ({ ...item, keySection: false })),
        summary: '已生成大纲。',
      }),
    })).rejects.toThrow('at least one middle section');
  });

  it('allows later forty chapter material when the task card does not set a closed source boundary', async () => {
    const program = new OutlinePlannerProgram();
    const output = await program.invoke({
      input: { articleId: 'art_1', taskCard },
      context: { memory: {}, knowledge: [] } as never,
      llm: llmReturning({
        outline: completeOutline.map((item, index) => index === 1 ? { ...item, goal: '比较通行本后四十回中的承接方式。' } : item),
        summary: '已生成不限定版本的大纲。',
      }),
    });

    expect(output.outline[1].goal).toContain('后四十回');
  });

  it('does not reject source boundary instructions in outline planning notes', async () => {
    const program = new OutlinePlannerProgram();
    const closedTaskCard: WritingTaskCard = {
      ...taskCard,
      constraints: {
        ...taskCard.constraints,
        mustAvoid: ['不得引用《红楼梦》后40回（程高本续书）的情节或任何文本'],
        sourcePolicy: '仅以《红楼梦》前80回和脂批为依据，不引用后40回（程高本续书）的情节或任何文本。',
      },
    };
    const output = await program.invoke({
      input: { articleId: 'art_1', taskCard: closedTaskCard },
      context: { memory: {}, knowledge: [] } as never,
      llm: llmReturning({
        outline: completeOutline.map((item, index) => index === 0 ? { ...item, specialHandling: ['开头先提出核心问题，不铺陈背景。', '不得引用《红楼梦》后40回（程高本续书）的情节或任何文本。'] } : item),
        summary: '已生成前80回边界下的大纲。',
      }),
    });

    expect(output.outline[0].specialHandling.join('\n')).toContain('不得引用');
  });

  it('rejects later forty chapter material when the task card sets a closed source boundary', async () => {
    const program = new OutlinePlannerProgram();
    const closedTaskCard: WritingTaskCard = {
      ...taskCard,
      constraints: {
        ...taskCard.constraints,
        sourcePolicy: '仅以《红楼梦》前80回和脂批为依据，不引用后40回（程高本续书）的情节或任何文本。',
      },
    };

    await expect(program.invoke({
      input: { articleId: 'art_1', taskCard: closedTaskCard },
      context: { memory: {}, knowledge: [] } as never,
      llm: llmReturning({
        outline: completeOutline.map((item, index) => index === 1 ? { ...item, goal: '依据程高本续书中的人物结局展开分析。' } : item),
        summary: '已生成错误大纲。',
      }),
    })).rejects.toThrow('violates source policy');
  });
});
