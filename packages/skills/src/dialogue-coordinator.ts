import { ArticleBlock, DialogueContextKind, OutlineItem, RevisionOperation, safeJsonParse, Skill, WritingTaskCard } from '@wa/core';

export interface DialogueCoordinatorInput {
  articleId: string;
  message: string;
  skipKnowledge?: boolean;
  conversation?: Array<{ role: 'user' | 'assistant'; content: string; proposalId?: string; createdAt: string }>;
  pendingProposal?: { id: string; summary: string; message: string; operations: RevisionOperation[]; warnings: string[] };
  context: {
    kind: DialogueContextKind;
    title: string;
    detail?: string;
    outlineItemId?: string;
    blockId?: string;
  };
  taskCard?: WritingTaskCard;
  outline: OutlineItem[];
  selectedOutlineItem?: OutlineItem;
  selectedBlock?: ArticleBlock;
}

export interface DialogueCoordinatorOutput {
  mode: 'answer' | 'clarify' | 'proposal';
  message: string;
  summary?: string;
  operations: RevisionOperation[];
  warnings: string[];
}

export class DialogueCoordinatorSkill implements Skill<DialogueCoordinatorInput, DialogueCoordinatorOutput> {
  manifest = {
    id: 'dialogue-coordinator',
    name: 'Dialogue Coordinator',
    version: '0.1.0',
    description: '判断用户对当前写作对象的输入是解释、澄清还是待确认的修改方案。',
    policies: {
      readOnlyByDefault: true,
      requiresExplicitApply: true,
      noArtifactMutation: true,
    },
  };

  async invoke({ input, context, llm }: Parameters<Skill<DialogueCoordinatorInput, DialogueCoordinatorOutput>['invoke']>[0]): Promise<DialogueCoordinatorOutput> {
    const message = requireText(input.message, 'message');
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0.1,
      maxTokens: 900,
      messages: [
        {
          role: 'system',
          content: [
            '你是写作助手的对话协调器。',
            '你只判断用户这句话如何处理，不修改文章、不生成正文、不返回 Markdown，只返回 json object。',
            '上游已经完成轻量路由；你通常只会在用户明确要求生成或更新修改方案时被调用。',
            '如果输入仍然明显只是提问或说明，mode 是 answer，operations 必须是 []。',
            '如果用户表达了修改意图但目标不明确，mode 是 clarify，operations 必须是 []。',
            '如果用户明确要求修改、调整、添加、删除、重写、压缩、扩写，mode 是 proposal，返回待确认 operations；此时也不直接写入。',
            '如果 pendingProposal 存在，说明用户明确要求刷新当前方案；需要输出一个吸收 conversation 和 pendingProposal 的新 proposal。',
            'operation 必须服从当前 context：task-card 使用 revise-task-card；outline 使用 revise-outline；outline-item 使用 revise-outline-item；block 使用 patch-block。',
            '不要把解释类输入包装成修改方案。用户明确确认前，任何 proposal 都只是计划。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            articleId: input.articleId,
            message,
            conversation: input.conversation ?? [],
            pendingProposal: input.pendingProposal,
            context: input.context,
            taskCard: input.taskCard,
            outline: input.outline.map((item) => ({ id: item.id, title: item.title, goal: item.goal, order: item.order, status: item.status })),
            selectedOutlineItem: input.selectedOutlineItem,
            selectedBlock: input.selectedBlock ? { id: input.selectedBlock.id, title: input.selectedBlock.title, text: input.selectedBlock.text, status: input.selectedBlock.status } : undefined,
            memory: context.memory,
            requiredOutputShape: {
              mode: 'answer | clarify | proposal',
              message: 'string; 面向用户的一句话或短段回复',
              summary: 'string; proposal 时概括这次拟修改',
              operations: [
                { type: 'revise-task-card | revise-outline | revise-outline-item | patch-block', instruction: 'string; 给具体修订器的明确指令' },
              ],
              warnings: 'string[]; 影响范围、删除或已有正文风险',
            },
          }),
        },
      ],
    });
    const parsed = safeJsonParse<Partial<DialogueCoordinatorOutput>>(response.content);
    if (!parsed) throw new Error(`Dialogue coordinator did not return valid JSON: ${response.content.slice(0, 300)}`);
    return normalizeOutput(parsed, input);
  }
}

function normalizeOutput(output: Partial<DialogueCoordinatorOutput>, input: DialogueCoordinatorInput): DialogueCoordinatorOutput {
  const mode = requireMode(output.mode);
  const operations = mode === 'proposal' ? normalizeOperations(output.operations, input) : [];
  if (mode === 'proposal' && !operations.length) throw new Error('Dialogue coordinator returned proposal without operations.');
  const message = requireText(output.message, 'message');
  return {
    mode,
    message,
    summary: typeof output.summary === 'string' && output.summary.trim() ? output.summary.trim() : message,
    operations,
    warnings: requireStringArray(output.warnings ?? [], 'warnings'),
  };
}

function normalizeOperations(operations: unknown, input: DialogueCoordinatorInput): RevisionOperation[] {
  if (!Array.isArray(operations)) throw new Error('Dialogue coordinator returned invalid operations.');
  return operations.map((operation) => normalizeOperation(operation, input));
}

function normalizeOperation(operation: unknown, input: DialogueCoordinatorInput): RevisionOperation {
  if (!operation || typeof operation !== 'object') throw new Error('Dialogue coordinator returned invalid operation.');
  const source = operation as Record<string, unknown>;
  const instruction = requireText(source.instruction, 'operation.instruction');
  if (source.type === 'revise-task-card') return { type: 'revise-task-card', instruction };
  if (source.type === 'revise-outline') return { type: 'revise-outline', instruction };
  if (source.type === 'revise-outline-item') {
    const outlineItemId = requireText(source.outlineItemId ?? input.context.outlineItemId, 'operation.outlineItemId');
    return { type: 'revise-outline-item', outlineItemId, instruction };
  }
  if (source.type === 'patch-block') {
    const blockId = requireText(source.blockId ?? input.context.blockId, 'operation.blockId');
    return { type: 'patch-block', blockId, instruction };
  }
  throw new Error(`Dialogue coordinator returned unsupported operation type: ${String(source.type)}`);
}

function requireMode(value: unknown): DialogueCoordinatorOutput['mode'] {
  if (value === 'answer' || value === 'clarify' || value === 'proposal') return value;
  throw new Error(`Dialogue coordinator returned invalid mode: ${String(value)}`);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Dialogue coordinator returned empty ${field}.`);
  return value.trim();
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Dialogue coordinator returned invalid ${field}.`);
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}
