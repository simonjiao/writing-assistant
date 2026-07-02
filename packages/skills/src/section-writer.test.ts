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

function context() {
  return { knowledge, compactSummary: '', article: { outline: [], blocks: [] } } as never;
}

describe('SectionWriterSkill', () => {
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
