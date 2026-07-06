import { describe, expect, it } from 'vitest';
import { ArticleBlock, ArticleComment, WritingTaskCard } from '@wa/core';
import { ArticleCommentResolverSkill } from './article-comment-resolver';

const now = new Date().toISOString();

const taskCard: WritingTaskCard = {
  id: 'task-comment',
  topic: '司棋人物文章',
  writingGoal: '分析司棋的性格张力。',
  audience: '普通中文读者',
  scope: { characters: ['司棋'], themes: ['人物性格'] },
  structure: { articleType: 'analysis', expectedLength: '1200字' },
  style: { register: '自然中文', tone: '稳健', classicalFlavor: false },
  constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '以前80回和脂批为依据。' },
  interactionMode: { askBeforeWriting: true, localEditFirst: true },
  status: 'confirmed',
  createdAt: now,
  updatedAt: now,
};

const block: ArticleBlock = {
  id: 'blk-comment',
  type: 'paragraph',
  sectionId: 'sec-comment',
  title: '正文段落',
  text: '被人撞破时，司棋“唬得浑身乱战”，拉着潘又安跪下哀求。',
  sourceRefs: [],
  themeTags: ['司棋'],
  status: 'draft',
  createdAt: now,
  updatedAt: now,
};

const comment: ArticleComment = {
  id: 'cmt-comment',
  articleId: 'art-comment',
  blockId: block.id,
  selectedText: '司棋“唬得浑身乱战”，拉着潘又安跪下哀求',
  comment: '被人撞破，潘又安像个女人，司棋更像个男人',
  status: 'open',
  createdAt: now,
  updatedAt: now,
};

function sequentialLlm(contents: string[]) {
  let index = 0;
  return {
    async chat(request: { messages: Array<{ role: string; content: string }> }) {
      const content = contents[Math.min(index, contents.length - 1)];
      index += 1;
      return { content, raw: { request } };
    },
    async json<T>() { return {} as T; },
  };
}

describe('ArticleCommentResolverSkill', () => {
  it('retries once when the model returns empty content instead of JSON', async () => {
    const skill = new ArticleCommentResolverSkill();
    const output = await skill.invoke({
      input: { articleId: 'art-comment', comment, block, taskCard },
      context: {} as never,
      llm: sequentialLlm([
        '',
        JSON.stringify({
          action: 'revise',
          response: '已按批注意图弱化司棋哀求感，并突出潘又安的怯弱。',
          replacementText: '潘又安先自怯失措，司棋虽一时惊乱，却反显出比他更敢担承的刚性',
        }),
      ]),
    });
    expect(output.action).toBe('revise');
    expect(output.replacementText).toContain('更敢担承');
  });

  it('reports a clear empty-response error after retry also returns empty', async () => {
    const skill = new ArticleCommentResolverSkill();
    await expect(skill.invoke({
      input: { articleId: 'art-comment', comment, block, taskCard },
      context: {} as never,
      llm: sequentialLlm(['', '']),
    })).rejects.toThrow('empty response');
  });

  it('uses a default response when a valid revise payload omits response text', async () => {
    const skill = new ArticleCommentResolverSkill();
    const output = await skill.invoke({
      input: { articleId: 'art-comment', comment, block, taskCard },
      context: {} as never,
      llm: sequentialLlm([
        JSON.stringify({
          action: 'revise',
          response: '',
          replacementText: '潘又安先自怯失措，司棋虽一时惊乱，却反显出比他更敢担承的刚性',
        }),
      ]),
    });
    expect(output.response).toBe('已按批注修订选中文本。');
    expect(output.replacementText).toContain('更敢担承');
  });

  it('prioritizes user replies over old assistant messages in the resolver payload', async () => {
    const skill = new ArticleCommentResolverSkill();
    let payload: Record<string, unknown> | undefined;
    const output = await skill.invoke({
      input: {
        articleId: 'art-comment',
        comment: {
          ...comment,
          replies: [
            { id: 'crp-old', role: 'assistant', content: '这条批注没有处理成功，需要人工确认：Article comment resolver returned empty response.', createdAt: now },
            { id: 'crp-user', role: 'user', content: '可以评论二人的表现', createdAt: now },
          ],
        },
        block,
        taskCard,
      },
      context: {} as never,
      llm: {
        async chat(request: { messages: Array<{ role: string; content: string }> }) {
          payload = JSON.parse(request.messages[1].content);
          return {
            content: JSON.stringify({
              action: 'revise',
              response: '已按用户补充评论二人的表现差异。',
              replacementText: '潘又安先自怯失措，司棋虽一时惊乱，却反显出比他更敢担承的刚性',
            }),
            raw: { request },
          };
        },
        async json<T>() { return {} as T; },
      },
    });
    expect(output.action).toBe('revise');
    expect(payload?.latestUserReply).toBe('可以评论二人的表现');
    expect(payload?.userReplies).toEqual(['可以评论二人的表现']);
    expect(JSON.stringify(payload)).not.toContain('没有处理成功');
  });
});
