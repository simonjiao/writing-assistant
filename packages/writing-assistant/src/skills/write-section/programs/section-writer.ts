import { resolve } from 'node:path';
import { ArticleArtifact, ArticleBlock, KnowledgeItem, newId, nowIso, OutlineItem, safeJsonParse, WritingTaskCard } from '@wa/core';
import { PromptProgram } from '@wa/runtime';
import { filterKnowledgeByTaskCardPolicy, normalizeTaskCardPolicies, validateGeneratedTextAgainstTaskCardPolicy } from '../../../domain/task-card-policy';
import { findAvoidedTermsInText } from '../../../domain/writing-constraints';
import { loadWritingAssistantSystemPrompt } from '../../../shared/prompt-guard';

const systemPrompt = loadWritingAssistantSystemPrompt(resolve(__dirname, '../prompts/section-writer.system.md'));
const overlongRevisionSystemPrompt = loadWritingAssistantSystemPrompt(resolve(__dirname, '../prompts/section-writer.overlong-reviser.system.md'));
const sourceRefRevisionSystemPrompt = loadWritingAssistantSystemPrompt(resolve(__dirname, '../prompts/section-writer.source-ref-reviser.system.md'));

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

type SectionWriterLlm = Parameters<PromptProgram<SectionWriterInput, SectionWriterOutput>['invoke']>[0]['llm'];

export class SectionWriterProgram implements PromptProgram<SectionWriterInput, SectionWriterOutput> {
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

  async invoke({ input, context, llm }: Parameters<PromptProgram<SectionWriterInput, SectionWriterOutput>['invoke']>[0]): Promise<SectionWriterOutput> {
    const taskCard = normalizeTaskCardPolicies(input.taskCard).taskCard;
    const knowledge = filterKnowledgeByTaskCardPolicy(context.knowledge, taskCard);
    const writingContinuity = buildWritingContinuity(input, context.article, knowledge);
    const sectionKnowledge = prioritizeSectionKnowledge(knowledge, writingContinuity, input.section);
    const evidenceBoundSection = buildEvidenceBoundSection(input.section, sectionKnowledge, taskCard);
    const writingBudget = buildSectionWritingBudget(taskCard, input.section, context.article);
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0.45,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
	          content: JSON.stringify({
	            taskCard,
	            section: evidenceBoundSection.section,
	            sourceHintsPolicy: {
	              sourceHintsAreEvidenceOnlyWhenSupportedByKnowledge: true,
	              unsupportedSourceHints: evidenceBoundSection.unsupportedSourceHints,
	              rule: 'unsupportedSourceHints 不得作为事实、引文、脂批内容或来源依据写入正文。',
	            },
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
      if (error instanceof SectionLengthBudgetError) {
        const revised = await reviseOverlongSection({ input: { ...input, taskCard }, parsed, knowledge: sectionKnowledge, writingBudget, writingContinuity, lengthError: error, llm });
        return normalizeOutput(revised, { ...input, taskCard }, sectionKnowledge, writingBudget, writingContinuity);
      }
      if (error instanceof SectionSourceReferenceError) {
        const revised = await reviseMissingSourceRefs({ input: { ...input, taskCard }, parsed, knowledge: sectionKnowledge, writingBudget, writingContinuity, sourceError: error, llm });
        return normalizeOutput(revised, { ...input, taskCard }, sectionKnowledge, writingBudget, writingContinuity);
      }
      throw error;
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
  currentSection: { id: string; order: number; title: string; goal: string; rhetoricalRole?: OutlineItem['rhetoricalRole']; keySection?: boolean; specialHandling: string[] };
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

class SectionSourceReferenceError extends Error {
  constructor() {
    super('Section writer referenced source-backed material without sourceRefs.');
  }
}

function parseSectionWriterResponse(content: string): SectionWriterRawOutput {
  const parsed = safeJsonParse<SectionWriterRawOutput>(content);
  if (!parsed?.block?.text && !parsed?.blocks?.some((block) => block.text)) throw new Error(`Section writer did not return a valid block: ${content.slice(0, 300)}`);
  return parsed;
}

async function reviseOverlongSection(input: { input: SectionWriterInput; parsed: SectionWriterRawOutput; knowledge: KnowledgeItem[]; writingBudget: SectionWritingBudget; writingContinuity: WritingContinuity; lengthError: SectionLengthBudgetError; llm: SectionWriterLlm }): Promise<SectionWriterRawOutput> {
  const response = await input.llm.chat({
    jsonMode: true,
    temperature: 0.25,
    messages: [
      {
        role: 'system',
        content: overlongRevisionSystemPrompt,
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
        }),
      },
    ],
  });
  return parseSectionWriterResponse(response.content);
}

async function reviseMissingSourceRefs(input: { input: SectionWriterInput; parsed: SectionWriterRawOutput; knowledge: KnowledgeItem[]; writingBudget: SectionWritingBudget; writingContinuity: WritingContinuity; sourceError: SectionSourceReferenceError; llm: SectionWriterLlm }): Promise<SectionWriterRawOutput> {
  const response = await input.llm.chat({
    jsonMode: true,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: sourceRefRevisionSystemPrompt,
      },
      {
        role: 'user',
        content: JSON.stringify({
          taskCard: input.input.taskCard,
          section: input.input.section,
          writingBudget: input.writingBudget,
          sourceProblem: input.sourceError.message,
          originalDraft: input.parsed,
          knowledge: input.knowledge.map((item) => ({ title: item.title, content: item.content, sourceRef: item.sourceRef, themeTags: item.themeTags })),
          writingContinuity: input.writingContinuity,
        }),
      },
    ],
  });
  return parseSectionWriterResponse(response.content);
}

function normalizeOutput(output: SectionWriterRawOutput, input: SectionWriterInput, knowledge: KnowledgeItem[], writingBudget: SectionWritingBudget, writingContinuity: WritingContinuity): SectionWriterOutput {
  const { blocks, candidateSources } = buildArticleBlocks(output, input, knowledge);
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

function buildArticleBlocks(output: SectionWriterRawOutput, input: SectionWriterInput, knowledge: KnowledgeItem[]): { blocks: ArticleBlock[]; candidateSources: string[] } {
  const now = nowIso();
  const candidateSources = optionalStringArray(output.candidateSources, 'candidateSources') ?? [];
  const blocks = normalizeBlockOutputs(output, input).map((sourceBlock, index) => {
    const text = requireText(sourceBlock.text, `blocks[${index}].text`);
    const explicitRefs = optionalStringArray(sourceBlock.sourceRefs, `blocks[${index}].sourceRefs`);
    const sourceRefs = uniqueStrings(resolveBlockSourceRefs(explicitRefs, candidateSources, text, input, knowledge));
    return {
      id: sourceBlock.id ?? newId('blk'),
      type: 'section' as const,
      sectionId: input.section.id,
      title: typeof sourceBlock.title === 'string' && sourceBlock.title.trim() ? sourceBlock.title.trim() : (index === 0 ? input.section.title : undefined),
      text,
      sourceRefs,
      themeTags: optionalStringArray(sourceBlock.themeTags, `blocks[${index}].themeTags`) ?? input.section.themeTags,
      status: 'draft' as const,
      createdAt: sourceBlock.createdAt ?? now,
      updatedAt: now,
    };
  });
  return { blocks, candidateSources };
}

function resolveBlockSourceRefs(explicitRefs: string[] | undefined, candidateSources: string[], text: string, input: SectionWriterInput, knowledge: KnowledgeItem[]): string[] {
  const needsRefs = needsSourceRefs(text, input.taskCard);
  if (explicitRefs?.length) {
    return needsRefs ? uniqueStrings([...explicitRefs, ...inferSourceRefsForBlock(text, input.section, knowledge)]) : explicitRefs;
  }
  if (candidateSources.length && (explicitRefs === undefined || needsRefs)) return candidateSources;
  if (needsRefs) return inferSourceRefsForBlock(text, input.section, knowledge);
  return [];
}

function inferSourceRefsForBlock(text: string, section: OutlineItem, knowledge: KnowledgeItem[]): string[] {
  const query = [text, section.title, section.goal, section.rhetoricalRole, section.keySection ? '关键段落' : undefined, ...(section.specialHandling ?? []), ...section.sourceHints, ...section.themeTags].filter(Boolean).join('\n');
  return knowledge
    .map((item) => ({ item, score: sourceBindingScore(item, query, text) }))
    .filter(({ score }) => score >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ item }) => item.sourceRef);
}

function sourceBindingScore(item: KnowledgeItem, query: string, blockText: string): number {
  const itemText = [item.title, item.content, item.sourceRef, item.themeTags.join(' ')].join('\n');
  const queryNgrams = ngramSet(normalizeForOverlap(query), 2);
  const itemNgrams = ngramSet(normalizeForOverlap(itemText), 2);
  let score = Math.min(6, countSharedItems(queryNgrams, itemNgrams) * 0.6);
  const queryChapters = extractChapterNumbers(query);
  const itemChapters = extractKnowledgeChapterNumbers(item);
  if (queryChapters.length && itemChapters.length) {
    score += queryChapters.some((chapter) => itemChapters.includes(chapter)) ? 8 : -4;
  }
  if (mentionsCommentary(blockText)) score += isCommentaryKnowledge(item) ? 5 : -2;
  if (mentionsPrimaryText(blockText) && isPrimaryTextKnowledge(item)) score += 2;
  return score;
}

function ngramSet(value: string, size: number): Set<string> {
  const result = new Set<string>();
  if (value.length < size) return result;
  for (let index = 0; index <= value.length - size; index += 1) result.add(value.slice(index, index + size));
  return result;
}

function countSharedItems(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const item of a) {
    if (b.has(item)) count += 1;
  }
  return count;
}

function extractKnowledgeChapterNumbers(item: KnowledgeItem): number[] {
  return uniqueNumbers([
    ...extractChapterNumbers(item.title),
    ...extractChapterNumbers(item.content),
    ...extractChapterNumbers(item.sourceRef),
    ...extractSourceRefChapterNumbers(item.sourceRef),
  ]);
}

function extractSourceRefChapterNumbers(sourceRef: string): number[] {
  return [...sourceRef.matchAll(/(?:^|[.:/_-])c(\d{1,3})(?:[.:/_-]|$)/gi)]
    .map((match) => Number(match[1]))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function extractChapterNumbers(value: string): number[] {
  return uniqueNumbers([...value.matchAll(/第([一二三四五六七八九十百零〇\d]{1,8})回/g)]
    .map((match) => parseChapterNumber(match[1]))
    .filter((item): item is number => typeof item === 'number' && Number.isFinite(item) && item > 0));
}

function parseChapterNumber(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  return parseChineseNumber(value);
}

function parseChineseNumber(value: string): number | undefined {
  const normalized = value.replace(/[零〇]/g, '');
  if (!normalized) return undefined;
  const hundredParts = normalized.split('百');
  if (hundredParts.length > 1) {
    const hundreds = hundredParts[0] ? chineseDigit(hundredParts[0]) : 1;
    const remainder = parseChineseUnder100(hundredParts.slice(1).join('百')) ?? 0;
    return hundreds ? hundreds * 100 + remainder : undefined;
  }
  return parseChineseUnder100(normalized);
}

function parseChineseUnder100(value: string): number | undefined {
  if (!value) return 0;
  if (value.includes('十')) {
    const [tensRaw, onesRaw = ''] = value.split('十');
    const tens = tensRaw ? chineseDigit(tensRaw) : 1;
    const ones = onesRaw ? chineseDigit(onesRaw) : 0;
    return tens === undefined || ones === undefined ? undefined : tens * 10 + ones;
  }
  return chineseDigit(value);
}

function chineseDigit(value: string): number | undefined {
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value.length === 1) return digits[value];
  const chars = [...value];
  if (chars.every((char) => digits[char] !== undefined)) return Number(chars.map((char) => digits[char]).join(''));
  return undefined;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
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
    currentSection: {
      id: input.section.id,
      order: input.section.order,
      title: input.section.title,
      goal: input.section.goal,
      rhetoricalRole: input.section.rhetoricalRole,
      keySection: input.section.keySection,
      specialHandling: input.section.specialHandling ?? [],
    },
    previousSections,
    nextSection: next ? { id: next.id, order: next.order, title: next.title } : undefined,
    recentBlocks,
    usedSourceRefs: [...used.values()].map((item) => ({ sourceRef: item.sourceRef, count: item.count, sections: [...item.sections].slice(0, 4) })).sort((a, b) => b.count - a.count),
    unusedSourceRefs: availableRefs.filter((sourceRef) => !used.has(sourceRef)),
    policy: [
      '本节只推进当前章节目标，不重写前文已经完成的介绍或判断。',
      currentSectionPolicy(input.section),
      '优先使用前文尚未使用的来源；必须复用来源时，要换一个分析角度，不能重复同一句批语或同一处情节。',
      '引入旁支人物或事件时，先交代它和当前论点的关系，再分析其意义。',
    ].filter(Boolean),
  };
}

function prioritizeSectionKnowledge(knowledge: KnowledgeItem[], writingContinuity: WritingContinuity, section: OutlineItem): KnowledgeItem[] {
  const used = new Set(writingContinuity.usedSourceRefs.map((item) => item.sourceRef));
  const query = [section.title, section.goal, section.rhetoricalRole, section.keySection ? '关键段落' : undefined, ...(section.specialHandling ?? []), ...section.sourceHints, ...section.themeTags].filter(Boolean).join('\n');
  return knowledge
    .map((item, index) => ({
      item,
      index,
      score: sourceBindingScore(item, query, query) + (used.has(item.sourceRef) ? 0 : 0.5) + (isNavigationalKnowledge(item) ? -6 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}

function buildEvidenceBoundSection(section: OutlineItem, knowledge: KnowledgeItem[], taskCard: WritingTaskCard): { section: OutlineItem; unsupportedSourceHints: string[] } {
  const supportedSourceHints = section.sourceHints.filter((hint) => sourceHintSupportedByKnowledge(hint, knowledge, taskCard));
  return {
    section: { ...section, sourceHints: supportedSourceHints },
    unsupportedSourceHints: section.sourceHints.filter((hint) => !supportedSourceHints.includes(hint)),
  };
}

function currentSectionPolicy(section: OutlineItem): string {
  const rolePolicies: Partial<Record<NonNullable<OutlineItem['rhetoricalRole']>, string>> = {
    opening: '本节是开头：先立题、设问或提出核心判断，避免背景铺陈。',
    development: '本节是承接：接住前一层判断继续推进，避免另起炉灶。',
    turn: '本节是转折：必须写出比较、纠偏或论证层次的变化。',
    conclusion: '本节是结尾：收束判断并回扣全文，不要机械复述前文。',
  };
  return [
    section.rhetoricalRole ? rolePolicies[section.rhetoricalRole] : undefined,
    section.keySection ? '本节是关键段落：特殊处理要求优先于一般展开方式。' : undefined,
    ...(section.specialHandling ?? []).map((item) => `本节特殊处理：${item}`),
  ].filter(Boolean).join(' ');
}

function sourceHintSupportedByKnowledge(hint: string, knowledge: KnowledgeItem[], taskCard: WritingTaskCard): boolean {
  return knowledge.some((item) => {
    const itemText = normalizeForOverlap([item.title, item.content, item.sourceRef, item.themeTags.join(' ')].join('\n'));
    const taskCharacters = (taskCard.scope.characters ?? []).map(normalizeForOverlap).filter(Boolean);
    if (taskCharacters.length && !taskCharacters.some((character) => itemText.includes(character))) return false;
    return sourceBindingScore(item, hint, hint) >= 8;
  });
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
  for (const block of blocks) {
    const refs = uniqueStrings(block.sourceRefs ?? []);
    const unknownRefs = knowledge.length ? refs.filter((sourceRef) => !availableRefs.has(sourceRef)) : [];
    if (unknownRefs.length) throw new Error(`Section writer returned sourceRefs not present in knowledge: ${unknownRefs.join('、')}.`);
    if (needsSourceRefs(block.text, taskCard) && !refs.length) throw new SectionSourceReferenceError();
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

function needsSourceRefs(text: string, taskCard: WritingTaskCard): boolean {
  return taskCard.constraints.citationRequired || containsSourceSignal(text);
}

function mentionsCommentary(text: string): boolean {
  return /脂批|脂砚|脂评|批语/.test(text);
}

function mentionsPrimaryText(text: string): boolean {
  return /第[一二三四五六七八九十百零〇\d]+回|原文|回目|书中(?:写|说|道)|作者(?:写|说|道)|[“「『][^”」』]{3,}[”」』]/.test(text);
}

function isCommentaryKnowledge(item: KnowledgeItem): boolean {
  const marker = [item.sourceRef, item.title, item.themeTags.join(' ')].join('\n');
  return /comm|zhipi|commentary|脂批|脂砚|脂评|批语/i.test(marker);
}

function isPrimaryTextKnowledge(item: KnowledgeItem): boolean {
  const marker = [item.sourceRef, item.title, item.themeTags.join(' ')].join('\n');
  return /primary_text|base_text|正文|原文|hlm120|qian80/i.test(marker);
}

function isNavigationalKnowledge(item: KnowledgeItem): boolean {
  const marker = [item.sourceRef, item.title, item.themeTags.join(' ')].join('\n');
  return /navigation_only|entity_relation|theme_associated_with|debug_candidate|focus_mismatch|do_not_answer_as_fact/i.test(marker);
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
