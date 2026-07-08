import { resolve } from 'node:path';
import { ArticleBlock, DialogueBrief, DialogueContextKind, OutlineItem, RevisionOperation, safeJsonParse, WritingTaskCard } from '@wa/core';
import { loadPromptTemplate, PromptProgram } from '@wa/runtime';

const systemPrompt = loadPromptTemplate(resolve(__dirname, '../prompts/dialogue-coordinator.system.md'));

export interface DialogueCoordinatorInput {
  articleId: string;
  message: string;
  skipKnowledge?: boolean;
  conversation?: Array<{ role: 'user' | 'assistant'; content: string; proposalId?: string; createdAt: string }>;
  conversationBrief?: DialogueBrief;
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

export class DialogueCoordinatorProgram implements PromptProgram<DialogueCoordinatorInput, DialogueCoordinatorOutput> {
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

  async invoke({ input, context, llm }: Parameters<PromptProgram<DialogueCoordinatorInput, DialogueCoordinatorOutput>['invoke']>[0]): Promise<DialogueCoordinatorOutput> {
    const message = requireText(input.message, 'message');
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0.1,
      maxTokens: 1600,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: JSON.stringify({
            articleId: input.articleId,
            message,
            conversation: input.conversation ?? [],
            conversationBrief: input.conversationBrief ? compactBrief(input.conversationBrief) : undefined,
            pendingProposal: input.pendingProposal,
            context: input.context,
            taskCard: input.taskCard ? compactTaskCard(input.taskCard) : undefined,
            outline: input.outline.map((item) => ({ id: item.id, title: item.title, goal: item.goal, order: item.order, status: item.status })),
            selectedOutlineItem: input.selectedOutlineItem,
            selectedBlock: input.selectedBlock ? { id: input.selectedBlock.id, title: input.selectedBlock.title, text: compactText(input.selectedBlock.text, 1200), status: input.selectedBlock.status } : undefined,
            memory: context.memory,
            requiredOutputShape: {
              mode: 'answer | clarify | proposal',
              message: 'string; 面向用户的一句话或短段回复',
              summary: 'string; proposal 时概括这次拟修改',
              expectedOperationType: expectedOperationType(input.context.kind),
              operations: [{ type: expectedOperationType(input.context.kind), instruction: 'string; 给具体修订器的明确指令' }],
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

function compactBrief(brief: DialogueBrief): DialogueBrief {
  return {
    ...brief,
    activeRequirements: brief.activeRequirements.slice(-8).map((item) => ({ ...item, text: compactText(item.text) })),
    evidenceNotes: brief.evidenceNotes.slice(-6).map((item) => ({ ...item, text: compactText(item.text) })),
    recentUserIntents: brief.recentUserIntents.slice(-6).map((item) => ({ ...item, text: compactText(item.text) })),
    unresolvedConflicts: brief.unresolvedConflicts.slice(-4).map((item) => ({
      ...item,
      text: compactText(item.text),
      requirements: item.requirements.map((entry) => compactText(entry)).slice(0, 4),
      sourceMessageIds: item.sourceMessageIds.slice(-4),
    })),
    supersededRequirements: brief.supersededRequirements.slice(-6).map((item) => ({ ...item, text: compactText(item.text) })),
  };
}

function compactTaskCard(taskCard: WritingTaskCard) {
  return {
    topic: taskCard.topic,
    writingGoal: compactText(taskCard.writingGoal, 240),
    audience: taskCard.audience,
    topRules: taskCard.topRules ? { languageEra: taskCard.topRules.languageEra, summary: taskCard.topRules.summary, writingStandards: taskCard.topRules.writingStandards.slice(0, 4) } : undefined,
    scope: taskCard.scope,
    structure: taskCard.structure,
    style: taskCard.style,
    constraints: {
      mustInclude: taskCard.constraints.mustInclude.slice(-8),
      mustAvoid: taskCard.constraints.mustAvoid.slice(-8),
      citationRequired: taskCard.constraints.citationRequired,
      sourcePolicy: compactText(taskCard.constraints.sourcePolicy, 240),
    },
    status: taskCard.status,
  };
}

function compactText(value: string, limit = 180): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
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
  const type = expectedOperationType(input.context.kind);
  if (type === 'revise-task-card') return { type, instruction };
  if (type === 'revise-outline') return { type, instruction };
  if (type === 'revise-outline-item') {
    const outlineItemId = requireText(source.outlineItemId ?? input.context.outlineItemId, 'operation.outlineItemId');
    return { type, outlineItemId, instruction };
  }
  if (type === 'patch-block') {
    const blockId = requireText(source.blockId ?? input.context.blockId ?? input.selectedBlock?.id, 'operation.blockId');
    return { type, blockId, instruction };
  }
  throw new Error(`Dialogue coordinator returned unsupported context kind: ${String(input.context.kind)}`);
}

function expectedOperationType(kind: DialogueContextKind): RevisionOperation['type'] {
  if (kind === 'task-card') return 'revise-task-card';
  if (kind === 'outline') return 'revise-outline';
  if (kind === 'outline-item') return 'revise-outline-item';
  if (kind === 'block') return 'patch-block';
  throw new Error(`Dialogue coordinator returned unsupported context kind: ${String(kind)}`);
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
