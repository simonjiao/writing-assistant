import { resolve } from 'node:path';
import { defineProductSkillModule } from '@wa/runtime';

export default defineProductSkillModule({
  id: 'dialogue-route',
  skillPath: resolve(__dirname, 'skill.md'),
  tools: ['route_dialogue'],
  actions: {},
});
