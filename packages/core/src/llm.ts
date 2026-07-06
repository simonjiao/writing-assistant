import { ChatRequest, ChatResponse, LLMProvider } from './types';
import { safeJsonParse } from './utils';

export interface OpenAICompatibleProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  defaultTemperature?: number;
}

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly config: OpenAICompatibleProviderConfig) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch(`${this.config.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model ?? this.config.model,
        messages: request.messages,
        temperature: request.temperature ?? this.config.defaultTemperature ?? 0.3,
        max_tokens: request.maxTokens,
        response_format: request.jsonMode ? { type: 'json_object' } : undefined,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM request failed: ${response.status} ${body}`);
    }

    const raw = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    return {
      content: raw.choices?.[0]?.message?.content ?? '',
      raw,
      usage: {
        promptTokens: raw.usage?.prompt_tokens,
        completionTokens: raw.usage?.completion_tokens,
        totalTokens: raw.usage?.total_tokens,
      },
    };
  }

  async json<T>(request: ChatRequest): Promise<T> {
    const response = await this.chat({ ...request, jsonMode: true });
    const parsed = safeJsonParse<T>(response.content);
    if (!parsed) {
      throw new Error(`LLM did not return valid JSON: ${response.content.slice(0, 300)}`);
    }
    return parsed;
  }
}

export class MockLLMProvider implements LLMProvider {
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
    const payload = safeJsonParse<Record<string, any>>(lastUser) ?? {};
    if (request.jsonMode && system.includes('任务卡规划器')) {
      const rawRequirement = String(payload.rawRequirement ?? '测试写作任务');
      return { content: JSON.stringify(mockTaskCard(rawRequirement)), raw: { provider: 'mock' } };
    }
    if (request.jsonMode && system.includes('任务卡修订器')) {
      const currentTaskCard = payload.currentTaskCard as ReturnType<typeof mockTaskCard>['taskCard'] | undefined;
      const instruction = String(payload.instruction ?? '修订任务卡');
      return { content: JSON.stringify(mockTaskCardRevision(currentTaskCard, instruction)), raw: { provider: 'mock' } };
    }
    if (request.jsonMode && system.includes('轻量路由器')) {
      return { content: JSON.stringify(mockDialogueRoute(payload)), raw: { provider: 'mock' } };
    }
    if (request.jsonMode && system.includes('对话协调器')) {
      return { content: JSON.stringify(mockDialogueCoordination(payload)), raw: { provider: 'mock' } };
    }
    if (request.jsonMode && system.includes('大纲规划器')) {
      const taskCard = payload.taskCard as { topic?: string; scope?: { themes?: string[] } } | undefined;
      return { content: JSON.stringify(mockOutline(taskCard?.topic ?? '测试主题', taskCard?.scope?.themes ?? [])), raw: { provider: 'mock' } };
    }
    if (request.jsonMode && system.includes('大纲项修订器')) {
      const currentOutlineItem = payload.currentOutlineItem as { id?: string; title?: string; goal?: string; order?: number; expectedBlocks?: number; sourceHints?: string[]; themeTags?: string[]; status?: string } | undefined;
      const instruction = String(payload.instruction ?? '修订大纲项');
      return { content: JSON.stringify(mockOutlineItemRevision(currentOutlineItem, instruction)), raw: { provider: 'mock' } };
    }
    if (request.jsonMode && system.includes('大纲整体修订器')) {
      const currentOutline = payload.currentOutline as Array<{ id?: string; title?: string; goal?: string; order?: number; expectedBlocks?: number; sourceHints?: string[]; themeTags?: string[]; status?: string }> | undefined;
      const instruction = String(payload.instruction ?? '修订大纲');
      return { content: JSON.stringify(mockOutlineRevision(currentOutline, instruction)), raw: { provider: 'mock' } };
    }
    if (request.jsonMode && system.includes('章节写作者')) {
      const section = payload.section as { id?: string; title?: string; goal?: string; themeTags?: string[] } | undefined;
      return { content: JSON.stringify(mockSection(section)), raw: { provider: 'mock' } };
    }
    if (request.jsonMode && system.includes('局部编辑器')) {
      const selectedBlock = payload.selectedBlock as { text?: string } | undefined;
      const instruction = String(payload.instruction ?? '局部修改');
      return { content: JSON.stringify(mockPatch(selectedBlock?.text ?? '', instruction)), raw: { provider: 'mock' } };
    }
    return {
      content: `Mock response generated for: ${lastUser.slice(0, 120)}`,
      raw: { provider: 'mock' },
    };
  }

  async json<T>(request: ChatRequest): Promise<T> {
    const response = await this.chat(request);
    return { content: response.content, provider: 'mock' } as T;
  }
}

function mockTaskCard(rawRequirement: string) {
  const topic = rawRequirement.match(/关于(.+?)(?:的(?:长文|文章|短文|论文|评论|赏析|分析|随笔)|[，,。.!！?？]|$)/)?.[1]?.trim() ?? rawRequirement.slice(0, 30);
  const now = new Date().toISOString();
  return {
    taskCard: {
      id: 'task_mock',
      topic,
      writingGoal: rawRequirement,
      audience: '测试读者',
      scope: { editions: [], chapters: [], characters: [], themes: [topic] },
      structure: { articleType: rawRequirement.includes('长文') ? 'longform' : 'analysis', expectedLength: rawRequirement.includes('长文') ? '2500-4000字' : '1200-2000字', outlinePreference: '先提出问题，再分层展开，最后收束观点。' },
      style: { register: rawRequirement.includes('半文半白') ? '有文学感的中文，可带轻微半文半白' : '清晰自然的中文', tone: rawRequirement.includes('不要太学术') ? '温和、可读、不过度学术化' : '稳健、清楚', classicalFlavor: rawRequirement.includes('半文半白') },
      constraints: { mustInclude: [], mustAvoid: rawRequirement.includes('不要太学术') ? ['不要太学术'] : [], citationRequired: false, sourcePolicy: '按任务卡写作，必要时补充资料。' },
      interactionMode: {
        askBeforeWriting: true,
        localEditFirst: true,
        followUpQuestions: ['希望文章更偏哪种展开方式？', '篇幅大致控制在多少？'],
        followUpPrompts: [
          { id: 'prompt-1', question: '希望文章更偏哪种展开方式？', options: ['赏析', '论证', '随笔'], allowCustom: true },
          { id: 'prompt-2', question: '篇幅大致控制在多少？', options: ['800字', '1500字', '3000字'], allowCustom: true },
        ],
      },
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    },
    missingQuestions: ['希望文章更偏哪种展开方式？', '篇幅大致控制在多少？'],
    followUpPrompts: [
      { id: 'prompt-1', question: '希望文章更偏哪种展开方式？', options: ['赏析', '论证', '随笔'], allowCustom: true },
      { id: 'prompt-2', question: '篇幅大致控制在多少？', options: ['800字', '1500字', '3000字'], allowCustom: true },
    ],
    summary: 'Mock task card generated.',
    confidence: 0.7,
  };
}

function mockTaskCardRevision(currentTaskCard: ReturnType<typeof mockTaskCard>['taskCard'] | undefined, instruction: string) {
  const base = currentTaskCard ?? mockTaskCard('测试写作任务').taskCard;
  const topicMatch = instruction.match(/(?:主题|题目|topic)(?:改成|改为|调整为|设为|是)[:：\s]*([^，,。.!！?？]+)/);
  const topic = topicMatch?.[1]?.trim() || base.topic;
  const changedFields = [
    ...(topic === base.topic ? [] : ['topic', 'scope.themes']),
    ...(instruction.includes('目标') ? ['writingGoal'] : []),
  ];
  const taskCard = {
    ...base,
    topic,
    writingGoal: instruction.includes('目标') ? `${base.writingGoal} ${instruction}`.trim() : base.writingGoal,
    scope: { ...base.scope, themes: topic === base.topic ? base.scope.themes : [topic] },
    interactionMode: { askBeforeWriting: true, localEditFirst: true, followUpQuestions: [], followUpPrompts: [] },
    updatedAt: new Date().toISOString(),
  };
  return {
    taskCard,
    summary: 'Mock task card revision generated.',
    missingQuestions: [],
    followUpPrompts: [],
    changedFields,
  };
}

function mockOutline(topic: string, themes: string[]) {
  return {
    outline: [
      { title: '提出中心问题', goal: `界定“${topic}”的写作对象和核心问题。`, order: 1, expectedBlocks: 2, sourceHints: [], themeTags: themes },
      { title: '梳理关键关系', goal: '说明主要对象之间的关系如何展开。', order: 2, expectedBlocks: 2, sourceHints: [], themeTags: themes },
      { title: '展开核心论证', goal: '围绕任务卡重点形成文章主体判断。', order: 3, expectedBlocks: 3, sourceHints: [], themeTags: themes },
      { title: '收束全文立意', goal: '回扣写作目标，形成结论。', order: 4, expectedBlocks: 1, sourceHints: [], themeTags: themes },
    ],
    summary: 'Mock outline generated.',
  };
}

function mockDialogueRoute(payload: Record<string, any>) {
  const message = String(payload.message ?? '');
  const hasPendingProposal = Boolean(payload.hasPendingProposal);
  if (/(查|检索|搜索|资料|原文|出处|引用|脂批|批语|第[一二三四五六七八九十百0-9]+回|证据|知识库)/.test(message)) return { route: 'needs-rag' };
  if (/[?？]|为什么|为何|解释|说明|怎么|是否|吗|是什么|什么意思/.test(message)) return { route: 'answer' };
  if (/(改|修改|调整|删|删除|加|添加|新增|重写|扩写|压缩|不要|避免|改成|改为|换成|补充|合并|拆分)/.test(message)) return { route: 'propose' };
  if (hasPendingProposal) return { route: 'discuss' };
  return { route: 'clarify' };
}

function mockDialogueCoordination(payload: Record<string, any>) {
  const message = String(payload.message ?? '');
  const context = payload.context as { kind?: string; outlineItemId?: string; blockId?: string; title?: string } | undefined;
  const pendingProposal = payload.pendingProposal as { operations?: Array<Record<string, any>> } | undefined;
  if (/[?？]|为什么|为何|解释|说明|怎么|是否|吗/.test(message)) {
    return {
      mode: 'answer',
      message: `这是关于「${context?.title ?? '当前位置'}」的只读说明；如果需要改动，请明确说“修改为”或点击应用修改。`,
      operations: [],
      warnings: [],
    };
  }
  if (pendingProposal?.operations?.length && !/(确认|应用|执行|就这样|可以|同意|按这个改|直接改|改吧|ok|OK)/i.test(message)) {
    const operation = pendingProposal.operations[0];
    const baseInstruction = String(operation.instruction ?? '');
    const discussion = Array.isArray(payload.conversation)
      ? payload.conversation
          .filter((item: Record<string, unknown>) => item.role === 'user' && typeof item.content === 'string')
          .map((item: Record<string, unknown>) => String(item.content))
          .filter((content: string) => content !== baseInstruction && !/(更新方案|按以上意见|按这些资料|重新给.*方案)/.test(content))
      : [];
    return {
      mode: 'proposal',
      message: '我会把这轮意见合并进当前修改方案，确认后再写入。',
      summary: '更新当前修改方案',
      operations: [{ ...operation, instruction: [baseInstruction, ...discussion].filter(Boolean).join('\n').trim() }],
      warnings: [],
    };
  }
  if (!/(改|修改|调整|删|删除|加|添加|新增|重写|扩写|压缩|不要|避免|改成|改为)/.test(message)) {
    return { mode: 'clarify', message: '我还不能判断要改哪里。请说明是要修改任务卡、大纲、某一节，还是正文段落。', operations: [], warnings: [] };
  }
  const instruction = message;
  if (context?.kind === 'outline-item') {
    return { mode: 'proposal', message: '我会先准备当前大纲项的修改方案，确认后再写入。', summary: '修订当前大纲项', operations: [{ type: 'revise-outline-item', outlineItemId: context.outlineItemId, instruction }], warnings: [] };
  }
  if (context?.kind === 'outline') {
    return { mode: 'proposal', message: '我会先准备整篇大纲的调整方案，确认后再写入。', summary: '修订整篇大纲', operations: [{ type: 'revise-outline', instruction }], warnings: [] };
  }
  if (context?.kind === 'block') {
    return { mode: 'proposal', message: '我会先准备当前段落的局部修改，确认后生成修改预览。', summary: '修订当前段落', operations: [{ type: 'patch-block', blockId: context.blockId, instruction }], warnings: [] };
  }
  return { mode: 'proposal', message: '我会先准备任务卡修改方案，确认后再写入。', summary: '修订任务卡', operations: [{ type: 'revise-task-card', instruction }], warnings: [] };
}

function mockOutlineItemRevision(currentOutlineItem: { id?: string; title?: string; goal?: string; order?: number; expectedBlocks?: number; sourceHints?: string[]; themeTags?: string[]; status?: string } | undefined, instruction: string) {
  const base = currentOutlineItem ?? { id: 'sec_mock', title: '测试大纲', goal: '测试大纲目标。', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'draft' };
  const titleMatch = instruction.match(/(?:标题|题目)(?:改成|改为|调整为|设为|是)[:：\s]*([^，,。.!！?？]+)/);
  const title = titleMatch?.[1]?.trim() || base.title || '测试大纲';
  const changedFields = [
    ...(title === base.title ? [] : ['title']),
    ...(instruction.includes('目标') || instruction.includes('不要') || instruction.includes('不是') ? ['goal'] : []),
  ];
  return {
    outlineItem: {
      ...base,
      title,
      goal: instruction.includes('目标') || instruction.includes('不要') || instruction.includes('不是') ? `${base.goal ?? ''} ${instruction}`.trim() : base.goal,
      expectedBlocks: base.expectedBlocks ?? 1,
      sourceHints: base.sourceHints ?? [],
      themeTags: base.themeTags ?? [],
    },
    summary: 'Mock outline item revision generated.',
    changedFields,
  };
}

function mockOutlineRevision(currentOutline: Array<{ id?: string; title?: string; goal?: string; order?: number; expectedBlocks?: number; sourceHints?: string[]; themeTags?: string[]; status?: string }> | undefined, instruction: string) {
  const outline = currentOutline?.length ? currentOutline : mockOutline('测试主题', []).outline;
  const titleMatch = instruction.match(/(?:第一节|第一项|开头|第1节).{0,8}(?:标题|题目)?(?:改成|改为|调整为|设为)[:：\s]*([^，,。.!！?？]+)/);
  return {
    outline: outline.map((item, index) => ({
      ...item,
      title: index === 0 && titleMatch ? titleMatch[1].trim() : (item.title ?? `大纲 ${index + 1}`),
      goal: index === 0 && (instruction.includes('不要') || instruction.includes('调整')) ? `${item.goal ?? ''} ${instruction}`.trim() : (item.goal ?? '大纲目标。'),
      expectedBlocks: item.expectedBlocks ?? 1,
      sourceHints: item.sourceHints ?? [],
      themeTags: item.themeTags ?? [],
      status: 'status' in item ? item.status ?? 'draft' : 'draft',
    })),
    summary: 'Mock outline revision generated.',
    changedFields: ['outline'],
    warnings: [],
  };
}

function mockSection(section?: { id?: string; title?: string; goal?: string; themeTags?: string[] }) {
  return {
    block: { id: 'blk_mock', type: 'section', sectionId: section?.id, title: section?.title ?? '测试章节', text: `${section?.goal ?? '测试章节目标'}\n\n这是 mock 模型生成的章节正文。`, sourceRefs: [], themeTags: section?.themeTags ?? [] },
    candidateSources: [],
    summary: 'Mock section generated.',
  };
}

function mockPatch(before: string, instruction: string) {
  return {
    patch: { after: `${before}\n\n修改说明：${instruction}`, affectedBlockIds: [], requiresScopeExpansion: false, changeSummary: ['Mock patch generated.'] },
    evaluation: { preservesMeaning: true, needsUserApprovalForScopeExpansion: false, notes: [] },
  };
}
