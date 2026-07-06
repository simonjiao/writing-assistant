import { ArticleArtifact, ArticleBlock, KnowledgeItem, newId, nowIso, OutlineItem, safeJsonParse, Skill, WritingTaskCard } from '@wa/core';
import { filterKnowledgeByTaskCardPolicy, normalizeTaskCardPolicies, validateGeneratedTextAgainstTaskCardPolicy } from './task-card-policy';
import { findAvoidedTermsInText } from './writing-constraints';

export interface SectionWriterInput {
  articleId: string;
  section: OutlineItem;
  taskCard: WritingTaskCard;
}

export interface SectionWriterOutput {
  block: ArticleBlock;
  blocks: ArticleBlock[];
  candidateSources: string[];
  summary: string;
}

interface SectionWriterRawOutput {
  block?: Partial<ArticleBlock>;
  blocks?: Array<Partial<ArticleBlock>>;
  candidateSources?: unknown;
  summary?: unknown;
}

export class SectionWriterSkill implements Skill<SectionWriterInput, SectionWriterOutput> {
  manifest = {
    id: 'section-writer',
    name: 'Section Writer',
    version: '0.1.0',
    description: '根据任务卡和大纲节点生成章节正文。',
    policies: {
      doNotOverwriteExistingBlocks: true,
      bindSourcesWhenAvailable: true,
    },
  };

  async invoke({ input, context, llm }: Parameters<Skill<SectionWriterInput, SectionWriterOutput>['invoke']>[0]): Promise<SectionWriterOutput> {
    const taskCard = normalizeTaskCardPolicies(input.taskCard).taskCard;
    const knowledge = filterKnowledgeByTaskCardPolicy(context.knowledge, taskCard);
    const writingContinuity = buildWritingContinuity(input, context.article, knowledge);
    const sectionKnowledge = prioritizeSectionKnowledge(knowledge, writingContinuity);
    const writingBudget = buildSectionWritingBudget(taskCard, input.section, context.article);
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0.45,
      messages: [
        {
          role: 'system',
          content: [
            '你是写作助手的章节写作者。',
            '你的任务是原创写作和论证展开，不是翻译、改写、转述、复述或资料整理。',
            '只输出 JSON：blocks、summary；blocks 必须是 ArticleBlock 数组，每个 block.sourceRefs 必须是 string[]，没有可用来源时输出 []。',
            'section.expectedBlocks 是正文块数量参考；如果只需要一个正文块，blocks 输出长度为 1 的数组。',
            '每个 block.text 必须是完整正文，不能留空。',
            '所有 blocks 的正文总字数不得超过 writingBudget.maxChars；宁可凝练，不要超预算。',
            '资料和原文只能作为证据，不得把整段原文、资料摘要或近似复述当作正文主体。',
            '正文应以分析、判断、过渡和解释为主；可以短引关键词句，但引用不能承担正文主体。',
            '不要写成故事梗概、人物小传、原著情节重述或“话说/看官听说”式讲述。',
            '每个自然段优先给出判断句，再解释这个判断，再用少量材料作证，最后回到本节论点。',
            '如果大纲或资料带有复述倾向，先把它转化为分析问题，再写成观点驱动的正文。',
            '本次只写当前章节，不写整篇文章；必须遵守 writingBudget 的当前章节字数范围。',
            '必须把本节写成整篇文章的一环：承接 writingContinuity 中的前文推进，不要重新介绍已经写过的判断。',
            '不要重复 writingContinuity.recentBlocks 中已有的观点、例证和批语；同一来源已被前文使用时，优先改用 unusedSourceRefs 中的来源。',
            '提到非本节核心人物、事件或批语时，必须在同句或邻近句交代它与本节论点的关系，不能只抛出名字。',
            '正文凡提到原文、回目、脂批、批语、引文或具体来源依据，对应 block.sourceRefs 必须绑定 knowledge 中的 sourceRef。',
            'taskCard.topRules.writingStandards 是顶部写作规则，优先级高于普通风格偏好、资料口吻和大纲措辞。',
            '如有 taskCard.topRules.replacementHints，必须优先采用 prefer 中的替代表达，不要使用 avoid 中的词。',
            '必须遵守 taskCard.constraints.mustAvoid；不得使用其中明示的禁用词、禁用说法，以及括号中“如/例如/比如”列出的词。',
            '必须遵守 taskCard.constraints.sourcePolicy；来源策略是硬约束，不允许借用、转述或暗含被排除来源中的情节与文本。',
            '如果 mustAvoid 指向某类词汇、术语或写法，必须避开任务卡中对应的词表、例词和搭配。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            taskCard,
            section: input.section,
            contextSummary: context.compactSummary,
            knowledge: sectionKnowledge,
            writingContinuity,
            writingBudget,
            sourceUsePolicy: {
              useSourcesAsEvidenceOnly: true,
              originalWritingRequired: true,
              prohibitedModes: ['translation', 'paraphrase', 'retelling', 'source-summary'],
              doNotRetellOrRewriteSourcePassages: true,
              quotePolicy: '允许短引关键词句；不得使用整段原文或近似改写填充正文；引用总量不得压过分析文字。',
              retellingPolicy: '不要按时间顺序讲故事，不要复述人物经历，不要把原著情节改写成白话；只在论证需要时点到证据。',
              paragraphShape: '每段先提出分析判断，再解释判断，再用少量材料支撑，最后回扣本节论点。',
              expectedWriting: '以分析、判断、过渡和解释为主；引用和情节只点到证据，不承担正文主体。',
            },
            existingOutline: context.article?.outline,
            existingBlocks: context.article?.blocks.map((block) => ({ id: block.id, title: block.title, text: block.text.slice(0, 300) })),
          }),
        },
      ],
    });
    const parsed = parseSectionWriterResponse(response.content);
    try {
      return normalizeOutput(parsed, { ...input, taskCard }, sectionKnowledge, writingBudget, writingContinuity);
    } catch (error) {
      if (!(error instanceof SectionLengthBudgetError)) throw error;
      const revised = await reviseOverlongSection({ input: { ...input, taskCard }, parsed, knowledge: sectionKnowledge, writingBudget, writingContinuity, lengthError: error, llm });
      return normalizeOutput(revised, { ...input, taskCard }, sectionKnowledge, writingBudget, writingContinuity);
    }
  }
}

interface SectionWritingBudget {
  articleExpectedLength: string;
  outlineSections: number;
  totalTargetChars: number;
  totalSectionWeight: number;
  currentSectionWeight: number;
  writtenChars: number;
  targetChars: number;
  minChars: number;
  maxChars: number;
  allocationBasis: string;
  policy: string;
}

interface WritingContinuity {
  currentSection: { id: string; order: number; title: string; goal: string };
  previousSections: Array<{ id: string; order: number; title: string }>;
  nextSection?: { id: string; order: number; title: string };
  recentBlocks: Array<{ sectionTitle: string; text: string; sourceRefs: string[] }>;
  usedSourceRefs: Array<{ sourceRef: string; count: number; sections: string[] }>;
  unusedSourceRefs: string[];
  policy: string[];
}

class SectionLengthBudgetError extends Error {
  constructor(readonly actualChars: number, readonly maxChars: number) {
    super(`Section writer exceeded current section length budget: ${actualChars}/${maxChars} characters.`);
  }
}

function parseSectionWriterResponse(content: string): SectionWriterRawOutput {
  const parsed = safeJsonParse<SectionWriterRawOutput>(content);
  if (!parsed?.block?.text && !parsed?.blocks?.some((block) => block.text)) throw new Error(`Section writer did not return a valid block: ${content.slice(0, 300)}`);
  return parsed;
}

async function reviseOverlongSection(input: { input: SectionWriterInput; parsed: SectionWriterRawOutput; knowledge: KnowledgeItem[]; writingBudget: SectionWritingBudget; writingContinuity: WritingContinuity; lengthError: SectionLengthBudgetError; llm: Parameters<Skill<SectionWriterInput, SectionWriterOutput>['invoke']>[0]['llm'] }): Promise<SectionWriterRawOutput> {
  const response = await input.llm.chat({
    jsonMode: true,
    temperature: 0.25,
    messages: [
      {
        role: 'system',
        content: [
          '你是章节正文压缩编辑器，只输出 JSON：blocks、summary。',
          '你的任务不是续写，而是把已有章节草稿重写得更凝练，并压缩到 writingBudget.maxChars 以内。',
          '必须保留当前章节的核心判断、必要过渡和来源绑定；不得新增未在 knowledge 中出现的 sourceRef。',
          '不要机械截断；必须输出完整、可直接保存的正文。',
          '不得加入新情节、新人物、新资料，也不得改变 taskCard、section 和 sourcePolicy 的约束。',
          '如果原草稿有复述、铺陈、重复引用或空泛解释，优先删去这些部分。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          taskCard: input.input.taskCard,
          section: input.input.section,
          writingBudget: input.writingBudget,
          lengthProblem: { actualChars: input.lengthError.actualChars, maxChars: input.lengthError.maxChars },
          originalDraft: input.parsed,
          knowledge: input.knowledge,
          writingContinuity: input.writingContinuity,
          requiredOutputShape: {
            blocks: [{ title: 'string', text: 'string', sourceRefs: ['string'], themeTags: ['string'] }],
            summary: 'string',
          },
        }),
      },
    ],
  });
  return parseSectionWriterResponse(response.content);
}

function normalizeOutput(output: SectionWriterRawOutput, input: SectionWriterInput, knowledge: KnowledgeItem[], writingBudget: SectionWritingBudget, writingContinuity: WritingContinuity): SectionWriterOutput {
  const now = nowIso();
  const candidateSources = optionalStringArray(output.candidateSources, 'candidateSources') ?? [];
  const blocks = normalizeBlockOutputs(output, input).map((sourceBlock, index) => {
    const sourceRefs = uniqueStrings(optionalStringArray(sourceBlock.sourceRefs, `blocks[${index}].sourceRefs`) ?? candidateSources);
    return {
      id: sourceBlock.id ?? newId('blk'),
      type: 'section' as const,
      sectionId: input.section.id,
      title: typeof sourceBlock.title === 'string' && sourceBlock.title.trim() ? sourceBlock.title.trim() : (index === 0 ? input.section.title : undefined),
      text: requireText(sourceBlock.text, `blocks[${index}].text`),
      sourceRefs,
      themeTags: optionalStringArray(sourceBlock.themeTags, `blocks[${index}].themeTags`) ?? input.section.themeTags,
      status: 'draft' as const,
      createdAt: sourceBlock.createdAt ?? now,
      updatedAt: now,
    };
  });
  const combinedText = blocks.map((block) => block.text).join('\n\n');
  validateLengthBudget(combinedText, writingBudget);
  validateAvoidedTerms(combinedText, input.taskCard.constraints.mustAvoid);
  validateGeneratedTextAgainstTaskCardPolicy(combinedText, input.taskCard, knowledge, blocks.flatMap((block) => block.sourceRefs));
  validateSourceReferences(blocks, input.taskCard, knowledge, writingContinuity);
  validateSourceUse(combinedText, knowledge);
  validateArticleContinuity(combinedText, writingContinuity);
  const block = blocks[0];
  return {
    block,
    blocks,
    candidateSources: candidateSources.length ? candidateSources : [...new Set(blocks.flatMap((item) => item.sourceRefs))],
    summary: requireText(output.summary, 'summary'),
  };
}

function buildWritingContinuity(input: SectionWriterInput, article: ArticleArtifact | undefined, knowledge: KnowledgeItem[]): WritingContinuity {
  const outline = [...(article?.outline ?? [])].sort((a, b) => a.order - b.order);
  const currentIndex = outline.findIndex((item) => item.id === input.section.id);
  const previousSections = (currentIndex > 0 ? outline.slice(0, currentIndex) : []).map((item) => ({ id: item.id, order: item.order, title: item.title }));
  const next = currentIndex >= 0 ? outline[currentIndex + 1] : undefined;
  const sectionTitleById = new Map(outline.map((item) => [item.id, item.title]));
  const priorBlocks = (article?.blocks ?? []).filter((block) => block.sectionId !== input.section.id);
  const recentBlocks = priorBlocks.slice(-4).map((block) => ({
    sectionTitle: block.sectionId ? sectionTitleById.get(block.sectionId) ?? block.title ?? block.sectionId : block.title ?? '前文',
    text: block.text.slice(0, 240),
    sourceRefs: block.sourceRefs,
  }));
  const used = new Map<string, { sourceRef: string; count: number; sections: Set<string> }>();
  for (const block of priorBlocks) {
    const sectionTitle = block.sectionId ? sectionTitleById.get(block.sectionId) ?? block.sectionId : block.title ?? '前文';
    for (const sourceRef of block.sourceRefs ?? []) {
      const item = used.get(sourceRef) ?? { sourceRef, count: 0, sections: new Set<string>() };
      item.count += 1;
      item.sections.add(sectionTitle);
      used.set(sourceRef, item);
    }
  }
  const availableRefs = uniqueStrings(knowledge.map((item) => item.sourceRef));
  return {
    currentSection: { id: input.section.id, order: input.section.order, title: input.section.title, goal: input.section.goal },
    previousSections,
    nextSection: next ? { id: next.id, order: next.order, title: next.title } : undefined,
    recentBlocks,
    usedSourceRefs: [...used.values()].map((item) => ({ sourceRef: item.sourceRef, count: item.count, sections: [...item.sections].slice(0, 4) })).sort((a, b) => b.count - a.count),
    unusedSourceRefs: availableRefs.filter((sourceRef) => !used.has(sourceRef)),
    policy: [
      '本节只推进当前章节目标，不重写前文已经完成的介绍或判断。',
      '优先使用前文尚未使用的来源；必须复用来源时，要换一个分析角度，不能重复同一句批语或同一处情节。',
      '引入旁支人物或事件时，先交代它和当前论点的关系，再分析其意义。',
    ],
  };
}

function prioritizeSectionKnowledge(knowledge: KnowledgeItem[], writingContinuity: WritingContinuity): KnowledgeItem[] {
  const used = new Set(writingContinuity.usedSourceRefs.map((item) => item.sourceRef));
  return [
    ...knowledge.filter((item) => !used.has(item.sourceRef)),
    ...knowledge.filter((item) => used.has(item.sourceRef)),
  ];
}

function normalizeBlockOutputs(output: SectionWriterRawOutput, input: SectionWriterInput): Array<Partial<ArticleBlock>> {
  const blocks = output.blocks?.filter((block) => typeof block.text === 'string' && block.text.trim()) ?? [];
  if (blocks.length) return blocks;
  if (output.block?.text) return [output.block];
  return [{ title: input.section.title }];
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Section writer returned empty ${field}.`);
  return value.trim();
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Section writer returned invalid ${field}.`);
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  return value === undefined ? undefined : requireStringArray(value, field);
}

function buildSectionWritingBudget(taskCard: WritingTaskCard, section: OutlineItem, article: ArticleArtifact | undefined): SectionWritingBudget {
  const outline = article?.outline.length ? article.outline : [section];
  const sectionCount = Math.max(1, outline.length);
  const articleTarget = parseExpectedLengthTarget(taskCard.structure.expectedLength) ?? (taskCard.structure.articleType === 'longform' ? 3200 : 1600);
  const currentSection = outline.find((item) => item.id === section.id) ?? section;
  const totalSectionWeight = outline.reduce((sum, item) => sum + sectionBudgetWeight(item), 0);
  const currentSectionWeight = sectionBudgetWeight(currentSection);
  const plannedTarget = Math.round(articleTarget * currentSectionWeight / totalSectionWeight);
  const writtenSectionIds = new Set((article?.blocks ?? []).map((block) => block.sectionId).filter((id): id is string => Boolean(id) && id !== section.id));
  const writtenChars = (article?.blocks ?? []).filter((block) => block.sectionId !== section.id).reduce((sum, block) => sum + countCjkOrLetters(block.text), 0);
  const remainingSections = outline.filter((item) => item.id === section.id || !writtenSectionIds.has(item.id));
  const remainingWeight = Math.max(currentSectionWeight, remainingSections.reduce((sum, item) => sum + sectionBudgetWeight(item), 0));
  const remainingTarget = Math.max(plannedTarget, articleTarget - writtenChars);
  const adaptiveTarget = Math.round(remainingTarget * currentSectionWeight / remainingWeight);
  const lowerBound = Math.round(plannedTarget * 0.72);
  const upperBound = Math.round(plannedTarget * 1.45);
  const targetChars = clamp(adaptiveTarget, lowerBound, upperBound);
  const maxCap = Math.min(Math.max(articleTarget, 500), taskCard.structure.articleType === 'longform' ? 1800 : 1400);
  const maxChars = clamp(Math.round(targetChars * 1.3) + 80, 360, maxCap);
  const minChars = clamp(Math.round(targetChars * 0.55), 160, Math.max(160, maxChars - 80));
  return {
    articleExpectedLength: taskCard.structure.expectedLength,
    outlineSections: sectionCount,
    totalTargetChars: articleTarget,
    totalSectionWeight,
    currentSectionWeight,
    writtenChars,
    targetChars,
    minChars,
    maxChars,
    allocationBasis: '按大纲 expectedBlocks 权重分配；已写章节计入整篇已用字数，当前节按剩余预算自适应调整。',
    policy: '整篇长度是总预算，不平均硬切到每节；当前章节按大纲权重和剩余篇幅分配，宁可凝练，不要把整篇文章展开到单节里。',
  };
}

function sectionBudgetWeight(section: OutlineItem): number {
  return Math.max(1, Math.min(5, Number.isFinite(section.expectedBlocks) ? Math.round(section.expectedBlocks) : 1));
}

function parseExpectedLengthTarget(value: string): number | undefined {
  const numbers = [...value.matchAll(/\d+/g)].map((match) => Number(match[0])).filter((item) => Number.isFinite(item) && item > 0);
  if (!numbers.length) return undefined;
  if (numbers.length === 1) return numbers[0];
  return Math.round((Math.min(...numbers) + Math.max(...numbers)) / 2);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function validateLengthBudget(text: string, writingBudget: SectionWritingBudget): void {
  const length = countCjkOrLetters(text);
  if (length > writingBudget.maxChars) {
    throw new SectionLengthBudgetError(length, writingBudget.maxChars);
  }
}

function validateAvoidedTerms(text: string, mustAvoid: string[]): void {
  const hits = findAvoidedTermsInText(text, mustAvoid);
  if (hits.length) {
    throw new Error(`Section writer used avoided terms: ${hits.join('、')}.`);
  }
}

function validateSourceReferences(blocks: ArticleBlock[], taskCard: WritingTaskCard, knowledge: KnowledgeItem[], writingContinuity: WritingContinuity): void {
  const availableRefs = new Set(knowledge.map((item) => item.sourceRef));
  const usedRefs = new Set(writingContinuity.usedSourceRefs.map((item) => item.sourceRef));
  const hasUnusedAvailable = writingContinuity.unusedSourceRefs.length > 0;
  for (const block of blocks) {
    const refs = uniqueStrings(block.sourceRefs ?? []);
    const unknownRefs = knowledge.length ? refs.filter((sourceRef) => !availableRefs.has(sourceRef)) : [];
    if (unknownRefs.length) throw new Error(`Section writer returned sourceRefs not present in knowledge: ${unknownRefs.join('、')}.`);
    if ((taskCard.constraints.citationRequired || containsSourceSignal(block.text)) && !refs.length) {
      throw new Error('Section writer referenced source-backed material without sourceRefs.');
    }
    if (refs.length && hasUnusedAvailable && refs.every((sourceRef) => usedRefs.has(sourceRef))) {
      throw new Error('Section writer reused only previously used sourceRefs while unused sources were available.');
    }
  }
}

function validateArticleContinuity(text: string, writingContinuity: WritingContinuity): void {
  const normalizedText = normalizeForOverlap(text);
  if (normalizedText.length < 80) return;
  for (const block of writingContinuity.recentBlocks) {
    const normalizedPrevious = normalizeForOverlap(block.text);
    if (normalizedPrevious.length < 80) continue;
    if (hasSharedWindow(normalizedText, normalizedPrevious, 70)) {
      throw new Error(`Section writer repeated too much previous prose from ${block.sectionTitle}.`);
    }
  }
}

function validateSourceUse(text: string, knowledge: KnowledgeItem[]): void {
  validateQuoteBalance(text);
  const normalizedText = normalizeForOverlap(text);
  if (normalizedText.length < 60) return;
  for (const item of knowledge) {
    const normalizedSource = normalizeForOverlap(item.content);
    if (normalizedSource.length < 60) continue;
    if (hasSharedWindow(normalizedText, normalizedSource, 60)) {
      throw new Error(`Section writer reused too much source text from ${item.sourceRef}.`);
    }
  }
}

function containsSourceSignal(text: string): boolean {
  return /第[一二三四五六七八九十百零〇\d]+回|脂批|脂砚|脂评|批语|原文|回目|判词|引文|引语|书中(?:写|说|道)|作者(?:写|说|道)|[“「『][^”」』]{3,}[”」』]/.test(text);
}

function validateQuoteBalance(text: string): void {
  const quotes = [...extractQuotedText(text)];
  const totalQuotedLength = quotes.reduce((sum, quote) => sum + countCjkOrLetters(quote), 0);
  const totalLength = countCjkOrLetters(text);
  if (totalLength < 60) return;
  const quoteRatio = totalQuotedLength / totalLength;
  if ((totalQuotedLength >= 60 && quoteRatio > 0.5) || (totalQuotedLength >= 160 && quoteRatio > 0.35)) {
    throw new Error(`Section writer returned quote-heavy prose: ${Math.round(quoteRatio * 100)}% quoted text.`);
  }
}

function* extractQuotedText(text: string): Iterable<string> {
  const patterns = [/“([^”]+)”/g, /「([^」]+)」/g, /『([^』]+)』/g, /"([^"]+)"/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]?.trim()) yield match[1].trim();
    }
  }
}

function countCjkOrLetters(value: string): number {
  return [...value.replace(/\s+/g, '')].filter((char) => /[\p{Script=Han}\p{Letter}\p{Number}]/u.test(char)).length;
}

function normalizeForOverlap(value: string): string {
  return [...value]
    .filter((char) => /[\p{Script=Han}\p{Letter}\p{Number}]/u.test(char))
    .join('')
    .toLowerCase();
}

function hasSharedWindow(a: string, b: string, windowSize: number): boolean {
  if (a.length < windowSize || b.length < windowSize) return false;
  const windows = new Set<string>();
  for (let i = 0; i <= a.length - windowSize; i += 1) windows.add(a.slice(i, i + windowSize));
  for (let i = 0; i <= b.length - windowSize; i += 1) {
    if (windows.has(b.slice(i, i + windowSize))) return true;
  }
  return false;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}
