import { resolve } from 'node:path';
import { nowIso, safeJsonParse, TaskCardFollowUpPrompt, WritingTaskCard } from '@wa/core';
import { loadPromptTemplate, PromptProgram } from '@wa/runtime';
import { normalizeTaskCardPolicies } from '../../../domain/task-card-policy';
import { extractConfiguredAvoidanceRules, extractExplicitAvoidances } from '../../../domain/writing-constraints';

const systemPrompt = loadPromptTemplate(resolve(__dirname, '../prompts/task-card-reviser.system.md'));

export interface TaskCardReviserInput {
  articleId: string;
  instruction: string;
  currentTaskCard: WritingTaskCard;
  skipKnowledge?: boolean;
}

export interface TaskCardReviserOutput {
  taskCard: WritingTaskCard;
  summary: string;
  missingQuestions?: string[];
  followUpPrompts?: TaskCardFollowUpPrompt[];
  changedFields: string[];
}

export class TaskCardReviserProgram implements PromptProgram<TaskCardReviserInput, TaskCardReviserOutput> {
  manifest = {
    id: 'task-card-reviser',
    name: 'Task Card Reviser',
    version: '0.1.0',
    description: '根据用户自然语言修改意见修订任务卡。',
    policies: {
      preserveUnmentionedFields: true,
      returnCompleteTaskCard: true,
    },
  };

  async invoke({ input, context, llm }: Parameters<PromptProgram<TaskCardReviserInput, TaskCardReviserOutput>['invoke']>[0]): Promise<TaskCardReviserOutput> {
    const instruction = requireText(input.instruction, 'instruction');
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: JSON.stringify({
            instruction,
            currentTaskCard: input.currentTaskCard,
            userPreferences: context.memory,
            requiredOutputShape: {
              taskCard: '完整 WritingTaskCard；structure.articleType 只能是 essay | analysis | commentary | speech | longform',
              summary: 'string; 概括本次改动，必须非空',
              missingQuestions: 'string[]; 还需要用户补充的问题，没有则输出 []',
              followUpPrompts: 'Array<{ question: string; options: string[]; allowCustom: boolean; selectionMode?: "single" | "multi" }>; 和 missingQuestions 对应，没有则输出 []',
              changedFields: 'string[]; 修改过的字段路径，没有则输出 []',
            },
          }),
        },
      ],
    });
    const parsed = safeJsonParse<Partial<TaskCardReviserOutput>>(response.content);
    if (!parsed?.taskCard) throw new Error(`Task card reviser did not return a valid taskCard: ${response.content.slice(0, 300)}`);
    return normalizeOutput(parsed, input.currentTaskCard, instruction);
  }
}

function normalizeOutput(output: Partial<TaskCardReviserOutput>, current: WritingTaskCard, instruction: string): TaskCardReviserOutput {
  const source = output.taskCard;
  if (!source) throw new Error('Task card reviser returned no taskCard.');
  const missingQuestions = requireOptionalStringArray(output.missingQuestions ?? source.interactionMode?.followUpQuestions);
  const followUpPrompts = requireFollowUpPrompts(output.followUpPrompts ?? source.interactionMode?.followUpPrompts, missingQuestions, 'followUpPrompts');
  const taskCard: WritingTaskCard = {
    ...current,
    ...source,
    id: current.id,
    topic: requireText(source.topic, 'taskCard.topic'),
    writingGoal: requireText(source.writingGoal, 'taskCard.writingGoal'),
    audience: requireText(source.audience, 'taskCard.audience'),
    topRules: {
      languageEra: typeof source.topRules?.languageEra === 'string' && source.topRules.languageEra.trim() ? source.topRules.languageEra.trim() : current.topRules?.languageEra,
      summary: typeof source.topRules?.summary === 'string' && source.topRules.summary.trim() ? source.topRules.summary.trim() : current.topRules?.summary,
      writingStandards: mergeStrings(mergeStrings(current.topRules?.writingStandards, source.topRules?.writingStandards), extractConfiguredAvoidanceRules(instruction)),
      replacementHints: mergeReplacementHints(current.topRules?.replacementHints, source.topRules?.replacementHints),
    },
    status: current.status,
    createdAt: current.createdAt,
    updatedAt: nowIso(),
    scope: {
      editions: requireStringArray(source.scope?.editions, 'taskCard.scope.editions'),
      chapters: requireStringArray(source.scope?.chapters, 'taskCard.scope.chapters'),
      characters: requireStringArray(source.scope?.characters, 'taskCard.scope.characters'),
      themes: requireStringArray(source.scope?.themes, 'taskCard.scope.themes'),
    },
    structure: {
      articleType: requireArticleType(source.structure?.articleType),
      expectedLength: requireText(source.structure?.expectedLength, 'taskCard.structure.expectedLength'),
      outlinePreference: requireText(source.structure?.outlinePreference, 'taskCard.structure.outlinePreference'),
    },
    style: {
      register: requireText(source.style?.register, 'taskCard.style.register'),
      tone: requireText(source.style?.tone, 'taskCard.style.tone'),
      classicalFlavor: typeof source.style?.classicalFlavor === 'boolean' ? source.style.classicalFlavor : current.style.classicalFlavor,
      characterVoice: typeof source.style?.characterVoice === 'string' ? source.style.characterVoice.trim() : current.style.characterVoice,
    },
    constraints: {
      citationRequired: typeof source.constraints?.citationRequired === 'boolean' ? source.constraints.citationRequired : current.constraints.citationRequired,
      mustInclude: requireStringArray(source.constraints?.mustInclude, 'taskCard.constraints.mustInclude'),
      mustAvoid: mergeStrings(requireStringArray(source.constraints?.mustAvoid, 'taskCard.constraints.mustAvoid'), extractExplicitAvoidances(instruction)),
      sourcePolicy: requireText(source.constraints?.sourcePolicy, 'taskCard.constraints.sourcePolicy'),
    },
    interactionMode: {
      askBeforeWriting: true,
      localEditFirst: true,
      followUpQuestions: missingQuestions,
      followUpPrompts,
    },
  };
  const normalized = normalizeTaskCardPolicies(taskCard, instruction).taskCard;
  return {
    taskCard: normalized,
    summary: requireText(output.summary, 'summary'),
    missingQuestions,
    followUpPrompts,
    changedFields: requireStringArray(output.changedFields, 'changedFields'),
  };
}

function requireFollowUpPrompts(value: unknown, missingQuestions: string[], field: string): TaskCardFollowUpPrompt[] {
  const prompts = Array.isArray(value) ? value : [];
  const normalized = prompts
    .map((item, index) => normalizeFollowUpPrompt(item, index))
    .filter((item): item is TaskCardFollowUpPrompt => Boolean(item));
  if (normalized.length) return normalized.slice(0, 3);
  if (missingQuestions.length) throw new Error(`${field} must include prompts for missingQuestions.`);
  return [];
}

function normalizeFollowUpPrompt(value: unknown, index: number): TaskCardFollowUpPrompt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { id?: unknown; question?: unknown; options?: unknown; allowCustom?: unknown; selectionMode?: unknown };
  if (typeof raw.question !== 'string' || !raw.question.trim()) return undefined;
  const options = Array.isArray(raw.options) ? raw.options.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 4) : [];
  const question = raw.question.trim();
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `prompt-${index + 1}`,
    question,
    options: [...new Set(options)],
    allowCustom: typeof raw.allowCustom === 'boolean' ? raw.allowCustom : true,
    selectionMode: normalizePromptSelectionMode(raw.selectionMode, question),
  };
}

function normalizePromptSelectionMode(value: unknown, question: string): TaskCardFollowUpPrompt['selectionMode'] {
  if (value === 'single' || value === 'multi') return value;
  return shouldUseMultiSelection(question) ? 'multi' : 'single';
}

function shouldUseMultiSelection(question: string): boolean {
  return /多选|多个|哪些|哪几|场景|情节|事件|材料|重点|要点|方面|关系|线索/.test(question);
}

function mergeStrings(base: string[] = [], extra: string[] = []): string[] {
  return [...new Set([...base, ...extra])];
}

function mergeReplacementHints(base: Array<{ avoid: string; prefer: string }> = [], extra: unknown): Array<{ avoid: string; prefer: string }> {
  const source = Array.isArray(extra) ? extra : [];
  const values = [...base, ...source.filter(isReplacementHint)];
  const seen = new Set<string>();
  return values.filter((item) => {
    const avoid = item.avoid.trim();
    const prefer = item.prefer.trim();
    if (!avoid || !prefer || seen.has(avoid)) return false;
    seen.add(avoid);
    return true;
  }).map((item) => ({ avoid: item.avoid.trim(), prefer: item.prefer.trim() }));
}

function isReplacementHint(value: unknown): value is { avoid: string; prefer: string } {
  return Boolean(value && typeof value === 'object' && typeof (value as { avoid?: unknown }).avoid === 'string' && typeof (value as { prefer?: unknown }).prefer === 'string');
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Task card reviser returned empty ${field}.`);
  return value.trim();
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Task card reviser returned invalid ${field}.`);
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

function requireOptionalStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  return requireStringArray(value, 'missingQuestions');
}

function requireArticleType(value: unknown): WritingTaskCard['structure']['articleType'] {
  if (value === 'essay' || value === 'analysis' || value === 'commentary' || value === 'speech' || value === 'longform') return value;
  throw new Error(`Task card reviser returned invalid articleType: ${String(value)}`);
}
