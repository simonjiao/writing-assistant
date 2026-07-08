import { resolve } from 'node:path';
import { defineProductSkillModule } from '@wa/runtime';

export default defineProductSkillModule({
  id: 'create-task-card',
  skillPath: resolve(__dirname, 'skill.md'),
  promptPaths: [resolve(__dirname, 'prompts/task-card-builder.system.md')],
  tools: ['create_task_intake', 'refine_task_card'],
  actions: {
    create_task_intake: { toolName: 'create_task_intake' },
    refine_task_card: { toolName: 'refine_task_card' },
    ask_followup: { requiresHumanGate: true },
  },
});
