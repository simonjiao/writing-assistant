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
    try {
      const response = await llm.chat({
        jsonMode: true,
        temperature: 0.45,
        messages: [
          { role: 'system', content: '你是写作助手的章节写作者。输出 JSON：block、candidateSources、summary。' },
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
      if (parsed?.block?.text) return normalizeOutput(parsed, input);
    } catch {
      // Fall back to deterministic text.
    }
    return buildHeuristicSection(input, context.knowledge.map((item) => item.sourceRef));
  }
}

function normalizeOutput(output: Partial<SectionWriterOutput>, input: SectionWriterInput): SectionWriterOutput {
  const now = nowIso();
  const block: ArticleBlock = {
    id: output.block?.id ?? newId('blk'),
    type: 'section',
    sectionId: input.section.id,
    title: output.block?.title ?? input.section.title,
    text: output.block?.text ?? '',
    sourceRefs: output.block?.sourceRefs ?? output.candidateSources ?? [],
    themeTags: output.block?.themeTags ?? input.section.themeTags,
    status: 'draft',
    createdAt: output.block?.createdAt ?? now,
    updatedAt: now,
  };
  return {
    block,
    candidateSources: output.candidateSources ?? block.sourceRefs,
    summary: output.summary ?? `已生成章节：${input.section.title}`,
  };
}

export function buildHeuristicSection(input: SectionWriterInput, sourceRefs: string[] = []): SectionWriterOutput {
  const now = nowIso();
  const styleHint = input.taskCard.style.classicalFlavor
    ? '行文宜略带含蓄与文气，但仍保持现代读者可以顺畅理解。'
    : '行文宜清楚、稳健、直入问题。';
  const citationHint = input.taskCard.constraints.citationRequired
    ? '本节涉及判断时，应在后续版本补充精确引用与出处。'
    : '本节先形成论证骨架，后续可按需要补充材料。';
  const text = [
    `### ${input.section.title}`,
    '',
    `${input.section.goal} 这一节的重点，不在于把材料堆满，而在于先把问题的方向立住：${input.taskCard.writingGoal}`,
    '',
    `从写作任务看，本文需要服务于“${input.taskCard.topic}”这个中心。${styleHint} 因此，本节会先交代核心关系，再把读者引向后文的分析层次。`,
    '',
    `${citationHint} 当前可用主题包括：${input.section.themeTags.join('、') || '主题分析'}。`,
  ].join('\n');

  const block: ArticleBlock = {
    id: newId('blk'),
    type: 'section',
    sectionId: input.section.id,
    title: input.section.title,
    text,
    sourceRefs,
    themeTags: input.section.themeTags,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  return {
    block,
    candidateSources: sourceRefs,
    summary: `已生成章节：${input.section.title}`,
  };
}
