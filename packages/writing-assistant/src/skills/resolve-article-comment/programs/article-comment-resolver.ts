import { resolve } from 'node:path';
import { ArticleBlock, ArticleComment, safeJsonParse, WritingTaskCard } from '@wa/core';
import { loadPromptTemplate, PromptProgram } from '@wa/runtime';

const systemPrompt = loadPromptTemplate(resolve(__dirname, '../prompts/article-comment-resolver.system.md'));
const retrySystemPrompt = loadPromptTemplate(resolve(__dirname, '../prompts/article-comment-resolver.retry.system.md'));

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
      content: systemPrompt,
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
      content: retrySystemPrompt,
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
