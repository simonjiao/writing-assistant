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
    try {
      const response = await llm.chat({
        jsonMode: true,
        temperature: 0.25,
        messages: [
          { role: 'system', content: '你是写作助手的大纲规划器。输出 JSON，包含 outline 和 summary。' },
          {
            role: 'user',
            content: JSON.stringify({ taskCard: input.taskCard, memory: context.memory, knowledge: context.knowledge }),
          },
        ],
      });
      const parsed = safeJsonParse<OutlinePlannerOutput>(response.content);
      if (parsed?.outline?.length) return normalizeOutline(parsed, input.taskCard);
    } catch {
      // Use deterministic fallback.
    }
    return buildHeuristicOutline(input.taskCard);
  }
}

function normalizeOutline(output: OutlinePlannerOutput, taskCard: WritingTaskCard): OutlinePlannerOutput {
  const now = nowIso();
  const outline = output.outline.map((item, index) => ({
    id: item.id ?? newId('sec'),
    title: item.title,
    goal: item.goal,
    order: item.order ?? index + 1,
    expectedBlocks: item.expectedBlocks ?? 2,
    sourceHints: item.sourceHints ?? [],
    themeTags: item.themeTags ?? taskCard.scope.themes ?? [],
    status: 'draft' as const,
  }));
  return { outline, summary: output.summary ?? `已生成 ${outline.length} 个章节。` };
}

export function buildHeuristicOutline(taskCard: WritingTaskCard): OutlinePlannerOutput {
  const tags = (taskCard.scope.themes ?? []).length ? (taskCard.scope.themes ?? []) : ['主题分析'];
  const base = [
    ['问题提出', `界定“${taskCard.topic}”的讨论范围，说明文章主旨。`],
    ['文本与关系梳理', '结合关键情节或材料，梳理主要对象之间的关系和矛盾。'],
    ['核心论证', '围绕任务卡中的主题展开分析，形成文章的主要判断。'],
    ['意义收束', '总结文章观点，并回扣写作目标与读者期待。'],
  ];

  const outline = base.map(([title, goal], index) => ({
    id: newId('sec'),
    title: `${index + 1}. ${title}`,
    goal,
    order: index + 1,
    expectedBlocks: index === 2 ? 3 : 2,
    sourceHints: taskCard.constraints.citationRequired ? ['请补充原文、版本或资料依据'] : [],
    themeTags: tags,
    status: 'draft' as const,
  }));

  return {
    outline,
    summary: `已按“${taskCard.topic}”生成四段式大纲。`,
  };
}
