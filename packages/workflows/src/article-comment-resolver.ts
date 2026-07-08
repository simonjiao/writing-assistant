import { ArticleBlock, ArticleComment, safeJsonParse, WritingTaskCard } from '@wa/core';
import { PromptProgram } from './prompt-program';

export type ArticleCommentResolutionAction = 'revise' | 'explain' | 'ask';

export interface ArticleCommentResolverInput {
  articleId: string;
  comment: ArticleComment;
  block: ArticleBlock;
  taskCard?: WritingTaskCard;
  adjacentBlocks?: Array<Pick<ArticleBlock, 'id' | 'title' | 'text'>>;
}

export interface ArticleCommentResolverOutput {
  action: ArticleCommentResolutionAction;
  response: string;
  replacementText?: string;
}

export class ArticleCommentResolverProgram implements PromptProgram<ArticleCommentResolverInput, ArticleCommentResolverOutput> {
  manifest = {
    id: 'article-comment-resolver',
    name: 'Article Comment Resolver',
    version: '0.1.0',
    description: '根据正文选区批注决定修订、解释或追问。',
    policies: {
      selectedTextOnly: true,
      preserveSourcePolicy: true,
      batchFriendly: true,
    },
  };

  async invoke({ input, llm }: Parameters<PromptProgram<ArticleCommentResolverInput, ArticleCommentResolverOutput>['invoke']>[0]): Promise<ArticleCommentResolverOutput> {
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0.18,
      maxTokens: 1800,
      messages: buildMessages(input),
    });
    let parsed = safeJsonParse<Partial<ArticleCommentResolverOutput>>(response.content);
    if (!parsed) {
      const retry = await llm.chat({
        jsonMode: true,
        temperature: 0,
        maxTokens: 1800,
        messages: buildRetryMessages(input, response.content),
      });
      parsed = safeJsonParse<Partial<ArticleCommentResolverOutput>>(retry.content);
      if (!parsed) throw new Error(retry.content.trim() ? `Article comment resolver did not return valid JSON: ${retry.content.slice(0, 300)}` : 'Article comment resolver returned empty response.');
    }
    return normalizeOutput(parsed);
  }
}

function buildMessages(input: ArticleCommentResolverInput) {
  return [
    {
      role: 'system' as const,
      content: [
        '你是正文批注处理器，只处理用户在已生成正文中选中的一小段文字。',
        '你必须在 revise、explain、ask 三种动作中选择一种。',
        'revise：批注意图是指出事实、来源、语言、重复、连贯性或风格问题，且可以只替换 selectedText 来解决。',
        'explain：用户只是要求解释、说明原因，或批注不是修改要求。',
        'ask：批注意图不清、需要用户提供取舍，或仅替换 selectedText 会破坏上下文。',
        'response 必须是一句简短中文说明，不能为空。',
        '若存在 latestUserReply，它就是当前最新指令，优先级高于旧的 assistant 说明。',
        '若原批注或 latestUserReply 已经给出评价方向、事实纠正、措辞方向或允许评论，不要继续追问，优先 revise。',
        '若任务卡来源策略禁止后40回、程高本续书或未授权材料，任何疑似使用这些材料的批注都应优先 revise，移除或改写为前80回和脂批可支撑的表达。',
        'revise 时只能给出 replacementText，用来替换 selectedText；不要返回整段，不要改未选中的上下文。',
        'replacementText 必须是可直接放回正文的中文正文片段，不要包含内部标记、JSON 说明或 Markdown。',
        '只输出 JSON object：action、response、replacementText。',
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: JSON.stringify(buildPayload(input)),
    },
  ];
}

function buildRetryMessages(input: ArticleCommentResolverInput, invalidResponse: string) {
  return [
    {
      role: 'system' as const,
      content: [
        '上一次输出不是合法 JSON。现在必须只输出一个 JSON object，不要解释，不要 Markdown。',
        '字段必须为 action、response、replacementText。',
        'action 只能是 revise、explain、ask。',
        'response 必须是一句简短中文说明，不能为空。',
        '如果不确定能否只替换 selectedText，返回 action=ask。',
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: JSON.stringify({ ...buildPayload(input), invalidResponse: invalidResponse.slice(0, 300) }),
    },
  ];
}

function buildPayload(input: ArticleCommentResolverInput) {
  const userReplies = (input.comment.replies ?? []).filter((reply) => reply.role === 'user').map((reply) => reply.content.trim()).filter(Boolean);
  return {
    articleId: input.articleId,
    userComment: input.comment.comment,
    userReplies: userReplies.slice(-4),
    latestUserReply: userReplies.at(-1),
    selectedText: input.comment.selectedText,
    currentBlock: {
      id: input.block.id,
      title: input.block.title,
      text: blockContextAroundSelection(input.block.text, input.comment, 1600),
      sourceRefs: input.block.sourceRefs,
      themeTags: input.block.themeTags,
    },
    adjacentBlocks: (input.adjacentBlocks ?? []).map((block) => ({ ...block, text: block.text.slice(0, 400) })),
    taskCard: input.taskCard ? {
      topic: input.taskCard.topic,
      writingGoal: input.taskCard.writingGoal,
      mustAvoid: input.taskCard.constraints.mustAvoid,
      sourcePolicy: input.taskCard.constraints.sourcePolicy,
      citationRequired: input.taskCard.constraints.citationRequired,
    } : undefined,
    requiredOutputShape: {
      action: 'revise | explain | ask',
      response: 'string; 面向用户的简短处理说明',
      replacementText: 'string; action=revise 时必填；仅替换 selectedText 的正文片段',
    },
  };
}

function blockContextAroundSelection(text: string, comment: ArticleComment, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const selected = comment.selectedText;
  const index = text.indexOf(selected);
  if (index < 0) return text.slice(0, maxLength);
  const room = Math.max(0, maxLength - selected.length);
  const start = Math.max(0, index - Math.floor(room / 2));
  return text.slice(start, start + maxLength);
}

function normalizeOutput(output: Partial<ArticleCommentResolverOutput>): ArticleCommentResolverOutput {
  const action = normalizeAction(output.action);
  const response = optionalText(output.response) ?? defaultResponse(action);
  if (action === 'revise') {
    return { action, response, replacementText: requireText(output.replacementText, 'replacementText') };
  }
  return { action, response, replacementText: typeof output.replacementText === 'string' ? output.replacementText.trim() : undefined };
}

function normalizeAction(value: unknown): ArticleCommentResolutionAction {
  if (value === 'revise' || value === 'explain' || value === 'ask') return value;
  throw new Error(`Article comment resolver returned invalid action: ${String(value)}`);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Article comment resolver returned empty ${field}.`);
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function defaultResponse(action: ArticleCommentResolutionAction): string {
  if (action === 'revise') return '已按批注修订选中文本。';
  if (action === 'explain') return '这条批注更适合作为说明，暂不修改正文。';
  return '这条批注需要进一步确认后再修改正文。';
}
