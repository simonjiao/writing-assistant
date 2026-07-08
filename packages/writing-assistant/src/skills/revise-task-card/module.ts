import { resolve } from 'node:path';
import { defineProductSkillModule } from '@wa/runtime';

export default defineProductSkillModule({
  id: 'revise-task-card',
  skillPath: resolve(__dirname, 'skill.md'),
  promptPaths: [resolve(__dirname, 'prompts/task-card-reviser.system.md')],
  tools: ['revise_task_card'],
  actions: {},
});
