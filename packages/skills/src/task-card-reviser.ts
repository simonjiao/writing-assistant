import { nowIso, safeJsonParse, Skill, WritingTaskCard } from '@wa/core';
import { extractExplicitAvoidances } from './writing-constraints';

export interface TaskCardReviserInput {
  articleId: string;
  instruction: string;
  currentTaskCard: WritingTaskCard;
}

export interface TaskCardReviserOutput {
  taskCard: WritingTaskCard;
  summary: string;
  changedFields: string[];
}

export class TaskCardReviserSkill implements Skill<TaskCardReviserInput, TaskCardReviserOutput> {
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

  async invoke({ input, context, llm }: Parameters<Skill<TaskCardReviserInput, TaskCardReviserOutput>['invoke']>[0]): Promise<TaskCardReviserOutput> {
    const instruction = requireText(input.instruction, 'instruction');
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: [
            '你是写作助手的任务卡修订器。',
            '用户会用自然语言提出修改意见，你必须基于 currentTaskCard 返回完整修订后的 taskCard。',
            '只返回一个合法 JSON object，字段为 taskCard、summary、changedFields。',
            '不要只返回局部 patch；不要省略未修改字段；不要输出 Markdown。',
            '没有被用户要求修改的字段应保持原意。',
            '如果用户是在纠正错误观点，例如“不是”“并非”“不要写成”“不能说成”，必须把被否定的写法转入 taskCard.constraints.mustAvoid，并从 topic、writingGoal、scope.themes、constraints.mustInclude 中移除相冲突的表达。',
            '纠偏时不要把一个错误极端改写成另一个绝对化极端；例如“不是反对仕途经济”不能改成“从不要求宝玉”或“没有要求”。',
            '遇到复杂限定时，应在 writingGoal 或 constraints.mustInclude 中保留正向边界，例如“有规劝但不等于认同仕途经济价值”。',
            '所有面向用户展示的字段必须是自然语言；内部枚举只允许用于 structure.articleType。',
            'structure.articleType 只能是 essay、analysis、commentary、speech、longform 之一。',
            '如果用户只是要求缩短字数或改成短文，不要输出 shortform；保留或选择最贴切的 articleType，并把篇幅变化写入 structure.expectedLength。',
          ].join('\n'),
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
  const taskCard: WritingTaskCard = {
    ...current,
    ...source,
    id: current.id,
    topic: requireText(source.topic, 'taskCard.topic'),
    writingGoal: requireText(source.writingGoal, 'taskCard.writingGoal'),
    audience: requireText(source.audience, 'taskCard.audience'),
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
    },
  };
  return {
    taskCard,
    summary: requireText(output.summary, 'summary'),
    changedFields: requireStringArray(output.changedFields, 'changedFields'),
  };
}

function mergeStrings(base: string[] = [], extra: string[] = []): string[] {
  return [...new Set([...base, ...extra])];
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Task card reviser returned empty ${field}.`);
  return value.trim();
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Task card reviser returned invalid ${field}.`);
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

function requireArticleType(value: unknown): WritingTaskCard['structure']['articleType'] {
  if (value === 'essay' || value === 'analysis' || value === 'commentary' || value === 'speech' || value === 'longform') return value;
  throw new Error(`Task card reviser returned invalid articleType: ${String(value)}`);
}
