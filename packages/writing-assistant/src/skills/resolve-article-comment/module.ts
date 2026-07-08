import { resolve } from 'node:path';
import { defineProductSkillModule } from '@wa/runtime';

export default defineProductSkillModule({
  id: 'resolve-article-comment',
  skillPath: resolve(__dirname, 'skill.md'),
  tools: ['resolve_article_comment'],
  actions: {
    process_article_comments: { toolName: 'resolve_article_comment' },
  },
});
