import { resolve } from 'node:path';
import { defineProductSkillModule } from '@wa/runtime';

export default defineProductSkillModule({
  id: 'evaluate-quality',
  skillPath: resolve(__dirname, 'skill.md'),
  tools: ['evaluate_quality'],
  actions: {
    review_task_card_outline_consistency: { toolName: 'evaluate_quality' },
    generate_polish_report: { toolName: 'evaluate_quality' },
  },
});
