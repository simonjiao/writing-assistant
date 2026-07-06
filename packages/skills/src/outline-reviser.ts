import { newId, OutlineItem, safeJsonParse, Skill, WritingTaskCard } from '@wa/core';

export interface OutlineReviserInput {
  articleId: string;
  instruction: string;
  taskCard?: WritingTaskCard;
  currentOutline: OutlineItem[];
  writtenSectionIds?: string[];
}

export interface OutlineReviserOutput {
  outline: OutlineItem[];
  summary: string;
  changedFields: string[];
  warnings: string[];
}

export class OutlineReviserSkill implements Skill<OutlineReviserInput, OutlineReviserOutput> {
  manifest = {
    id: 'outline-reviser',
    name: 'Outline Reviser',
    version: '0.1.0',
    description: '根据用户确认后的整体意见修订整篇大纲，支持增删改排。',
    policies: {
      wholeOutlineRevision: true,
      preserveExistingIdsWhenPossible: true,
      noBodyGeneration: true,
    },
  };

  async invoke({ input, context, llm }: Parameters<Skill<OutlineReviserInput, OutlineReviserOutput>['invoke']>[0]): Promise<OutlineReviserOutput> {
    const instruction = requireText(input.instruction, 'instruction');
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0.15,
      maxTokens: 1800,
      messages: [
        {
          role: 'system',
          content: [
            '你是写作助手的大纲整体修订器。',
            '用户已经确认要修改整篇大纲，你可以更新、添加、删除或重排大纲项。',
            '不要修改任务卡，不要生成正文，不要返回 Markdown，只返回 json object。',
            '只返回合法 JSON object，字段为 outline、summary、changedFields、warnings。',
            'outline 必须是完整 OutlineItem[]。保留仍然对应原章节的 id；新增条目可以不带 id，由系统补齐。',
            '如果要删除或大幅移动已有正文的章节，必须在 warnings 中说明。',
            '修订后仍要服从 taskCard 的主题、目标、约束和写作标准。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            instruction,
            taskCard: input.taskCard,
            currentOutline: input.currentOutline,
            writtenSectionIds: input.writtenSectionIds ?? [],
            memory: context.memory,
            requiredOutputShape: {
              outline: [{
                id: 'string; 原有条目尽量保留；新增条目可省略',
                title: 'string; 非空',
                goal: 'string; 非空；不要写成正文',
                order: 'number; 系统会按返回顺序重排',
                expectedBlocks: 'number; 正数',
                sourceHints: 'string[]',
                themeTags: 'string[]',
                status: 'draft | confirmed | written',
              }],
              summary: 'string; 概括整体大纲改动',
              changedFields: 'string[]',
              warnings: 'string[]',
            },
          }),
        },
      ],
    });
    const parsed = safeJsonParse<Partial<OutlineReviserOutput>>(response.content);
    if (!parsed?.outline) throw new Error(`Outline reviser did not return a valid outline: ${response.content.slice(0, 300)}`);
    return normalizeOutput(parsed, input.currentOutline);
  }
}

function normalizeOutput(output: Partial<OutlineReviserOutput>, currentOutline: OutlineItem[]): OutlineReviserOutput {
  const source = output.outline;
  if (!Array.isArray(source) || !source.length) throw new Error('Outline reviser returned empty outline.');
  const currentById = new Map(currentOutline.map((item) => [item.id, item]));
  const usedIds = new Set<string>();
  const outline = source.map((item, index) => {
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : newId('sec');
    const current = currentById.get(id);
    if (usedIds.has(id)) throw new Error(`Outline reviser returned duplicate outline id: ${id}`);
    usedIds.add(id);
    return {
      id,
      title: requireText(item.title, 'outline.title'),
      goal: requireText(item.goal, 'outline.goal'),
      order: index + 1,
      expectedBlocks: requirePositiveNumber(item.expectedBlocks ?? current?.expectedBlocks ?? 1, 'outline.expectedBlocks'),
      sourceHints: requireStringArray(item.sourceHints ?? current?.sourceHints ?? [], 'outline.sourceHints'),
      themeTags: requireStringArray(item.themeTags ?? current?.themeTags ?? [], 'outline.themeTags'),
      status: requireStatus(item.status ?? current?.status ?? 'draft'),
    };
  });
  return {
    outline,
    summary: requireText(output.summary, 'summary'),
    changedFields: requireStringArray(output.changedFields ?? [], 'changedFields'),
    warnings: requireStringArray(output.warnings ?? [], 'warnings'),
  };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Outline reviser returned empty ${field}.`);
  return value.trim();
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`Outline reviser returned invalid ${field}.`);
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Outline reviser returned invalid ${field}.`);
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

function requireStatus(value: unknown): OutlineItem['status'] {
  if (value === 'draft' || value === 'confirmed' || value === 'written') return value;
  throw new Error(`Outline reviser returned invalid outline.status: ${String(value)}`);
}
