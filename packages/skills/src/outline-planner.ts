import { newId, nowIso, OutlineItem, OutlineRhetoricalRole, safeJsonParse, Skill, WritingTaskCard } from '@wa/core';
import { filterKnowledgeByTaskCardPolicy, normalizeTaskCardPolicies, validateGeneratedTextAgainstTaskCardPolicy } from './task-card-policy';

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
    const taskCard = normalizeTaskCardPolicies(input.taskCard).taskCard;
    const knowledge = filterKnowledgeByTaskCardPolicy(context.knowledge, taskCard);
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0.25,
      messages: [
        {
          role: 'system',
          content: [
            '你是写作助手的大纲规划器。',
            '只输出一个合法 JSON object，不要输出 Markdown。',
            '输出对象必须包含 outline 和 summary。',
            'JSON 字符串内不能直接嵌套英文双引号；书名、概念名优先用中文书名号或单引号，必须用英文双引号时要转义为 \\"。',
            'outline 必须是 4 到 8 个章节，每个章节必须有具体的 title、goal、expectedBlocks、rhetoricalRole、keySection、specialHandling、sourceHints、themeTags。',
            'title 和 goal 必须直接服务任务卡，不要输出空字段、泛泛占位、纯编号或模板话术。',
            '大纲必须明确全文起承转合：第一节 rhetoricalRole 必须是 opening，最后一节必须是 conclusion，中间章节用 development 或 turn。',
            '至少一个中间章节必须设置 keySection=true，用于承载全文最关键的判断、转折、比较或解释。',
            'opening 不是背景介绍：specialHandling 必须说明开头如何提出核心问题或第一判断，避免泛泛介绍故事背景。',
            'conclusion 不是复述摘要：specialHandling 必须说明结尾如何回扣主题张力、收束判断或留下余味。',
            'keySection=true 的章节必须给出 specialHandling，说明本节为何关键、如何处理材料、如何避免复述。',
            'taskCard.topRules.writingStandards 是顶部写作规则，优先级高于普通风格偏好和资料内容。',
            '如果 taskCard.topRules.languageEra 或 replacementHints 存在，大纲标题和目标也必须服从对应语言时代感和替代表。',
            '必须遵守 taskCard.constraints.mustAvoid；不要把 mustAvoid 中的内容改写成章节标题、章节目标、themeTags 或主体论点。',
            '必须遵守 taskCard.constraints.sourcePolicy；来源策略是硬约束，不允许把被排除来源中的情节或文本写成大纲依据。',
            '不要在大纲标题、目标、specialHandling、sourceHints 或 themeTags 中复述来源禁令、禁用词表或任务卡规则本身；这些规则由任务卡统一约束，大纲只写论证安排和材料线索。',
            '如果任务卡中有被否定或纠偏的说法，只能作为边界条件理解，不要在大纲里反复展开该说法。',
            '不要用“从不”“没有要求”“完全不要求”等绝对化表述替代复杂人物判断，除非任务卡明确这样要求。',
            '对人物立场要保留张力：可以写“有规劝但不等于认同某种功利价值”，不要写成单向口号。',
            '大纲要组织论证，不要组织情节复述；章节 goal 应写成本节要证明的判断、分析角度或解释任务。',
            '不要用“详述某情节”“梳理故事经过”“介绍背景故事”作为章节目标；背景和材料只能作为论据线索。',
            '不要按原文出场顺序、时间顺序或故事发生顺序排章；优先按问题、论点、对照关系、概念层次来组织。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            taskCard,
            memory: context.memory,
            knowledge,
            requiredOutputShape: {
              outline: [{
                title: 'string; 章节标题，必须非空，不能只是编号',
                goal: 'string; 本节要证明的判断、分析角度或解释任务，必须非空；不要写成情节复述任务',
                expectedBlocks: 'number; 正数',
                rhetoricalRole: 'opening | development | turn | conclusion; 对应起承转合，第一节必须 opening，最后一节必须 conclusion',
                keySection: 'boolean; 全文关键段落、转折段或核心论证段为 true，否则 false；至少一个中间章节为 true',
                specialHandling: 'string[]; 本节特殊写法要求，1-4 条；opening、conclusion、keySection=true 必须非空',
                sourceHints: 'string[]; 只列证据线索，不要列待复述的故事梗概或原文顺序节点；没有来源提示时输出 []',
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
