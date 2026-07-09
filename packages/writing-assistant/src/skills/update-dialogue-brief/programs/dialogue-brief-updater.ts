import { resolve } from 'node:path';
import { DialogueBrief, DialogueBriefItemKind, safeJsonParse } from '@wa/core';
import { PromptProgram } from '@wa/runtime';
import { loadWritingAssistantSystemPrompt } from '../../../shared/prompt-guard';

const systemPrompt = loadWritingAssistantSystemPrompt(resolve(__dirname, '../prompts/dialogue-brief-updater.system.md'));

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
          content: systemPrompt,
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
