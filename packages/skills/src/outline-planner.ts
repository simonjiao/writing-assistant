import { newId, nowIso, OutlineItem, safeJsonParse, Skill, WritingTaskCard } from '@wa/core';

export interface OutlinePlannerInput {
  articleId: string;
  taskCard: WritingTaskCard;
}

export interface OutlinePlannerOutput {
  outline: OutlineItem[];
  summary: string;
}

export class OutlinePlannerSkill implements Skill<OutlinePlannerInput, OutlinePlannerOutput> {
  manifest = {
    id: 'outline-planner',
    name: 'Outline Planner',
    version: '0.1.0',
    description: '根据任务卡生成文章大纲。',
  };

  async invoke({ input, context, llm }: Parameters<Skill<OutlinePlannerInput, OutlinePlannerOutput>['invoke']>[0]): Promise<OutlinePlannerOutput> {
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0.25,
      messages: [
        {
          role: 'system',
          content: [
            '你是写作助手的大纲规划器。',
            '只输出 JSON，不要输出 Markdown。',
            '输出对象必须包含 outline 和 summary。',
            'outline 必须是 4 到 8 个章节，每个章节必须有具体的 title、goal、expectedBlocks、sourceHints、themeTags。',
            'title 和 goal 必须直接服务任务卡，不要输出空字段、泛泛占位、纯编号或模板话术。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            taskCard: input.taskCard,
            memory: context.memory,
            knowledge: context.knowledge,
            requiredOutputShape: {
              outline: [{
                title: 'string; 章节标题，必须非空，不能只是编号',
                goal: 'string; 本节写作目标，必须非空',
                expectedBlocks: 'number; 正数',
                sourceHints: 'string[]; 没有来源提示时输出 []',
                themeTags: 'string[]; 没有标签时输出 []',
              }],
              summary: 'string; 必须非空',
            },
          }),
        },
      ],
    });
    const parsed = safeJsonParse<OutlinePlannerOutput>(response.content);
    if (!parsed) throw new Error(`Outline planner did not return valid JSON: ${response.content.slice(0, 300)}`);
    return normalizeOutline(parsed);
  }
}

function normalizeOutline(output: OutlinePlannerOutput): OutlinePlannerOutput {
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
    sourceHints: requireStringArray(item.sourceHints, `outline[${index}].sourceHints`),
    themeTags: requireStringArray(item.themeTags, `outline[${index}].themeTags`),
    status: 'draft' as const,
  }));
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

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Outline planner returned invalid ${field}.`);
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}
