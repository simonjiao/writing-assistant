import { describe, expect, it } from 'vitest';
import { KnowledgeItem, OutlineItem, WritingTaskCard } from '@wa/core';
import { SectionWriterSkill } from './section-writer';

const taskCard: WritingTaskCard = {
  id: 'task_1',
  topic: '测试主题',
  writingGoal: '写一节分析性正文。',
  audience: '普通中文读者',
  scope: { editions: [], chapters: [], characters: [], themes: ['测试主题'] },
  structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
  style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
  constraints: { mustInclude: [], mustAvoid: [], citationRequired: true, sourcePolicy: '可短引材料，但不得堆砌原文。' },
  interactionMode: { askBeforeWriting: true, localEditFirst: true },
  status: 'confirmed',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const section: OutlineItem = {
  id: 'sec_1',
  title: '测试章节',
  goal: '围绕材料形成分析判断。',
  order: 1,
  expectedBlocks: 1,
  sourceHints: [],
  themeTags: ['测试主题'],
  status: 'draft',
};

const articleOutline: OutlineItem[] = [
  section,
  { ...section, id: 'sec_2', title: '第二节', order: 2 },
  { ...section, id: 'sec_3', title: '第三节', order: 3 },
  { ...section, id: 'sec_4', title: '第四节', order: 4 },
];

const knowledge: KnowledgeItem[] = [{
  id: 'k1',
  title: '测试资料',
  content: '这是一段用于测试的资料文本，包含很多连续句子，用来模拟检索资料。如果模型把这一整段连续内容搬进正文，就应该被拒绝，因为正文应当分析材料而不是复述材料。',
  sourceType: 'retriever',
  sourceRef: 'test:k1',
  themeTags: ['测试主题'],
  createdAt: new Date().toISOString(),
}];

function llmReturning(content: unknown) {
  return {
    async chat() { return { content: JSON.stringify(content) }; },
    async json<T>() { return {} as T; },
  };
}

function capturingLlm(content: unknown, calls: Array<{ messages: Array<{ role: string; content: string }>; maxTokens?: number }>) {
  return {
    async chat(request: { messages: Array<{ role: string; content: string }>; maxTokens?: number }) {
      calls.push({ messages: request.messages, maxTokens: request.maxTokens });
      return { content: JSON.stringify(content) };
    },
    async json<T>() { return {} as T; },
  };
}

function context() {
  return { knowledge, compactSummary: '', article: { outline: articleOutline, blocks: [] } } as never;
}

describe('SectionWriterSkill', () => {
  it('tells the model to write original analysis rather than translate or retell', async () => {
    const skill = new SectionWriterSkill();
    const calls: Array<{ messages: Array<{ role: string; content: string }>; maxTokens?: number }> = [];
    await skill.invoke({
      input: { articleId: 'art_1', section, taskCard },
      context: context(),
      llm: capturingLlm({
        block: {
          text: '本段先提出分析判断，再说明材料如何支撑这一判断，避免把资料翻译或复述成正文。',
          sourceRefs: ['test:k1'],
          themeTags: ['测试主题'],
        },
        candidateSources: ['test:k1'],
        summary: '已生成分析性正文。',
      }, calls),
    });
    const system = calls[0].messages.find((message) => message.role === 'system')?.content ?? '';
    const user = JSON.parse(calls[0].messages.find((message) => message.role === 'user')?.content ?? '{}') as { sourceUsePolicy?: { prohibitedModes?: string[] }; writingBudget?: { targetChars?: number; maxChars?: number } };
    expect(system).toContain('不是翻译、改写、转述、复述');
    expect(system).toContain('观点驱动');
    expect(user.sourceUsePolicy?.prohibitedModes).toEqual(['translation', 'paraphrase', 'retelling', 'source-summary']);
    expect(user.writingBudget).toMatchObject({ targetChars: 300, maxChars: 405 });
    expect(calls[0].maxTokens).toBeUndefined();
  });

  it('accepts analytical prose with several short quotations', async () => {
    const skill = new SectionWriterSkill();
    const output = await skill.invoke({
      input: { articleId: 'art_1', section, taskCard },
      context: context(),
      llm: llmReturning({
        block: {
          text: '这一节应先给出判断，再用材料作证。所谓“情理相生”“以情见理”“借事明心”，都是短引性质的提示；正文重点仍在解释材料如何支撑论点，而不是把材料自身搬运进来。',
          sourceRefs: ['test:k1'],
          themeTags: ['测试主题'],
        },
        candidateSources: ['test:k1'],
        summary: '已生成分析性正文。',
      }),
    });
    expect(output.block.text).toContain('正文重点仍在解释材料');
  });

  it('does not require duplicate top-level candidateSources when block sourceRefs are present', async () => {
    const skill = new SectionWriterSkill();
    const output = await skill.invoke({
      input: { articleId: 'art_1', section, taskCard },
      context: context(),
      llm: llmReturning({
        block: {
          text: '本段围绕章节目标提出判断，再用材料作为论证线索，正文重点放在解释家庭关系中的教育张力。',
          sourceRefs: ['test:k1'],
          themeTags: ['测试主题'],
        },
        summary: '已生成分析性正文。',
      }),
    });
    expect(output.candidateSources).toEqual(['test:k1']);
    expect(output.block.sourceRefs).toEqual(['test:k1']);
  });

  it('accepts multiple section blocks when expectedBlocks leads the model to split prose', async () => {
    const skill = new SectionWriterSkill();
    const output = await skill.invoke({
      input: { articleId: 'art_1', section: { ...section, expectedBlocks: 2 }, taskCard },
      context: context(),
      llm: llmReturning({
        blocks: [
          {
            text: '第一段先提出判断，说明事件中的管教冲突并非单一过错触发，而是多重压力叠加。',
            sourceRefs: ['test:k1'],
            themeTags: ['测试主题'],
          },
          {
            text: '第二段继续分析人物反应，把材料作为论据线索，而不是复述成故事经过。',
            sourceRefs: ['test:k1'],
            themeTags: ['测试主题'],
          },
        ],
        summary: '已生成多个正文块。',
      }),
    });
    expect(output.blocks).toHaveLength(2);
    expect(output.block.text).toContain('第一段');
    expect(output.candidateSources).toEqual(['test:k1']);
  });

  it('rejects quote-heavy prose', async () => {
    const skill = new SectionWriterSkill();
    await expect(skill.invoke({
      input: { articleId: 'art_1', section, taskCard },
      context: context(),
      llm: llmReturning({
        block: {
          text: '这一段几乎都在引用：“第一段很长的原文内容用于占据正文篇幅并替代分析判断。”“第二段很长的原文内容继续占据正文篇幅并替代分析判断。”“第三段很长的原文内容仍然占据正文篇幅并替代分析判断。”结尾只有一句短评。',
          sourceRefs: ['test:k1'],
          themeTags: ['测试主题'],
        },
        candidateSources: ['test:k1'],
        summary: '已生成正文。',
      }),
    })).rejects.toThrow('quote-heavy prose');
  });

  it('rejects sections that exceed the current section budget', async () => {
    const skill = new SectionWriterSkill();
    await expect(skill.invoke({
      input: { articleId: 'art_1', section, taskCard },
      context: context(),
      llm: llmReturning({
        block: {
          text: '分析判断。'.repeat(120),
          sourceRefs: ['test:k1'],
          themeTags: ['测试主题'],
        },
        candidateSources: ['test:k1'],
        summary: '已生成正文。',
      }),
    })).rejects.toThrow('exceeded current section length budget');
  });

  it('rejects prose that uses task card avoided terms from example lists', async () => {
    const skill = new SectionWriterSkill();
    await expect(skill.invoke({
      input: {
        articleId: 'art_1',
        section,
        taskCard: {
          ...taskCard,
          constraints: {
            ...taskCard.constraints,
            mustAvoid: ['现代哲学词汇（如价值观、责任观）'],
          },
        },
      },
      context: context(),
      llm: llmReturning({
        block: {
          text: '本段提出判断，但仍然把问题写成价值观冲突，因此没有遵守任务卡中的词汇限制。',
          sourceRefs: ['test:k1'],
          themeTags: ['测试主题'],
        },
        candidateSources: ['test:k1'],
        summary: '已生成正文。',
      }),
    })).rejects.toThrow('avoided terms: 价值观');
  });

  it('rejects modern commentary collocations when modern diction is constrained', async () => {
    const skill = new SectionWriterSkill();
    await expect(skill.invoke({
      input: {
        articleId: 'art_1',
        section,
        taskCard: {
          ...taskCard,
          constraints: {
            ...taskCard.constraints,
            mustAvoid: ['现代评论腔和现代抽象词汇（如价值观、责任观、维度）'],
          },
        },
      },
      context: context(),
      llm: llmReturning({
        block: {
          text: '本段提出判断，却把父子之争写成不可调和的产物，口吻更像现代评论而非文章正文。',
          sourceRefs: ['test:k1'],
          themeTags: ['测试主题'],
        },
        candidateSources: ['test:k1'],
        summary: '已生成正文。',
      }),
    })).rejects.toThrow('avoided terms: 不可调和的产物');
  });

  it('rejects long copied source passages', async () => {
    const skill = new SectionWriterSkill();
    await expect(skill.invoke({
      input: { articleId: 'art_1', section, taskCard },
      context: context(),
      llm: llmReturning({
        block: {
          text: `开头略作分析。${knowledge[0].content}结尾再补一句判断。`,
          sourceRefs: ['test:k1'],
          themeTags: ['测试主题'],
        },
        candidateSources: ['test:k1'],
        summary: '已生成正文。',
      }),
    })).rejects.toThrow('reused too much source text');
  });
});
