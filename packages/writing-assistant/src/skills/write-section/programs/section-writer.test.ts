import { describe, expect, it } from 'vitest';
import { KnowledgeItem, OutlineItem, WritingTaskCard } from '@wa/core';
import { PromptProgram } from '@wa/runtime';
import { SectionWriterProgram } from './section-writer';

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
  rhetoricalRole: 'opening',
  keySection: false,
  specialHandling: ['开头先提出核心问题，不铺陈背景。'],
  sourceHints: [],
  themeTags: ['测试主题'],
  status: 'draft',
};

const articleOutline: OutlineItem[] = [
  section,
  { ...section, id: 'sec_2', title: '第二节', order: 2, rhetoricalRole: 'development', specialHandling: ['承接开头继续推进。'] },
  { ...section, id: 'sec_3', title: '第三节', order: 3, rhetoricalRole: 'turn', keySection: true, specialHandling: ['关键段落写出转折。'] },
  { ...section, id: 'sec_4', title: '第四节', order: 4, rhetoricalRole: 'conclusion', specialHandling: ['结尾收束全文。'] },
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

const secondKnowledge: KnowledgeItem = {
  id: 'k3',
  title: '另一条测试资料',
  content: '另一条材料用于支撑后续章节的新角度，避免每一节都重复同一条依据。',
  sourceType: 'retriever',
  sourceRef: 'test:k3',
  themeTags: ['测试主题'],
  createdAt: new Date().toISOString(),
};

const disallowedKnowledge: KnowledgeItem = {
  id: 'k2',
  title: '程高本后40回材料',
  content: '这是来自后四十回续书的材料，不应进入只依据前八十回和脂批的写作。',
  sourceType: 'retriever',
  sourceRef: 'chenggao:后40回:k2',
  themeTags: ['后40回'],
  createdAt: new Date().toISOString(),
};

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

function sequentialCapturingLlm(contents: unknown[], calls: Array<{ messages: Array<{ role: string; content: string }>; maxTokens?: number }>) {
  let index = 0;
  return {
    async chat(request: { messages: Array<{ role: string; content: string }>; maxTokens?: number }) {
      calls.push({ messages: request.messages, maxTokens: request.maxTokens });
      const content = contents[Math.min(index, contents.length - 1)];
      index += 1;
      return { content: JSON.stringify(content) };
    },
    async json<T>() { return {} as T; },
  };
}

function context() {
  return { knowledge, compactSummary: '', article: { outline: articleOutline, blocks: [] } } as never;
}

describe('SectionWriterProgram', () => {
  it('tells the model to write original analysis rather than translate or retell', async () => {
    const program = new SectionWriterProgram();
    const calls: Array<{ messages: Array<{ role: string; content: string }>; maxTokens?: number }> = [];
    await program.invoke({
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
    const user = JSON.parse(calls[0].messages.find((message) => message.role === 'user')?.content ?? '{}') as { sourceUsePolicy?: { prohibitedModes?: string[] }; writingBudget?: { targetChars?: number; maxChars?: number }; writingContinuity?: { currentSection?: { title?: string; rhetoricalRole?: string; specialHandling?: string[] }; policy?: string[] } };
    expect(system).toContain('不是翻译、改写、转述、复述');
    expect(system).toContain('观点驱动');
    expect(system).toContain('整篇文章的一环');
    expect(system).toContain('section.rhetoricalRole 控制本节在全文中的起承转合位置');
    expect(system).toContain('opening 要直接建立核心问题');
    expect(system).toContain('turn 要写出论证转折');
    expect(system).toContain('conclusion 要收束全文判断');
    expect(system).toContain('block.sourceRefs 必须绑定');
    expect(user.sourceUsePolicy?.prohibitedModes).toEqual(['translation', 'paraphrase', 'retelling', 'source-summary']);
    expect(user.writingBudget).toMatchObject({ targetChars: 300, maxChars: 470, allocationBasis: expect.stringContaining('expectedBlocks') });
    expect(user.writingContinuity?.currentSection?.title).toBe('测试章节');
    expect(user.writingContinuity?.currentSection?.rhetoricalRole).toBe('opening');
    expect(user.writingContinuity?.currentSection?.specialHandling).toEqual(['开头先提出核心问题，不铺陈背景。']);
    expect(user.writingContinuity?.policy?.join('；')).toContain('前文尚未使用的来源');
    expect(user.writingContinuity?.policy?.join('；')).toContain('本节是开头');
    expect(calls[0].maxTokens).toBeUndefined();
  });

  it('allocates a larger budget to outline sections with more expected blocks', async () => {
    const program = new SectionWriterProgram();
    const calls: Array<{ messages: Array<{ role: string; content: string }>; maxTokens?: number }> = [];
    await program.invoke({
      input: { articleId: 'art_1', section: { ...section, id: 'sec_3', title: '主体章节', order: 3, expectedBlocks: 3 }, taskCard },
      context: {
        knowledge,
        compactSummary: '',
        article: {
          outline: [
            section,
            { ...section, id: 'sec_2', title: '第二节', order: 2, expectedBlocks: 1 },
            { ...section, id: 'sec_3', title: '主体章节', order: 3, expectedBlocks: 3 },
            { ...section, id: 'sec_4', title: '第四节', order: 4, expectedBlocks: 1 },
          ],
          blocks: [],
        },
      } as never,
      llm: capturingLlm({
        block: {
          text: '主体章节获得更多篇幅后，仍然先提出判断，再说明材料怎样支撑这一判断。',
          sourceRefs: ['test:k1'],
          themeTags: ['测试主题'],
        },
        summary: '已生成分析性正文。',
      }, calls),
    });
    const user = JSON.parse(calls[0].messages.find((message) => message.role === 'user')?.content ?? '{}') as { writingBudget?: { targetChars?: number; maxChars?: number; currentSectionWeight?: number; totalSectionWeight?: number } };
    expect(user.writingBudget).toMatchObject({ currentSectionWeight: 3, totalSectionWeight: 6, targetChars: 600, maxChars: 860 });
  });

  it('filters knowledge that conflicts with a closed pre-80 source policy', async () => {
    const program = new SectionWriterProgram();
    const calls: Array<{ messages: Array<{ role: string; content: string }>; maxTokens?: number }> = [];
    await program.invoke({
      input: {
        articleId: 'art_1',
        section,
        taskCard: {
          ...taskCard,
          constraints: {
            ...taskCard.constraints,
            sourcePolicy: '允许引用《红楼梦》前80回原文和脂批，正文以原创分析为主。',
          },
        },
      },
      context: { knowledge: [...knowledge, disallowedKnowledge], compactSummary: '', article: { outline: articleOutline, blocks: [] } } as never,
      llm: capturingLlm({
        block: {
          text: '本段先提出分析判断，再说明前八十回材料如何支撑这一判断，正文重点放在解释人物处境。',
          sourceRefs: ['test:k1'],
          themeTags: ['测试主题'],
        },
        summary: '已生成分析性正文。',
      }, calls),
    });
    const user = JSON.parse(calls[0].messages.find((message) => message.role === 'user')?.content ?? '{}') as { knowledge?: KnowledgeItem[] };
    expect(user.knowledge?.map((item) => item.sourceRef)).toEqual(['test:k1']);
  });

  it('does not pass unsupported source hints as writing evidence', async () => {
    const program = new SectionWriterProgram();
    const calls: Array<{ messages: Array<{ role: string; content: string }>; maxTokens?: number }> = [];
    const chapterKnowledge: KnowledgeItem = {
      id: 'k61',
      title: '第061回｜司棋索要鸡蛋',
      content: '第61回写司棋要一碗嫩炖鸡蛋，厨房推托，莲花儿与柳家的争执升级。',
      sourceType: 'retriever',
      sourceRef: 'test:c061',
      themeTags: ['base_text'],
      createdAt: new Date().toISOString(),
    };
    await program.invoke({
      input: {
        articleId: 'art_1',
        section: {
          ...section,
          sourceHints: ['第61回司棋派小丫头怒砸厨房、打砸物品', '脂批云“司棋事从书画中翻出”'],
        },
        taskCard: { ...taskCard, scope: { ...taskCard.scope, characters: ['司棋'] } },
      },
      context: { knowledge: [chapterKnowledge], compactSummary: '', article: { outline: articleOutline, blocks: [] } } as never,
      llm: capturingLlm({
        block: {
          text: '第六十一回中，司棋因厨房炖蛋一事动怒，本段据此分析她不肯受慢待的性情。',
          sourceRefs: ['test:c061'],
          themeTags: ['测试主题'],
        },
        summary: '已生成正文。',
      }, calls),
    });
    const user = JSON.parse(calls[0].messages.find((message) => message.role === 'user')?.content ?? '{}') as { section?: { sourceHints?: string[] }; sourceHintsPolicy?: { unsupportedSourceHints?: string[] } };
    expect(user.section?.sourceHints).toEqual(['第61回司棋派小丫头怒砸厨房、打砸物品']);
    expect(user.sourceHintsPolicy?.unsupportedSourceHints).toEqual(['脂批云“司棋事从书画中翻出”']);
  });

  it('rejects generated prose that references the later 40 chapters under a pre-80 policy', async () => {
    const program = new SectionWriterProgram();
    await expect(program.invoke({
      input: {
        articleId: 'art_1',
        section,
        taskCard: {
          ...taskCard,
          constraints: {
            ...taskCard.constraints,
            sourcePolicy: '允许引用《红楼梦》前80回原文和脂批，正文以原创分析为主。',
          },
        },
      },
      context: context(),
      llm: llmReturning({
        block: {
          text: '本段错误地转向程高本续书的后40回材料，以此说明人物结局，已经越出任务卡限定的来源范围。',
          sourceRefs: ['chenggao:后40回:k2'],
          themeTags: ['测试主题'],
        },
        summary: '已生成正文。',
      }),
    })).rejects.toThrow('violates source policy');
  });

  it('accepts analytical prose with several short quotations', async () => {
    const program = new SectionWriterProgram();
    const output = await program.invoke({
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

  it('rejects source-backed claims without sourceRefs', async () => {
    const program = new SectionWriterProgram();
    await expect(program.invoke({
      input: { articleId: 'art_1', section, taskCard },
      context: context(),
      llm: llmReturning({
        block: {
          text: '脂批点出此处另有深意，本段据此展开分析，但没有绑定任何来源。',
          sourceRefs: [],
          themeTags: ['测试主题'],
        },
        summary: '已生成正文。',
      }),
    })).rejects.toThrow('without sourceRefs');
  });

  it('repairs source-backed prose by adding sourceRefs from knowledge', async () => {
    const program = new SectionWriterProgram();
    const calls: Array<{ messages: Array<{ role: string; content: string }>; maxTokens?: number }> = [];
    const output = await program.invoke({
      input: { articleId: 'art_1', section, taskCard },
      context: context(),
      llm: sequentialCapturingLlm([
        {
          block: {
            text: '脂批点出此处另有深意，本段据此展开分析，但没有绑定任何来源。',
            sourceRefs: [],
            themeTags: ['测试主题'],
          },
          summary: '已生成正文。',
        },
        {
          blocks: [{
            text: '脂批点出此处另有深意，本段据此展开分析，并回到章节自身的论点。',
            sourceRefs: ['test:k1'],
            themeTags: ['测试主题'],
          }],
          summary: '已修复来源绑定。',
        },
      ], calls),
    });
    expect(output.block.sourceRefs).toEqual(['test:k1']);
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.find((message) => message.role === 'system')?.content).toContain('来源绑定修订器');
  });

  it('repairs optional-citation prose by removing unsupported source signals', async () => {
    const program = new SectionWriterProgram();
    const relaxedTaskCard: WritingTaskCard = { ...taskCard, constraints: { ...taskCard.constraints, citationRequired: false } };
    const output = await program.invoke({
      input: { articleId: 'art_1', section, taskCard: relaxedTaskCard },
      context: { knowledge: [], compactSummary: '', article: { outline: articleOutline, blocks: [] } } as never,
      llm: sequentialCapturingLlm([
        {
          block: {
            text: '脂批点出此处另有深意，本段据此展开分析，但没有绑定任何来源。',
            sourceRefs: [],
            themeTags: ['测试主题'],
          },
          summary: '已生成正文。',
        },
        {
          blocks: [{
            text: '这一节先从人物的自尊与处境入手，说明她的强硬不是孤立性格，而是被压迫处境逼出的自我维护。',
            sourceRefs: [],
            themeTags: ['测试主题'],
          }],
          summary: '已去除无来源支撑的来源性表述。',
        },
      ], []),
    });
    expect(output.block.sourceRefs).toEqual([]);
    expect(output.block.text).not.toContain('脂批');
  });

  it('uses top-level candidateSources when source-backed prose needs refs', async () => {
    const program = new SectionWriterProgram();
    const output = await program.invoke({
      input: { articleId: 'art_1', section, taskCard },
      context: context(),
      llm: llmReturning({
        block: {
          text: '脂批点出此处另有深意，本段据此展开分析，并回到章节自身的论点。',
          sourceRefs: [],
          themeTags: ['测试主题'],
        },
        candidateSources: ['test:k1'],
        summary: '已生成正文。',
      }),
    });
    expect(output.block.sourceRefs).toEqual(['test:k1']);
  });

  it('infers sourceRefs from retrieved section knowledge without a second model call', async () => {
    const program = new SectionWriterProgram();
    const calls: Array<{ messages: Array<{ role: string; content: string }>; maxTokens?: number }> = [];
    const chapterKnowledge: KnowledgeItem = {
      id: 'k61',
      title: '第061回｜司棋索要鸡蛋',
      content: '第61回写司棋要一碗嫩炖鸡蛋，厨房推托，莲花儿与柳家的争执升级。',
      sourceType: 'retriever',
      sourceRef: 'test:c061',
      themeTags: ['base_text'],
      createdAt: new Date().toISOString(),
    };
    const output = await program.invoke({
      input: {
        articleId: 'art_1',
        section: {
          ...section,
          sourceHints: ['第61回司棋派小丫头怒砸厨房、打砸物品'],
        },
        taskCard,
      },
      context: { knowledge: [chapterKnowledge], compactSummary: '', article: { outline: articleOutline, blocks: [] } } as never,
      llm: capturingLlm({
        block: {
          text: '第六十一回中，司棋因厨房炖蛋一事动怒，本段据此分析她不肯受慢待的性情。',
          sourceRefs: [],
          themeTags: ['测试主题'],
        },
        summary: '已生成正文。',
      }, calls),
    });
    expect(output.block.sourceRefs).toEqual(['test:c061']);
    expect(calls).toHaveLength(1);
  });

  it('augments explicit commentary refs with matched primary text refs', async () => {
    const program = new SectionWriterProgram();
    const output = await program.invoke({
      input: {
        articleId: 'art_1',
        section: {
          ...section,
          sourceHints: ['第74回司棋抄检时并无畏惧惭愧之意'],
        },
        taskCard,
      },
      context: {
        knowledge: [
          {
            id: 'k74-text',
            title: '第074回｜正文片段',
            content: '凤姐见司棋低头不语，也并无畏惧惭愧之意，倒觉可异。',
            sourceType: 'retriever',
            sourceRef: 'test:c074:text',
            themeTags: ['base_text'],
            createdAt: new Date().toISOString(),
          },
          {
            id: 'k74-commentary',
            title: '第074回｜批语',
            content: '紙就好。餘為司棋心動。',
            sourceType: 'retriever',
            sourceRef: 'test:c074:commentary',
            themeTags: ['commentary'],
            createdAt: new Date().toISOString(),
          },
        ],
        compactSummary: '',
        article: { outline: articleOutline, blocks: [] },
      } as never,
      llm: llmReturning({
        block: {
          text: '第七十四回抄检时，司棋“并无畏惧惭愧之意”，脂批亦为司棋心动，本段据此分析她的刚烈。',
          sourceRefs: ['test:c074:commentary'],
          themeTags: ['测试主题'],
        },
        summary: '已生成正文。',
      }),
    });
    expect(output.block.sourceRefs).toEqual(['test:c074:commentary', 'test:c074:text']);
  });

  it('allows reused sourceRefs when unused sources are available', async () => {
    const program = new SectionWriterProgram();
    const output = await program.invoke({
      input: { articleId: 'art_1', section, taskCard },
      context: {
        knowledge: [...knowledge, secondKnowledge],
        compactSummary: '',
        article: {
          outline: articleOutline,
          blocks: [{
            id: 'blk_old',
            type: 'section',
            sectionId: 'sec_0',
            title: '前一节',
            text: '前文已经使用过第一条测试资料说明论点。',
            sourceRefs: ['test:k1'],
            themeTags: ['测试主题'],
            status: 'draft',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }],
        },
      } as never,
      llm: llmReturning({
        block: {
          text: '本段仍然只围绕旧材料展开判断，虽然还有新的材料可用。',
          sourceRefs: ['test:k1'],
          themeTags: ['测试主题'],
        },
        summary: '已生成正文。',
      }),
    });
    expect(output.block.sourceRefs).toEqual(['test:k1']);
  });

  it('does not require duplicate top-level candidateSources when block sourceRefs are present', async () => {
    const program = new SectionWriterProgram();
    const output = await program.invoke({
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
    const program = new SectionWriterProgram();
    const output = await program.invoke({
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
    expect(output.blocks[0].title).toBe('测试章节');
    expect(output.blocks[1].title).toBeUndefined();
    expect(output.candidateSources).toEqual(['test:k1']);
  });

  it('rejects quote-heavy prose', async () => {
    const program = new SectionWriterProgram();
    await expect(program.invoke({
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

  it('asks for a compressed rewrite when a section exceeds the current budget', async () => {
    const program = new SectionWriterProgram();
    const calls: Array<{ messages: Array<{ role: string; content: string }>; maxTokens?: number }> = [];
    const output = await program.invoke({
      input: { articleId: 'art_1', section, taskCard },
      context: context(),
      llm: sequentialCapturingLlm([
        {
          block: {
            text: '分析判断。'.repeat(150),
            sourceRefs: ['test:k1'],
            themeTags: ['测试主题'],
          },
          candidateSources: ['test:k1'],
          summary: '初稿过长。',
        },
        {
          block: {
            text: '本节保留核心判断，删去重复铺陈，只说明材料如何支撑论点，并回到章节目标。',
            sourceRefs: ['test:k1'],
            themeTags: ['测试主题'],
          },
          candidateSources: ['test:k1'],
          summary: '已压缩为合格正文。',
        },
      ], calls),
    });
    expect(output.block.text).toContain('删去重复铺陈');
    expect(calls).toHaveLength(2);
    expect(calls[1].messages[0].content).toContain('章节正文压缩编辑器');
  });

  it('rejects sections that still exceed the current section budget after rewrite', async () => {
    const program = new SectionWriterProgram();
    await expect(program.invoke({
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
    const program = new SectionWriterProgram();
    await expect(program.invoke({
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
    const program = new SectionWriterProgram();
    await expect(program.invoke({
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
    const program = new SectionWriterProgram();
    await expect(program.invoke({
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
