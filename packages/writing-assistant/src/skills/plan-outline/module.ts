import { resolve } from 'node:path';
import { defineProductSkillModule } from '@wa/runtime';

export default defineProductSkillModule({
  id: 'plan-outline',
  skillPath: resolve(__dirname, 'skill.md'),
  promptPaths: [
    resolve(__dirname, 'prompts/outline-planner.system.md'),
    resolve(__dirname, 'prompts/outline-reviser.system.md'),
    resolve(__dirname, 'prompts/outline-item-reviser.system.md'),
  ],
  tools: ['plan_outline', 'revise_outline', 'revise_outline_item'],
  actions: {
    plan_outline: { toolName: 'plan_outline' },
    confirm_outline_for_writing: {},
    request_human_gate: { requiresHumanGate: true },
  },
});
