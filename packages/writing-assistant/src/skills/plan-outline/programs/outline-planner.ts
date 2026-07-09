import { resolve } from 'node:path';
import { newId, nowIso, OutlineItem, OutlineRhetoricalRole, safeJsonParse, WritingTaskCard } from '@wa/core';
import { PromptProgram } from '@wa/runtime';
import { filterKnowledgeByTaskCardPolicy, normalizeTaskCardPolicies, validateGeneratedTextAgainstTaskCardPolicy } from '../../../domain/task-card-policy';
import { loadWritingAssistantSystemPrompt } from '../../../shared/prompt-guard';

const systemPrompt = loadWritingAssistantSystemPrompt(resolve(__dirname, '../prompts/outline-planner.system.md'));

export interface OutlinePlannerInput {
  articleId: string;
  taskCard: WritingTaskCard;
}

export interface OutlinePlannerOutput {
  outline: OutlineItem[];
  summary: string;
}

export class OutlinePlannerProgram implements PromptProgram<OutlinePlannerInput, OutlinePlannerOutput> {
  manifest = {
    id: 'outline-planner',
    name: 'Outline Planner',
    version: '0.1.0',
    description: '根据任务卡生成文章大纲。',
  };

  async invoke({ input, context, llm }: Parameters<PromptProgram<OutlinePlannerInput, OutlinePlannerOutput>['invoke']>[0]): Promise<OutlinePlannerOutput> {
    const taskCard = normalizeTaskCardPolicies(input.taskCard).taskCard;
    const knowledge = filterKnowledgeByTaskCardPolicy(context.knowledge, taskCard);
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0.25,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: JSON.stringify({
            taskCard,
            memory: context.memory,
            knowledge,
          }),
        },
      ],
    });
    const parsed = safeJsonParse<OutlinePlannerOutput>(response.content);
    if (!parsed) throw new Error(`Outline planner did not return valid JSON: ${response.content.slice(0, 300)}`);
    return normalizeOutline(parsed, taskCard, knowledge);
  }
}

function normalizeOutline(output: OutlinePlannerOutput, taskCard: WritingTaskCard, knowledge: Parameters<typeof validateGeneratedTextAgainstTaskCardPolicy>[2]): OutlinePlannerOutput {
  if (!Array.isArray(output.outline) || output.outline.length < 4 || output.outline.length > 8) {
    throw new Error(`Outline planner must return 4 to 8 sections; got ${Array.isArray(output.outline) ? output.outline.length : 'non-array'}.`);
  }
  const now = nowIso();
  const outline = output.outline.map((item, index) => ({
    id: item.id ?? newId('sec'),
    title: requireText(item.title, `outline[${index}].title`),
    goal: requireText(item.goal, `outline[${index}].goal`),
    order: item.order ?? index + 1,
    expectedBlocks: requirePositiveNumber(item.expectedBlocks, `outline[${index}].expectedBlocks`),
    rhetoricalRole: requireRhetoricalRole(item.rhetoricalRole, `outline[${index}].rhetoricalRole`),
    keySection: requireBoolean(item.keySection, `outline[${index}].keySection`),
    specialHandling: requireStringArray(item.specialHandling, `outline[${index}].specialHandling`),
    sourceHints: requireStringArray(item.sourceHints, `outline[${index}].sourceHints`),
    themeTags: requireStringArray(item.themeTags, `outline[${index}].themeTags`),
    status: 'draft' as const,
  }));
  validateOutlineStructure(outline);
  validateGeneratedTextAgainstTaskCardPolicy(
    outline.map((item) => [item.title, item.goal, item.rhetoricalRole, item.keySection ? 'keySection' : '', ...(item.specialHandling ?? []), ...item.sourceHints, ...item.themeTags].join('\n')).join('\n\n'),
    taskCard,
    knowledge,
    [],
    { allowSourceBoundaryMentions: true },
  );
  return { outline, summary: requireText(output.summary, 'summary') };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Outline planner returned empty ${field}.`);
  return value.trim();
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`Outline planner returned invalid ${field}.`);
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Outline planner returned invalid ${field}.`);
  return value;
}

function requireRhetoricalRole(value: unknown, field: string): OutlineRhetoricalRole {
  if (value === 'opening' || value === 'development' || value === 'turn' || value === 'conclusion') return value;
  throw new Error(`Outline planner returned invalid ${field}.`);
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Outline planner returned invalid ${field}.`);
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

function validateOutlineStructure(outline: OutlineItem[]): void {
  const first = outline[0];
  const last = outline[outline.length - 1];
  if (first.rhetoricalRole !== 'opening') throw new Error('Outline planner must mark the first section rhetoricalRole as opening.');
  if (last.rhetoricalRole !== 'conclusion') throw new Error('Outline planner must mark the last section rhetoricalRole as conclusion.');
  const middle = outline.slice(1, -1);
  if (!middle.some((item) => item.keySection)) throw new Error('Outline planner must mark at least one middle section as keySection.');
  for (const item of outline) {
    if ((item.rhetoricalRole === 'opening' || item.rhetoricalRole === 'conclusion' || item.keySection) && !item.specialHandling?.length) {
      throw new Error(`Outline planner returned empty specialHandling for ${item.rhetoricalRole}${item.keySection ? ' keySection' : ''}.`);
    }
  }
}
