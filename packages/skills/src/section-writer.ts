import { ArticleBlock, KnowledgeItem, newId, nowIso, OutlineItem, safeJsonParse, Skill, WritingTaskCard } from '@wa/core';
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
    const writingBudget = buildSectionWritingBudget(input.taskCard, context.article?.outline.length ?? 1);
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
            '必须遵守 taskCard.constraints.mustAvoid；不得使用其中明示的禁用词、禁用说法，以及括号中“如/例如/比如”列出的词。',
            '如果 mustAvoid 指向某类词汇、术语或写法，必须避开任务卡中对应的词表、例词和搭配。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            taskCard: input.taskCard,
            section: input.section,
            contextSummary: context.compactSummary,
            knowledge: context.knowledge,
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
    const parsed = safeJsonParse<SectionWriterRawOutput>(response.content);
    if (!parsed?.block?.text && !parsed?.blocks?.some((block) => block.text)) throw new Error(`Section writer did not return a valid block: ${response.content.slice(0, 300)}`);
    return normalizeOutput(parsed, input, context.knowledge, writingBudget);
  }
}

interface SectionWritingBudget {
  articleExpectedLength: string;
  outlineSections: number;
  targetChars: number;
  minChars: number;
  maxChars: number;
  policy: string;
}

function normalizeOutput(output: SectionWriterRawOutput, input: SectionWriterInput, knowledge: KnowledgeItem[], writingBudget: SectionWritingBudget): SectionWriterOutput {
  const now = nowIso();
  const candidateSources = optionalStringArray(output.candidateSources, 'candidateSources') ?? [];
  const blocks = normalizeBlockOutputs(output, input).map((sourceBlock, index) => {
    const sourceRefs = optionalStringArray(sourceBlock.sourceRefs, `blocks[${index}].sourceRefs`) ?? candidateSources;
    return {
      id: sourceBlock.id ?? newId('blk'),
      type: 'section' as const,
      sectionId: input.section.id,
      title: sourceBlock.title ?? input.section.title,
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
  validateSourceUse(combinedText, knowledge);
  const block = blocks[0];
  return {
    block,
    blocks,
    candidateSources: candidateSources.length ? candidateSources : [...new Set(blocks.flatMap((item) => item.sourceRefs))],
    summary: requireText(output.summary, 'summary'),
  };
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

function buildSectionWritingBudget(taskCard: WritingTaskCard, outlineSections: number): SectionWritingBudget {
  const sectionCount = Math.max(1, outlineSections);
  const articleTarget = parseExpectedLengthTarget(taskCard.structure.expectedLength) ?? (taskCard.structure.articleType === 'longform' ? 3200 : 1600);
  const targetChars = Math.round(articleTarget / sectionCount);
  return {
    articleExpectedLength: taskCard.structure.expectedLength,
    outlineSections: sectionCount,
    targetChars,
    minChars: clamp(Math.round(targetChars * 0.65), 220, 700),
    maxChars: clamp(Math.round(targetChars * 1.35), 360, 900),
    policy: '整篇长度按大纲章节数拆分；本次只写当前章节，宁可凝练，不要把整篇文章展开到单节里。',
  };
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
    throw new Error(`Section writer exceeded current section length budget: ${length}/${writingBudget.maxChars} characters.`);
  }
}

function validateAvoidedTerms(text: string, mustAvoid: string[]): void {
  const hits = findAvoidedTermsInText(text, mustAvoid);
  if (hits.length) {
    throw new Error(`Section writer used avoided terms: ${hits.join('、')}.`);
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
