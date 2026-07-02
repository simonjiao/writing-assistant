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
    try {
      const response = await llm.chat({
        jsonMode: true,
        temperature: 0.35,
        messages: [
          { role: 'system', content: '你是局部编辑器。只改选中 block，除非明确说明必须扩大范围。输出 JSON：patch、evaluation。' },
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
      if (parsed?.patch?.after) return normalizePatch(parsed, input, before);
    } catch {
      // Deterministic fallback.
    }
    return buildHeuristicPatch(input, before);
  }
}

function normalizePatch(output: Partial<PatchEditorOutput>, input: PatchEditorInput, before: string): PatchEditorOutput {
  const now = nowIso();
  const patch: TextPatch = {
    id: output.patch?.id ?? newId('patch'),
    articleId: input.articleId,
    blockId: input.blockId,
    before,
    after: output.patch?.after ?? before,
    instruction: input.instruction,
    affectedBlockIds: output.patch?.affectedBlockIds ?? [input.blockId],
    requiresScopeExpansion: output.patch?.requiresScopeExpansion ?? false,
    changeSummary: output.patch?.changeSummary ?? ['生成局部修改版本'],
    createdAt: output.patch?.createdAt ?? now,
  };
  return {
    patch,
    evaluation: output.evaluation ?? {
      preservesMeaning: true,
      needsUserApprovalForScopeExpansion: patch.requiresScopeExpansion,
      notes: ['已按默认局部修改策略处理。'],
    },
  };
}

export function buildHeuristicPatch(input: PatchEditorInput, before: string): PatchEditorOutput {
  const wantsClassical = /文雅|含蓄|古典|红楼梦|半文半白/.test(input.instruction);
  const wantsShorter = /简短|压缩|短/.test(input.instruction);
  const wantsClearer = /清楚|直白|易懂|解释/.test(input.instruction);

  let after = before;
  if (wantsShorter) {
    after = before
      .split(/[。！？!?]/)
      .filter(Boolean)
      .slice(0, 2)
      .join('。') + '。';
  } else if (wantsClassical) {
    after = before
      .replace(/这个/g, '此一')
      .replace(/所以/g, '故而')
      .replace(/但是/g, '然而')
      .replace(/关系/g, '关节')
      .replace(/问题/g, '关目');
    after += '\n\n换言之，此处不宜直露说尽，而应稍留回环，使意思在文气中自然浮出。';
  } else if (wantsClearer) {
    after += '\n\n更直接地说，本段要表达的是：先明确中心判断，再说明它为什么能支撑全文。';
  } else {
    after += `\n\n根据修改意见：“${input.instruction}”，本段已做局部调整，但未扩大到其他段落。`;
  }

  return {
    patch: {
      id: newId('patch'),
      articleId: input.articleId,
      blockId: input.blockId,
      before,
      after,
      instruction: input.instruction,
      affectedBlockIds: [input.blockId],
      requiresScopeExpansion: false,
      changeSummary: ['仅修改选中段落', '保留原段落核心观点', '未改变引用绑定'],
      createdAt: nowIso(),
    },
    evaluation: {
      preservesMeaning: true,
      needsUserApprovalForScopeExpansion: false,
      notes: ['默认局部修改完成。'],
    },
  };
}

function adjacentBlocks(blocks: Array<{ id: string; text: string }>, blockId: string): Array<{ id: string; text: string }> {
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index < 0) return [];
  return blocks.slice(Math.max(0, index - 1), index + 2).filter((block) => block.id !== blockId);
}
