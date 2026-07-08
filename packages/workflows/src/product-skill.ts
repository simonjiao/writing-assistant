import { AllowedActionType } from '@wa/core';

export interface ProductSkillSpec {
  id: string;
  title: string;
  goal: string;
  whenToUse: string[];
  inputContract: string[];
  steps: string[];
  ragPolicy: string[];
  humanGatePolicy: string[];
  toolBindings: string[];
  completionCriteria: string[];
  failurePolicy: string[];
  promptRules: string[];
  actionHints?: Partial<Record<AllowedActionType, string>>;
}

export interface ProductSkillPromptContext {
  id: string;
  title: string;
  goal: string;
  rules: string[];
}

const productSkills: ProductSkillSpec[] = [
  {
    id: 'create-task-card',
    title: '创建任务卡',
    goal: '用户输入自然语言写作需求后，立即保存一个可恢复的写作任务，再逐步整理成可确认的任务卡。',
    whenToUse: ['新任务没有 article 容器时先创建 intake。', '已有 article 但缺少 taskCard 时整理任务卡草稿。', '第一轮只做任务理解，不开始写大纲或正文。'],
    inputContract: ['必须有 userId、workspaceId 和原始需求。', '写作标准和题材标准是显式选择项，优先级高于模型猜测。', 'intake 工具不需要 LLM 输出。'],
    steps: ['create_task_intake 立即创建 article/task 容器并保存原始需求关联。', 'refine_task_card 在同一个 article 上整理任务卡草稿。', '生成待确认项，篇幅和资料边界通常单选，场景、重点、人物关系通常多选。', '任务卡确认前不得生成大纲或正文。'],
    ragPolicy: ['创建 intake 绝不 RAG。', '整理任务卡默认不 RAG，只理解用户需求和显式标准。', '只有用户明确要求依据原文、脂批、出处或证据推荐材料时，才进入资料检索能力。'],
    humanGatePolicy: ['任务卡草稿生成后进入待确认。', '用户可以继续对话修订任务卡；确认前所有修改仍落在同一 article 上。'],
    toolBindings: ['create_task_intake', 'refine_task_card'],
    completionCriteria: ['article 已创建且可在任务列表中恢复。', 'taskCard 草稿保存到同一个 article，状态为 draft。', '待确认项反映尚未明确的关键写作选择。'],
    failurePolicy: ['refine_task_card 失败时保留 intake article，不删除用户输入。', '缺少 workspace 权限时失败，不创建任务。'],
    promptRules: ['不要把内部状态词作为展示文案。', '不要默认查询 RAG。', '场景类待确认项必须可多选。', '输出字段必须自然、可读、适合后续大纲和正文。'],
    actionHints: {
      create_task_intake: '先保存任务容器，保证用户输入不会丢失。',
      refine_task_card: '基于已保存的 intake 整理任务卡草稿。',
      ask_followup: '任务卡草稿已生成，需要用户确认或继续补充。',
    },
  },
  {
    id: 'revise-task-card',
    title: '修订任务卡',
    goal: '根据用户多轮对话和待确认项修改同一张任务卡，保持任务卡、大纲和正文的一致性。',
    whenToUse: ['用户选中任务卡并提出修改意见。', '用户回答待确认项。', '一致性检查要求更新任务卡。'],
    inputContract: ['必须提供 articleId、当前任务卡和用户指令。', '只修改同一 article 的 taskCard。'],
    steps: ['识别用户要改的任务字段。', '把纠错、禁用词、来源边界写入任务卡约束。', '解决已回答的待确认项并保留仍需确认的问题。'],
    ragPolicy: ['默认不 RAG。', '用户明确要求找原文、脂批或证据时，应先走资料能力，不把资料检索藏在普通修订里。'],
    humanGatePolicy: ['修订结果先形成 proposal 或草稿，用户确认后再进入大纲/正文。'],
    toolBindings: ['revise_task_card'],
    completionCriteria: ['任务卡字段完整。', '冲突约束已合并或明确为待确认。', '修订日志能说明改动。'],
    failurePolicy: ['无法判断修改目标时追问。', '不允许把旧任务卡改成空字段。'],
    promptRules: ['新指令优先于旧要求。', '否定性纠错要移除冲突表达，而不是叠加矛盾条目。', '不要把解释类输入包装成修改。'],
  },
  {
    id: 'plan-outline',
    title: '生成和确认大纲',
    goal: '根据已确认任务卡生成或修订文章大纲，明确开头、起承转合、关键段和结尾。',
    whenToUse: ['任务卡已确认且尚未生成大纲。', '用户要求生成或重新生成大纲。', '开始写作前需要自动确认当前大纲。'],
    inputContract: ['必须有已确认任务卡。', '重新生成已有大纲必须经过 HumanGate。'],
    steps: ['按任务卡组织论证结构，不按原文顺序复述。', '设置 opening、development、turn、conclusion。', '为关键段写明 specialHandling。', '开始写作时自动确认大纲。'],
    ragPolicy: ['生成大纲可以使用 RAG 作为材料线索。', 'sourceHints 只是线索，不能当作无来源事实。'],
    humanGatePolicy: ['覆盖已有大纲或正文必须请求确认。', '开始写作会自动确认当前 draft 大纲。'],
    toolBindings: ['plan_outline', 'revise_outline', 'revise_outline_item'],
    completionCriteria: ['大纲项完整、顺序清楚、角色齐全。', '没有违反任务卡 mustAvoid 或来源策略。'],
    failurePolicy: ['大纲与任务卡冲突时生成一致性建议，不继续正文。'],
    promptRules: ['不要输出模板编号。', '开头提出核心问题，结尾收束判断。', '章节 goal 写成分析任务，不写成情节复述。'],
    actionHints: {
      plan_outline: '按任务卡生成大纲。',
      confirm_outline_for_writing: '用户开始写作时确认当前大纲。',
      request_human_gate: '覆盖已有大纲或正文前等待用户确认。',
    },
  },
  {
    id: 'write-section',
    title: '生成章节正文',
    goal: '按大纲项生成原创分析性正文，并绑定可追溯来源。',
    whenToUse: ['大纲已确认。', '指定章节尚未生成正文。', '用户要求继续写作或生成当前章节。'],
    inputContract: ['必须有 taskCard、outline item 和 articleId。', 'draft 大纲项不能直接写正文。'],
    steps: ['读取当前章节、任务卡和已有正文连续性。', '优先使用未用过且符合来源策略的材料。', '生成当前章节正文块并绑定 sourceRefs。'],
    ragPolicy: ['正文阶段应使用 RAG。', '提到原文、回目、脂批、批语或具体事实时必须绑定 knowledge 中的 sourceRef。', '被任务卡排除的来源必须过滤。'],
    humanGatePolicy: ['生成正文不要求每节人工确认，但失败或来源不合规时阻止保存。'],
    toolBindings: ['write_section'],
    completionCriteria: ['正文保存到对应章节。', '不超出章节字数预算。', '来源绑定通过校验。'],
    failurePolicy: ['超字数或缺来源绑定时先自动修正一次。', '仍不合规则失败，不保存正文。'],
    promptRules: ['写作不是翻译、复述或资料摘要。', '每段先判断，再解释，再少量证据支撑。', '承接前文，避免重复。'],
    actionHints: {
      write_section: '生成用户指定章节正文。',
      write_next_section: '生成下一节未完成正文。',
    },
  },
  {
    id: 'resolve-article-comment',
    title: '处理正文批注',
    goal: '批量处理用户对生成正文选区添加的批注，按批注意图修订、解释或追问。',
    whenToUse: ['正文存在 open 批注且用户要求处理。', '用户针对批注追加回复。'],
    inputContract: ['必须有 article、comment、选中 block 和 baseRevision。'],
    steps: ['逐条判断批注意图。', '能局部替换 selectedText 就修订。', '只是解释就回复说明。', '信息不足或会破坏上下文就追问。'],
    ragPolicy: ['批注涉及来源边界、后四十回、脂批或原文事实时，应遵守任务卡来源策略。'],
    humanGatePolicy: ['无法安全局部修订时标记 needs_input，不强行改。'],
    toolBindings: ['resolve_article_comment'],
    completionCriteria: ['每条批注都有处理结果或追问。', '已处理批注可折叠，未处理回复可删除。'],
    failurePolicy: ['单条失败不阻断其它批注处理。', '无有效 JSON 时保留人工确认提示。'],
    promptRules: ['只处理选中文本，不返回整段。', '不要暴露内部标记。', '最新用户回复优先。'],
    actionHints: { process_article_comments: '处理正文批注。' },
  },
  {
    id: 'dialogue-route',
    title: '对话路由',
    goal: '轻量判断用户消息是解释、讨论、澄清、资料检索还是修改方案。',
    whenToUse: ['每次文章内对话消息进入后先路由。'],
    inputContract: ['必须有 message、context 和 pending proposal 状态。'],
    steps: ['先用规则判断是否显式 RAG。', '再判断是否需要生成 proposal。', '只读问题走 answer 或 discuss。'],
    ragPolicy: ['只有明确要求查找资料、出处、原文、脂批或证据时 route=needs-rag。'],
    humanGatePolicy: ['路由本身不创建 HumanGate。'],
    toolBindings: ['route_dialogue'],
    completionCriteria: ['返回唯一 route。'],
    failurePolicy: ['判断不清时 clarify。'],
    promptRules: ['不要把包含、保留、不要漏掉等写作约束误判为 RAG。', '不要生成修改方案。'],
  },
  {
    id: 'update-dialogue-brief',
    title: '更新对话摘要',
    goal: '从用户消息中提取可持久化的写作要求、偏好、来源说明和冲突。',
    whenToUse: ['对话消息保存后异步更新摘要。', '下一轮对话前需要等待未完成摘要更新。'],
    inputContract: ['必须有 message、context 和当前 brief。'],
    steps: ['提取当前消息的新要求。', '用新要求替代冲突旧要求。', '记录证据说明和最近意图。'],
    ragPolicy: ['不主动 RAG。', '不要把 assistant 或资料内容当用户要求。'],
    humanGatePolicy: ['摘要更新不需要 HumanGate。'],
    toolBindings: ['update_dialogue_brief'],
    completionCriteria: ['brief patch 可合并。'],
    failurePolicy: ['失败记录 job，下轮对话前重试或暴露状态。'],
    promptRules: ['当前用户消息优先。', '冲突处理不要过度保守。', '每条摘要短而可执行。'],
  },
  {
    id: 'create-revision-proposal',
    title: '生成修改方案',
    goal: '把用户的自然语言修改意见转成待确认 proposal，而不是直接改文章。',
    whenToUse: ['用户明确要求修改任务卡、大纲、大纲项或段落。', '一致性或统稿报告产生可操作建议。'],
    inputContract: ['必须有 articleId、上下文、用户消息和当前 artifact 摘要。'],
    steps: ['判断修改对象。', '生成最小必要 operations。', '把风险写入 warnings。'],
    ragPolicy: ['默认不 RAG。', '用户要求资料依据时先走资料能力。'],
    humanGatePolicy: ['proposal 必须用户应用后才写入。'],
    toolBindings: ['create_revision_proposal'],
    completionCriteria: ['operations 与当前 context 匹配。', 'message 简短说明方案。'],
    failurePolicy: ['解释类输入返回 answer。', '目标不清返回 clarify。'],
    promptRules: ['不要把只读解释包装成修改方案。', 'operation instruction 简明可执行。'],
    actionHints: { create_revision_proposal: '根据审阅结果生成待确认修改方案。' },
  },
  {
    id: 'patch-block',
    title: '局部修改段落',
    goal: '只对用户选中的段落生成局部 patch，避免无意扩大修改范围。',
    whenToUse: ['用户选中正文段落并提出修改。'],
    inputContract: ['必须有 articleId、blockId 和 instruction。'],
    steps: ['读取选中段落和邻近段落。', '生成完整替换后的 selected block。', '说明修改点和是否扩大范围。'],
    ragPolicy: ['默认不 RAG；如果涉及来源事实，应保留或要求来源绑定。'],
    humanGatePolicy: ['扩大修改范围需要用户确认。'],
    toolBindings: ['patch_block'],
    completionCriteria: ['patch.after 是完整段落。', 'evaluation 说明是否保留含义。'],
    failurePolicy: ['找不到 selected block 直接失败。'],
    promptRules: ['默认只改选中段。', '不要返回未选中上下文。'],
  },
  {
    id: 'evaluate-quality',
    title: '质量检查',
    goal: '检查文章或局部内容是否满足任务卡、引用、连贯性等基本标准。',
    whenToUse: ['需要自动检查来源、任务一致性或基础质量。'],
    inputContract: ['必须有 articleId 和 criteria。'],
    steps: ['读取当前文章。', '按 criteria 检查。', '返回通过状态、分数和建议动作。'],
    ragPolicy: ['不主动 RAG，只检查已有来源绑定。'],
    humanGatePolicy: ['发现阻断问题时交给 proposal 或 HumanGate 流程。'],
    toolBindings: ['evaluate_quality'],
    completionCriteria: ['返回 passed、score、findings、recommendedAction。'],
    failurePolicy: ['缺任务卡时给出失败 finding。'],
    promptRules: ['检查结果要能转成后续修改建议。'],
    actionHints: {
      review_task_card_outline_consistency: '检查任务卡和大纲是否一致。',
      generate_polish_report: '正文完成后生成统稿报告。',
    },
  },
];

export function registerDefaultProductSkills(registry = new ProductSkillRegistry()): ProductSkillRegistry {
  for (const skill of productSkills) registry.register(skill);
  return registry;
}

export class ProductSkillRegistry {
  private readonly skills = new Map<string, ProductSkillSpec>();

  register(skill: ProductSkillSpec): void {
    if (!skill.id.trim()) throw new Error('Product skill id is required.');
    if (!skill.toolBindings.length) throw new Error(`Product skill ${skill.id} must bind at least one tool.`);
    this.skills.set(skill.id, skill);
  }

  get(skillId: string): ProductSkillSpec {
    const skill = this.skills.get(skillId);
    if (!skill) throw new Error(`Product skill not found: ${skillId}`);
    return skill;
  }

  list(): ProductSkillSpec[] {
    return [...this.skills.values()];
  }
}

export function productSkillPromptContext(skill: ProductSkillSpec): ProductSkillPromptContext {
  return {
    id: skill.id,
    title: skill.title,
    goal: skill.goal,
    rules: [
      ...skill.promptRules,
      ...skill.ragPolicy.map((rule) => `RAG：${rule}`),
      ...skill.humanGatePolicy.map((rule) => `人工确认：${rule}`),
      ...skill.completionCriteria.map((rule) => `完成标准：${rule}`),
    ].slice(0, 18),
  };
}

export function formatProductSkillPromptBlock(skill: ProductSkillPromptContext): string {
  return [
    '当前产品 Skill：',
    `- id：${skill.id}`,
    `- 名称：${skill.title}`,
    `- 目标：${skill.goal}`,
    ...skill.rules.map((rule) => `- ${rule}`),
  ].join('\n');
}

export function actionSkillBinding(type: AllowedActionType): { skillId: string; toolName?: string; hint: string } {
  const bindings: Record<AllowedActionType, { skillId: string; toolName?: string }> = {
    create_task_intake: { skillId: 'create-task-card', toolName: 'create_task_intake' },
    refine_task_card: { skillId: 'create-task-card', toolName: 'refine_task_card' },
    ask_followup: { skillId: 'create-task-card' },
    plan_outline: { skillId: 'plan-outline', toolName: 'plan_outline' },
    confirm_outline_for_writing: { skillId: 'plan-outline' },
    request_human_gate: { skillId: 'plan-outline' },
    review_task_card_outline_consistency: { skillId: 'evaluate-quality' },
    create_revision_proposal: { skillId: 'create-revision-proposal', toolName: 'create_revision_proposal' },
    write_next_section: { skillId: 'write-section', toolName: 'write_section' },
    write_section: { skillId: 'write-section', toolName: 'write_section' },
    process_article_comments: { skillId: 'resolve-article-comment', toolName: 'resolve_article_comment' },
    generate_polish_report: { skillId: 'evaluate-quality' },
  };
  const binding = bindings[type];
  const skill = registerDefaultProductSkills().get(binding.skillId);
  return { ...binding, hint: skill.actionHints?.[type] ?? skill.goal };
}
