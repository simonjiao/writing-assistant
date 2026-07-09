import { resolve } from 'node:path';
import { OutlineItem, OutlineRhetoricalRole, safeJsonParse, WritingTaskCard } from '@wa/core';
import { PromptProgram } from '@wa/runtime';
import { loadWritingAssistantSystemPrompt } from '../../../shared/prompt-guard';

const systemPrompt = loadWritingAssistantSystemPrompt(resolve(__dirname, '../prompts/outline-item-reviser.system.md'));

export interface OutlineItemReviserInput {
  articleId: string;
  instruction: string;
  currentOutlineItem: OutlineItem;
  taskCard?: WritingTaskCard;
  articleOutline?: OutlineItem[];
}

export interface OutlineItemReviserOutput {
  outlineItem: OutlineItem;
  summary: string;
  changedFields: string[];
}

export class OutlineItemReviserProgram implements PromptProgram<OutlineItemReviserInput, OutlineItemReviserOutput> {
  manifest = {
    id: 'outline-item-reviser',
    name: 'Outline Item Reviser',
    version: '0.1.0',
    description: '根据用户自然语言修改意见，只修订当前选中的大纲项。',
    policies: {
      preserveUnmentionedFields: true,
      selectedOutlineItemOnly: true,
      noBodyGeneration: true,
    },
  };

  async invoke({ input, context, llm }: Parameters<PromptProgram<OutlineItemReviserInput, OutlineItemReviserOutput>['invoke']>[0]): Promise<OutlineItemReviserOutput> {
    const instruction = requireText(input.instruction, 'instruction');
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0.15,
      maxTokens: 900,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: JSON.stringify({
            instruction,
            currentOutlineItem: input.currentOutlineItem,
            taskCard: input.taskCard,
            siblingOutline: input.articleOutline?.map((item) => ({ id: item.id, title: item.title, order: item.order })),
            memory: context.memory,
          }),
        },
      ],
    });
    const parsed = safeJsonParse<Partial<OutlineItemReviserOutput>>(response.content);
    if (!parsed?.outlineItem) throw new Error(`Outline item reviser did not return a valid outlineItem: ${response.content.slice(0, 300)}`);
    return normalizeOutput(parsed, input.currentOutlineItem);
  }
}

function normalizeOutput(output: Partial<OutlineItemReviserOutput>, current: OutlineItem): OutlineItemReviserOutput {
  const source = output.outlineItem;
  if (!source) throw new Error('Outline item reviser returned no outlineItem.');
  const outlineItem: OutlineItem = {
    ...current,
    ...source,
    id: current.id,
    order: current.order,
    status: current.status,
    title: requireText(source.title, 'outlineItem.title'),
    goal: requireText(source.goal, 'outlineItem.goal'),
    expectedBlocks: requirePositiveNumber(source.expectedBlocks ?? current.expectedBlocks, 'outlineItem.expectedBlocks'),
    rhetoricalRole: requireRhetoricalRole(source.rhetoricalRole ?? current.rhetoricalRole, 'outlineItem.rhetoricalRole'),
    keySection: requireBoolean(source.keySection ?? current.keySection, 'outlineItem.keySection'),
    specialHandling: requireStringArray(source.specialHandling ?? current.specialHandling, 'outlineItem.specialHandling'),
    sourceHints: requireStringArray(source.sourceHints ?? current.sourceHints, 'outlineItem.sourceHints'),
    themeTags: requireStringArray(source.themeTags ?? current.themeTags, 'outlineItem.themeTags'),
  };
  return {
    outlineItem,
    summary: requireText(output.summary, 'summary'),
    changedFields: requireStringArray(output.changedFields ?? [], 'changedFields'),
  };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Outline item reviser returned empty ${field}.`);
  return value.trim();
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`Outline item reviser returned invalid ${field}.`);
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Outline item reviser returned invalid ${field}.`);
  return value;
}

function requireRhetoricalRole(value: unknown, field: string): OutlineRhetoricalRole {
  if (value === 'opening' || value === 'development' || value === 'turn' || value === 'conclusion') return value;
  throw new Error(`Outline item reviser returned invalid ${field}.`);
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Outline item reviser returned invalid ${field}.`);
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}
