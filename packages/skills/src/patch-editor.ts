import { newId, nowIso, safeJsonParse, Skill, TextPatch } from '@wa/core';

export interface PatchEditorInput {
  articleId: string;
  blockId: string;
  instruction: string;
}

export interface PatchEditorOutput {
  patch: TextPatch;
  evaluation: {
    preservesMeaning: boolean;
    needsUserApprovalForScopeExpansion: boolean;
    notes: string[];
  };
}

export class PatchEditorSkill implements Skill<PatchEditorInput, PatchEditorOutput> {
  manifest = {
    id: 'patch-editor',
    name: 'Patch Editor',
    version: '0.1.0',
    description: '对用户选中的段落生成局部修改 patch。',
    policies: {
      defaultScope: 'selected-block',
      expandOnlyWithReason: true,
      preserveCitations: true,
    },
  };

  async invoke({ input, context, llm }: Parameters<Skill<PatchEditorInput, PatchEditorOutput>['invoke']>[0]): Promise<PatchEditorOutput> {
    if (!context.selectedBlock) {
      throw new Error(`Selected block not found: ${input.blockId}`);
    }
    const before = context.selectedBlock.text;
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0.35,
      messages: [
        { role: 'system', content: '你是局部编辑器。只改选中 block，除非明确说明必须扩大范围。只输出 JSON：patch、evaluation。patch.after 必须是修改后的完整选中段落，patch.changeSummary 必须说明修改点，evaluation 必须包含 preservesMeaning、needsUserApprovalForScopeExpansion、notes。' },
        {
          role: 'user',
          content: JSON.stringify({
            instruction: input.instruction,
            selectedBlock: context.selectedBlock,
            articleTaskCard: context.article?.taskCard,
            localEditFirst: true,
            adjacentBlocks: adjacentBlocks(context.article?.blocks ?? [], input.blockId),
          }),
        },
      ],
    });
    const parsed = safeJsonParse<Partial<PatchEditorOutput>>(response.content);
    if (!parsed?.patch?.after) throw new Error(`Patch editor did not return a valid patch: ${response.content.slice(0, 300)}`);
    return normalizePatch(parsed, input, before);
  }
}

function normalizePatch(output: Partial<PatchEditorOutput>, input: PatchEditorInput, before: string): PatchEditorOutput {
  const now = nowIso();
  const patch: TextPatch = {
    id: output.patch?.id ?? newId('patch'),
    articleId: input.articleId,
    blockId: input.blockId,
    before,
    after: requireText(output.patch?.after, 'patch.after'),
    instruction: input.instruction,
    affectedBlockIds: output.patch?.affectedBlockIds ?? [input.blockId],
    requiresScopeExpansion: requireBoolean(output.patch?.requiresScopeExpansion, 'patch.requiresScopeExpansion'),
    changeSummary: requireStringArray(output.patch?.changeSummary, 'patch.changeSummary'),
    createdAt: output.patch?.createdAt ?? now,
  };
  return {
    patch,
    evaluation: requireEvaluation(output.evaluation),
  };
}

function adjacentBlocks(blocks: Array<{ id: string; text: string }>, blockId: string): Array<{ id: string; text: string }> {
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index < 0) return [];
  return blocks.slice(Math.max(0, index - 1), index + 2).filter((block) => block.id !== blockId);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Patch editor returned empty ${field}.`);
  return value.trim();
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Patch editor returned invalid ${field}.`);
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Patch editor returned invalid ${field}.`);
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

function requireEvaluation(value: unknown): PatchEditorOutput['evaluation'] {
  if (!value || typeof value !== 'object') throw new Error('Patch editor returned invalid evaluation.');
  const evaluation = value as Partial<PatchEditorOutput['evaluation']>;
  return {
    preservesMeaning: requireBoolean(evaluation.preservesMeaning, 'evaluation.preservesMeaning'),
    needsUserApprovalForScopeExpansion: requireBoolean(evaluation.needsUserApprovalForScopeExpansion, 'evaluation.needsUserApprovalForScopeExpansion'),
    notes: requireStringArray(evaluation.notes, 'evaluation.notes'),
  };
}
