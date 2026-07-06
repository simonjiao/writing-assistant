import { OutlineItem, safeJsonParse, Skill, WritingTaskCard } from '@wa/core';

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

export class OutlineItemReviserSkill implements Skill<OutlineItemReviserInput, OutlineItemReviserOutput> {
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

  async invoke({ input, context, llm }: Parameters<Skill<OutlineItemReviserInput, OutlineItemReviserOutput>['invoke']>[0]): Promise<OutlineItemReviserOutput> {
    const instruction = requireText(input.instruction, 'instruction');
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0.15,
      maxTokens: 900,
      messages: [
        {
          role: 'system',
          content: [
            '你是写作助手的大纲项修订器。',
            '用户会对当前选中的一个大纲项提出修改意见，你只能修改 currentOutlineItem。',
            '不要修改任务卡，不要重排整篇大纲，不要生成正文，不要返回 Markdown。',
            '只返回合法 JSON object，字段为 outlineItem、summary、changedFields。',
            'outlineItem 必须是完整 OutlineItem；没有被用户要求修改的字段应保持原意。',
            '必须保留 currentOutlineItem.id、order、status，除非系统显式要求修改它们；本流程不会要求修改这些字段。',
            '如果用户纠正一个错误观点，要把 title 和 goal 中相冲突的表述移除或改成边界更准确的说法。',
            '如果用户只要求局部事实修正，不要扩写成新的章节正文，也不要把大纲目标写成情节复述。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            instruction,
            currentOutlineItem: input.currentOutlineItem,
            taskCard: input.taskCard,
            siblingOutline: input.articleOutline?.map((item) => ({ id: item.id, title: item.title, order: item.order })),
            memory: context.memory,
            requiredOutputShape: {
              outlineItem: {
                id: input.currentOutlineItem.id,
                title: 'string; 修订后的大纲标题，非空',
                goal: 'string; 修订后的本节写作目标，非空；不要写成正文',
                order: input.currentOutlineItem.order,
                expectedBlocks: 'number; 正数；未要求修改时保持原值',
                sourceHints: 'string[]; 未要求修改时保持原值',
                themeTags: 'string[]; 未要求修改时保持原值',
                status: input.currentOutlineItem.status,
              },
              summary: 'string; 概括本次大纲项改动，必须非空',
              changedFields: 'string[]; 修改过的字段路径，没有则输出 []',
            },
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

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Outline item reviser returned invalid ${field}.`);
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}
