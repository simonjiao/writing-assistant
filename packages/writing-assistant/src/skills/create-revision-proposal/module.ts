import { resolve } from 'node:path';
import { defineProductSkillModule } from '@wa/runtime';

export default defineProductSkillModule({
  id: 'create-revision-proposal',
  skillPath: resolve(__dirname, 'skill.md'),
  tools: ['create_revision_proposal'],
  actions: {
    create_revision_proposal: { toolName: 'create_revision_proposal' },
  },
});
