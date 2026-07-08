import { DialogueBrief, DialogueBriefItemKind, safeJsonParse } from '@wa/core';
import { PromptProgram } from './prompt-program';

export interface DialogueBriefUpdaterInput {
  message: string;
  context: { kind: string; title: string };
  currentBrief?: DialogueBrief;
  skipKnowledge?: boolean;
}

export interface DialogueBriefPatchItem {
  kind: DialogueBriefItemKind;
  text: string;
}

export interface DialogueBriefUpdaterOutput {
  activeRequirements: DialogueBriefPatchItem[];
  evidenceNotes: string[];
  recentUserIntents: string[];
  supersededRequirements: string[];
  conflicts: Array<{ text: string; requirements: string[] }>;
}

export class DialogueBriefUpdaterProgram implements PromptProgram<DialogueBriefUpdaterInput, DialogueBriefUpdaterOutput> {
  manifest = {
    id: 'dialogue-brief-updater',
    name: 'Dialogue Brief Updater',
    version: '0.1.0',
    description: '从用户对话中提取可增量合并的上下文摘要补丁。',
    policies: {
      readOnlyByDefault: true,
      requiresExplicitApply: false,
      noArtifactMutation: true,
    },
  };

  async invoke({ input, llm }: Parameters<PromptProgram<DialogueBriefUpdaterInput, DialogueBriefUpdaterOutput>['invoke']>[0]): Promise<DialogueBriefUpdaterOutput> {
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0,
      maxTokens: 700,
      messages: [
        {
          role: 'system',
          content: [
            '你是写作任务的对话上下文摘要器，只返回 JSON object。',
            '只处理当前 user message，输出一个 brief patch，不生成文章，不生成修改方案。',
            'activeRequirements 只放用户明确提出的写作要求、禁忌、资料要求或修改要求。',
            'evidenceNotes 只放用户明确提到的资料事实；不要把 assistant/RAG 内容当成用户要求。',
            'recentUserIntents 用一句话概括当前用户意图。',
            '当前消息优先于旧上下文；如果新要求与旧要求冲突，默认把旧要求放入 supersededRequirements。',
            '只有当前消息内部自相矛盾，或用户明确要求同时保留不可兼得目标时，才放入 conflicts。',
            '每条 text 控制在 80 字内。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            message: input.message,
            context: input.context,
            currentBrief: input.currentBrief ? {
              activeRequirements: input.currentBrief.activeRequirements.map((item) => item.text),
              evidenceNotes: input.currentBrief.evidenceNotes.map((item) => item.text),
              unresolvedConflicts: input.currentBrief.unresolvedConflicts.map((item) => item.text),
            } : undefined,
            requiredOutputShape: {
              activeRequirements: [{ kind: 'requirement | avoidance | source | preference | revision', text: 'string' }],
              evidenceNotes: ['string'],
              recentUserIntents: ['string'],
              supersededRequirements: ['string'],
              conflicts: [{ text: 'string', requirements: ['string'] }],
            },
          }),
        },
      ],
    });
    const parsed = safeJsonParse<Partial<DialogueBriefUpdaterOutput>>(response.content);
    if (!parsed) throw new Error(`Dialogue brief updater did not return valid JSON: ${response.content.slice(0, 300)}`);
    return normalizeBriefPatch(parsed);
  }
}

function normalizeBriefPatch(output: Partial<DialogueBriefUpdaterOutput>): DialogueBriefUpdaterOutput {
  return {
    activeRequirements: normalizePatchItems(output.activeRequirements),
    evidenceNotes: normalizeStrings(output.evidenceNotes),
    recentUserIntents: normalizeStrings(output.recentUserIntents),
    supersededRequirements: normalizeStrings(output.supersededRequirements),
    conflicts: Array.isArray(output.conflicts)
      ? output.conflicts.map((item) => ({
        text: compactText(typeof item?.text === 'string' ? item.text : ''),
        requirements: normalizeStrings(item?.requirements),
      })).filter((item) => item.text && item.requirements.length >= 2).slice(0, 4)
      : [],
  };
}

function normalizePatchItems(value: unknown): DialogueBriefPatchItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    kind: normalizeKind((item as { kind?: unknown })?.kind),
    text: compactText(typeof (item as { text?: unknown })?.text === 'string' ? (item as { text: string }).text : ''),
  })).filter((item) => item.text).slice(0, 8);
}

function normalizeKind(value: unknown): DialogueBriefItemKind {
  if (value === 'avoidance' || value === 'source' || value === 'preference' || value === 'revision') return value;
  return 'requirement';
}

function normalizeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => compactText(typeof item === 'string' ? item : '')).filter(Boolean))].slice(0, 8);
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120);
}
