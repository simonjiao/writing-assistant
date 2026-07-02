import { ArticleBlock, newId, nowIso, OutlineItem, safeJsonParse, Skill, WritingTaskCard } from '@wa/core';

export interface SectionWriterInput {
  articleId: string;
  section: OutlineItem;
  taskCard: WritingTaskCard;
}

export interface SectionWriterOutput {
  block: ArticleBlock;
  candidateSources: string[];
  summary: string;
}

export class SectionWriterSkill implements Skill<SectionWriterInput, SectionWriterOutput> {
  manifest = {
    id: 'section-writer',
    name: 'Section Writer',
    version: '0.1.0',
    description: '根据任务卡和大纲节点生成章节正文。',
    policies: {
      doNotOverwriteExistingBlocks: true,
      bindSourcesWhenAvailable: true,
    },
  };

  async invoke({ input, context, llm }: Parameters<Skill<SectionWriterInput, SectionWriterOutput>['invoke']>[0]): Promise<SectionWriterOutput> {
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0.45,
      messages: [
        { role: 'system', content: '你是写作助手的章节写作者。只输出 JSON：block、candidateSources、summary。block.text 必须是完整正文，不能留空。' },
        {
          role: 'user',
          content: JSON.stringify({
            taskCard: input.taskCard,
            section: input.section,
            contextSummary: context.compactSummary,
            knowledge: context.knowledge,
            existingOutline: context.article?.outline,
            existingBlocks: context.article?.blocks.map((block) => ({ id: block.id, title: block.title, text: block.text.slice(0, 300) })),
          }),
        },
      ],
    });
    const parsed = safeJsonParse<Partial<SectionWriterOutput>>(response.content);
    if (!parsed?.block?.text) throw new Error(`Section writer did not return a valid block: ${response.content.slice(0, 300)}`);
    return normalizeOutput(parsed, input);
  }
}

function normalizeOutput(output: Partial<SectionWriterOutput>, input: SectionWriterInput): SectionWriterOutput {
  const now = nowIso();
  const candidateSources = requireStringArray(output.candidateSources, 'candidateSources');
  const block: ArticleBlock = {
    id: output.block?.id ?? newId('blk'),
    type: 'section',
    sectionId: input.section.id,
    title: output.block?.title ?? input.section.title,
    text: requireText(output.block?.text, 'block.text'),
    sourceRefs: Array.isArray(output.block?.sourceRefs) ? requireStringArray(output.block.sourceRefs, 'block.sourceRefs') : candidateSources,
    themeTags: output.block?.themeTags ?? input.section.themeTags,
    status: 'draft',
    createdAt: output.block?.createdAt ?? now,
    updatedAt: now,
  };
  return {
    block,
    candidateSources,
    summary: requireText(output.summary, 'summary'),
  };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Section writer returned empty ${field}.`);
  return value.trim();
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Section writer returned invalid ${field}.`);
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}
