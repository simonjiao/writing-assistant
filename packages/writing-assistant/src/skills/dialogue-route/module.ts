import { resolve } from 'node:path';
import { defineProductSkillModule } from '@wa/runtime';

export default defineProductSkillModule({
  id: 'dialogue-route',
  skillPath: resolve(__dirname, 'skill.md'),
  promptPaths: [resolve(__dirname, 'prompts/dialogue-router.system.md')],
  tools: ['route_dialogue'],
  actions: {},
});
