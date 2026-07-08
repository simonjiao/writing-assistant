import { resolve } from 'node:path';
import { defineProductSkillModule } from '@wa/runtime';

export default defineProductSkillModule({
  id: 'plan-outline',
  skillPath: resolve(__dirname, 'skill.md'),
  tools: ['plan_outline', 'revise_outline', 'revise_outline_item'],
  actions: {
    plan_outline: { toolName: 'plan_outline' },
    confirm_outline_for_writing: {},
    request_human_gate: { requiresHumanGate: true },
  },
});
